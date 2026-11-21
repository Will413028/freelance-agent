import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings, listingVersions } from "@/db/pg/schema";
import { FACTS_VERSION } from "@/modules/evaluation/public";
import { intakeListings, listingBy, reevaluateStale } from "@/modules/listings/public";
import { fingerprint } from "./id";
import { freshPg } from "../../../tests/helpers/pg";

// Plan D26: rows evaluated under an older rule version are recomputed from their stored contract.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const job = (id: string, extra: Record<string, unknown> = {}) => ({ external_id: id, title: "Backend API contractor", description: "Build an LLM automation backend", url: `https://example.com/jobs/${id}`, kind: "contract", ...extra });
const NOW = new Date("2026-11-20T02:00:00Z");

describe("reevaluateStale", () => {
  it("writes the current version at intake, so a fresh table has nothing stale", async () => {
    await intakeListings(db, "jobicy", [job("a")], "page", NOW);
    expect((await listingBy(db, "jobicy", "a"))?.evaluatedWith).toBe(FACTS_VERSION.job);
    expect(await reevaluateStale(db)).toEqual({ reevaluated: 0, unparsable: 0 });
  });

  it("recomputes stale listings and versions from raw, and a rerun is a no-op", async () => {
    await intakeListings(db, "jobicy", [job("a")], "page", NOW);
    await intakeListings(db, "linkedin", [job("m")], "mail", NOW);
    await intakeListings(db, "linkedin", [job("m", { description: "Build an LLM automation backend, remote" })], "mail", new Date(NOW.getTime() + 1000));
    // As if written under older rules: wrong facts and an old version.
    const stale = { category: "其他", categoryScore: 0, hardExcluded: true, confirmedBase: 3, evaluatedWith: 0 };
    await db.update(listings).set(stale);
    await db.update(listingVersions).set(stale);
    const counts = await reevaluateStale(db);
    expect(counts).toEqual({ reevaluated: 1 + 1 + 2, unparsable: 0 });
    for (const [source, id] of [["jobicy", "a"], ["linkedin", "m"]] as const) {
      expect(await listingBy(db, source, id)).toMatchObject({ category: "AI 整合／自動化", categoryScore: 85, hardExcluded: false, confirmedBase: 0, evaluatedWith: FACTS_VERSION.job });
    }
    expect((await db.select().from(listingVersions)).every((v) => v.hardExcluded === false && v.evaluatedWith === FACTS_VERSION.job)).toBe(true);
    expect(await reevaluateStale(db)).toEqual({ reevaluated: 0, unparsable: 0 });
  });

  it("leaves a row whose raw no longer parses on its old version and counts it each run", async () => {
    await intakeListings(db, "jobicy", [job("a"), job("b")], "page", NOW);
    await db.update(listings).set({ evaluatedWith: 0 });
    await db.update(listings).set({ raw: { external_id: "b" } }).where(eq(listings.externalId, "b"));
    expect(await reevaluateStale(db)).toEqual({ reevaluated: 1, unparsable: 1 });
    expect((await listingBy(db, "jobicy", "b"))?.evaluatedWith).toBe(0);
    expect(await reevaluateStale(db)).toEqual({ reevaluated: 0, unparsable: 1 });
  });

  it("parses a raw stored before opportunity types (no opportunity_type) as a job, with the same fingerprint", async () => {
    await intakeListings(db, "jobicy", [job("a")], "page", NOW);
    await intakeListings(db, "linkedin", [job("m")], "mail", NOW);
    await intakeListings(db, "linkedin", [job("m", { description: "Build an LLM automation backend, remote" })], "mail", new Date(NOW.getTime() + 1000));
    // As d1edd2c stored them: the contract without the discriminator, under an older version.
    await db.execute(sql`update listings set raw = raw - 'opportunity_type', evaluated_with = 0`);
    await db.execute(sql`update listing_versions set raw = raw - 'opportunity_type', evaluated_with = 0`);
    const [old] = await db.select({ raw: listings.raw, fingerprint: listings.fingerprint }).from(listings).where(eq(listings.externalId, "a"));
    expect(old!.raw).not.toHaveProperty("opportunity_type");
    expect(fingerprint(old!.raw as Record<string, unknown>)).toBe(old!.fingerprint);
    expect(await reevaluateStale(db)).toEqual({ reevaluated: 1 + 1 + 2, unparsable: 0 });
    // The same content read again is unchanged: adding the type moved no fingerprint.
    expect(await intakeListings(db, "jobicy", [job("a")], "page", new Date(NOW.getTime() + 2000))).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it("never touches rows of a type this image does not know (a rollback after a newer image wrote them)", async () => {
    await intakeListings(db, "linkedin", [job("m")], "mail", NOW);
    await intakeListings(db, "linkedin", [job("m", { description: "Build an LLM automation backend, remote" })], "mail", new Date(NOW.getTime() + 1000));
    const unknown = { opportunityType: "contest", evaluatedWith: 0, raw: { opportunity_type: "contest", external_id: "m" } };
    await db.update(listings).set(unknown);
    await db.update(listingVersions).set(unknown);
    // An image whose OPPORTUNITY_TYPES is ["job"]: the one before contests (contest.test.ts has the listing case).
    expect(await reevaluateStale(db, ["job"])).toEqual({ reevaluated: 0, unparsable: 0 });
    expect((await listingBy(db, "linkedin", "m"))?.evaluatedWith).toBe(0);
    expect((await db.select().from(listingVersions)).every((v) => v.evaluatedWith === 0)).toBe(true);
  });
});
