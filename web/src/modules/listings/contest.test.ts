import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings } from "@/db/pg/schema";
import { DEFAULT_SETTINGS, FACTS_VERSION, rankedPage } from "@/modules/evaluation/public";
import { intakeListings, listingBy, parseListingInput, reevaluateStale } from "@/modules/listings/public";
import { freshPg } from "../../../tests/helpers/pg";

// Opportunity types plan step 5: the contest type through the contract, intake, the list and re-evaluation.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const NOW = new Date("2026-11-21T02:00:00Z");
const contest = (id: string, extra: Record<string, unknown> = {}) => ({
  opportunity_type: "contest", external_id: id, title: `Hackathon ${id}`, url: `https://${id}.example.com/`, ...extra,
});
const job = (id: string) => ({ external_id: id, title: "AI agent backend", description: "Build an API", url: `https://example.com/${id}`, kind: "contract" });
const date = (d: string) => ({ kind: "date", date: d });
const CONTESTS = { opportunityType: "contest" } as const;

describe("contest contract", () => {
  it("keeps an unknown prize, eligibility, place and deadline unknown (null), never 0 or false", () => {
    expect(parseListingInput(contest("a"))).toMatchObject({
      opportunity_type: "contest", budget_min: null, budget_max: null, currency: null, prize_text: null, online: null, invite_only: null,
      hackathon: null, deadline: null, registration_deadline: null, listing_closed: null,
    });
  });

  it("refuses a job's fields on a contest and a contest's on a job", () => {
    expect(() => parseListingInput(contest("a", { weekly_hours: 10 }))).toThrow();
    expect(() => parseListingInput({ ...job("a"), prize_text: "$1,000" })).toThrow();
    expect(() => parseListingInput(contest("a", { registration_deadline: "2026-12-01T00:00:00Z" }))).toThrow();
  });
});

describe("contest intake", () => {
  it("stores the contest columns, unknown as null, and leaves the job columns null", async () => {
    await intakeListings(db, "devpost", [contest("known", { budget_max: 5000, currency: "USD", prize_text: "$5,000", online: true, invite_only: false, hackathon: true,
      deadline: date("2026-12-15"), registration_deadline: "2026-12-01" }), contest("unknown")], "page", NOW, CONTESTS);
    expect(await listingBy(db, "devpost", "known")).toMatchObject({
      opportunityType: "contest", budgetMax: 5000, currency: "USD", prizeText: "$5,000", online: true, inviteOnly: false, hackathon: true,
      registrationDeadline: "2026-12-01", deadlineKind: "date", kind: null, weeklyHours: null, evaluatedWith: FACTS_VERSION.contest,
    });
    expect(await listingBy(db, "devpost", "unknown")).toMatchObject({
      budgetMin: null, budgetMax: null, currency: null, prizeText: null, online: null, inviteOnly: null, hackathon: null, registrationDeadline: null,
      deadlineKind: null, deadlineAt: null, hardExcluded: false,
    });
  });

  it("a second read of the same contests inserts no rows", async () => {
    const batch = [contest("a", { deadline: date("2026-12-15") }), contest("b")];
    expect(await intakeListings(db, "devpost", batch, "page", NOW, CONTESTS)).toMatchObject({ inserted: 2 });
    expect(await intakeListings(db, "devpost", batch, "page", new Date(NOW.getTime() + 1000), CONTESTS)).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });

  it("refuses a batch whose listing is of another type than its source's (the fingerprint relies on one type per source)", async () => {
    await expect(intakeListings(db, "devpost", [job("a")], "page", NOW, CONTESTS)).rejects.toThrow(/devpost.*contest/);
    await expect(intakeListings(db, "jobicy", [contest("a")], "page", NOW)).rejects.toThrow(/jobicy.*job/);
    expect(await db.select().from(listings)).toEqual([]);
  });
});

describe("contest list (plan D2: by submission deadline, soonest first, unknown last, no score)", () => {
  const ids = async (view: "candidates" | "all") => {
    const { items } = await rankedPage(db, "contest", DEFAULT_SETTINGS, NOW, view, 0);
    const rows = new Map((await db.select({ id: listings.id, externalId: listings.externalId }).from(listings)).map((r) => [r.id, r.externalId]));
    return items.map((i) => rows.get(i.id));
  };

  it("orders by deadline whatever the read order, keeps an unknown deadline last and an invite-only contest in (D3)", async () => {
    await intakeListings(db, "devpost", [
      contest("none"), contest("late", { deadline: date("2027-01-31") }), contest("soon", { deadline: date("2026-11-25"), invite_only: true }),
      contest("mid", { deadline: date("2026-12-15") }), contest("text", { deadline: { kind: "invalid", text: "soon" } }),
    ], "page", NOW, CONTESTS);
    expect((await ids("candidates")).slice(0, 3)).toEqual(["soon", "mid", "late"]);
    expect(new Set((await ids("candidates")).slice(3))).toEqual(new Set(["none", "text"]));
  });

  it("a contest past its deadline or closed by its source is no candidate; a job never appears, nor a contest among jobs", async () => {
    await intakeListings(db, "devpost", [contest("open", { deadline: date("2026-12-15") }), contest("past", { deadline: date("2026-11-01") }),
      contest("closed", { listing_closed: true })], "page", NOW, CONTESTS);
    await intakeListings(db, "jobicy", [job("j")], "page", NOW);
    expect(await ids("candidates")).toEqual(["open"]);
    // Closed is a hard reason (not shown at all); past its deadline stays in "all".
    expect(await ids("all")).toEqual(["open", "past"]);
    const jobs = await rankedPage(db, "job", DEFAULT_SETTINGS, NOW, "all", 0);
    expect(jobs.items.map((i) => i.id)).toEqual([(await listingBy(db, "jobicy", "j"))!.id]);
  });
});

describe("rollback from the deploy that adds contests", () => {
  it("an image that knows only jobs re-evaluates no contest row and counts none as unparsable", async () => {
    await intakeListings(db, "devpost", [contest("a", { deadline: date("2026-12-15") }), contest("b")], "page", NOW, CONTESTS);
    await intakeListings(db, "jobicy", [job("j")], "page", NOW);
    await db.update(listings).set({ evaluatedWith: 0, hardExcluded: true });
    // The job-only image's loop: its OPPORTUNITY_TYPES is ["job"].
    expect(await reevaluateStale(db, ["job"])).toEqual({ reevaluated: 1, unparsable: 0 });
    for (const id of ["a", "b"]) expect(await listingBy(db, "devpost", id)).toMatchObject({ evaluatedWith: 0, hardExcluded: true });
    // This image then brings them back.
    expect(await reevaluateStale(db)).toEqual({ reevaluated: 2, unparsable: 0 });
    expect(await listingBy(db, "devpost", "a")).toMatchObject({ evaluatedWith: FACTS_VERSION.contest, hardExcluded: false });
  });
});
