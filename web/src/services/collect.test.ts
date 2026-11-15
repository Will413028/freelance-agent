import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy, parseListingInput } from "@/modules/listings/public";
import { SOURCES, SourceError, type Collected, type SourceSettings } from "@/modules/sources/public";
import type { Fetcher } from "@/platform/fetch";
import { collectSource } from "./collect";
import { freshPg } from "../../tests/helpers/pg";

// Plan step 4, D9: one source into intake, every listing stored and marked (the store cases of the old test_free_jobs.py).

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const NOW = new Date("2026-09-20T00:00:00Z");
const rem = (changes: Record<string, unknown> = {}) => ({
  id: 1, url: "https://remotive.com/remote-jobs/software-dev/backend-1", title: "Backend API engineer",
  description: "<p>Build an API</p>", job_type: "part_time", publication_date: "2026-09-18T12:00:00",
  candidate_required_location: "Worldwide", ...changes,
});
const serving = (jobs: unknown[]): Fetcher => ({ requests: 1, get: async () => ({ status: 200, tier: "plain", body: new TextEncoder().encode(JSON.stringify({ jobs })) }) });
const remotive = SOURCES.find((s) => s.name === "remotive")!;

describe("collectSource", () => {
  it("writes every listing read, marked by the source's rule, and counts as jobs the kept ones screening allows (plan D9)", async () => {
    const jobs = [rem(), rem({ id: 2, job_type: "full_time" }), rem({ id: 3, title: "Accountant", description: "Bookkeeping" }), rem({ id: 4, candidate_required_location: "USA" })];
    const run = await collectSource(db, "remotive", NOW, serving(jobs));
    expect([run.seen, run.stored, run.jobs, run.externalIds, run.intake.inserted]).toEqual([4, 4, 1, ["1", "2", "3", "4"], 4]);
    expect((await listingBy(db, "remotive", "1"))?.publishedAt?.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    const rows = await Promise.all(["1", "2", "3", "4"].map((id) => listingBy(db, "remotive", id)));
    expect(rows.map((r) => [r?.sourceKept, r?.hardExcluded])).toEqual([[true, false], [false, true], [true, true], [true, true]]);
  });

  it("writes the others when one listing lacks its identity, and reports it rejected (Will 2026-11-15)", async () => {
    const got = await collectSource(db, "remotive", NOW, serving([rem(), rem({ id: 2, description: null })]));
    expect([got.externalIds, got.seen, got.rejected]).toEqual([["1"], 2, 1]);
    expect(await listingBy(db, "remotive", "2")).toBeNull();
  });

  it("writes nothing when more than half of the feed's listings lack their identity", async () => {
    await expect(collectSource(db, "remotive", NOW, serving([rem(), rem({ id: 2, description: null }), rem({ id: 3, title: "" })]))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "remotive", "1")).toBeNull();
  });

  it("a second run of the same feed changes nothing", async () => {
    await collectSource(db, "remotive", NOW, serving([rem()]));
    expect((await collectSource(db, "remotive", NOW, serving([rem()]))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
  });

  it("refuses a disabled source", async () => {
    const off: SourceSettings = { ...remotive, disabled: "blocked" };
    await expect(collectSource(db, off, NOW, serving([rem()]))).rejects.toThrow(/disabled/);
  });
});

describe("collectSource with a scripted connector", () => {
  const listing = (id: string, kind: "contract" | "full_time", title = "Backend API engineer") =>
    ({ external_id: id, title, description: title === "Accountant" ? "Bookkeeping" : "Build an API", url: `https://example.com/${id}`, canonical_url: `https://example.com/${id}`, location: null,
      kind, taiwan_eligible: null, complete: false, published_at: null, extra: {} });
  const all = () => true;
  const contractOnly = (l: { kind: string | null }) => l.kind === "contract";
  const source = (got: () => Omit<Collected, "sourceKept"> & Partial<Pick<Collected, "sourceKept">>, completeRead = false): SourceSettings =>
    ({ name: "remotive", order: 0, connector: async () => ({ sourceKept: all, ...got() }), maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1, completeRead, disabled: null });
  const none: Fetcher = { requests: 0, get: async () => { throw new Error("no request"); } };

  it("stores what the rule drops as not kept and follows a stored listing whose content changes either way", async () => {
    await collectSource(db, source(() => ({ seen: 1, listings: [parseListingInput(listing("a", "contract"))] })), NOW, none);
    const run = await collectSource(db, source(() => ({
      seen: 3, sourceKept: contractOnly,
      listings: [parseListingInput(listing("c", "contract")), parseListingInput(listing("d", "contract", "Accountant")), parseListingInput(listing("a", "full_time")), parseListingInput(listing("b", "full_time"))],
    })), NOW, none);
    expect([run.stored, run.jobs, run.externalIds, run.intake]).toEqual([4, 1, ["c", "d", "a", "b"], { inserted: 3, updated: 1, unchanged: 0, versioned: 0 }]);
    const rows = await Promise.all(["a", "b", "c", "d"].map((id) => listingBy(db, "remotive", id)));
    expect(rows.map((r) => [r?.kind, r?.sourceKept])).toEqual([["full_time", false], ["full_time", false], ["contract", true], ["contract", true]]);
  });

  it("a rule that refuses (SourceError) fails the run with nothing written", async () => {
    const refuse = () => { throw new SourceError("remotive: category is not text"); };
    await expect(collectSource(db, source(() => ({ seen: 1, sourceKept: refuse, listings: [parseListingInput(listing("a", "contract"))] })), NOW, none)).rejects.toThrow(/category/);
    expect(await listingBy(db, "remotive", "a")).toBeNull();
  });

  it("marks gone only after a complete, untruncated read of a source the catalog marks complete", async () => {
    const t1 = new Date(NOW.getTime() + 86_400_000);
    const read = (ids: string[], truncated = false) => () => ({ seen: ids.length, truncated, listings: ids.map((id) => parseListingInput(listing(id, "contract"))) });
    await collectSource(db, source(read(["a", "b"]), true), NOW, none);
    await collectSource(db, source(read(["a"], true), true), t1, none);
    await collectSource(db, source(read(["a"])), t1, none);
    expect((await listingBy(db, "remotive", "b"))?.goneAt).toBeNull();
    // A partial read (one listing set aside) is not complete either.
    await collectSource(db, source(() => ({ ...read(["a"])(), rejected: 1, examined: 2 }), true), t1, none);
    expect((await listingBy(db, "remotive", "b"))?.goneAt).toBeNull();
    await collectSource(db, source(read(["a"]), true), t1, none);
    expect((await listingBy(db, "remotive", "b"))?.goneAt).toEqual(t1);
  });

  it("reports a truncated read", async () => {
    expect((await collectSource(db, source(() => ({ seen: 0, listings: [], truncated: true })), NOW, none)).truncated).toBe(true);
    expect((await collectSource(db, source(() => ({ seen: 0, listings: [] })), NOW, none)).truncated).toBe(false);
  });

  it("refuses a run whose rejected listings are more than half of the entries examined, writing nothing, whatever seen says", async () => {
    // seen is large (each source's own reporting meaning); the threshold reads examined only.
    const got = () => ({ seen: 100, examined: 3, listings: [parseListingInput(listing("a", "contract"))], rejected: 2 });
    await expect(collectSource(db, source(got), NOW, none)).rejects.toThrow(/remotive: 2 of 3 listings refused/);
    expect(await listingBy(db, "remotive", "a")).toBeNull();
  });

  it("writes the kept listings when exactly half of the entries examined were rejected, whatever seen says", async () => {
    const run = await collectSource(db, source(() => ({ seen: 1, examined: 2, listings: [parseListingInput(listing("a", "contract"))], rejected: 1 })), NOW, none);
    expect([run.externalIds, run.rejected, run.examined]).toEqual([["a"], 1, 2]);
    expect((await collectSource(db, source(() => ({ seen: 1, listings: [parseListingInput(listing("a", "contract"))] })), NOW, none)).rejected).toBe(0);
  });

  it("treats rejected without examined as a connector bug, not a payload refusal", async () => {
    const got = () => ({ seen: 10, listings: [parseListingInput(listing("a", "contract"))], rejected: 1 });
    const e = await collectSource(db, source(got), NOW, none).catch((x: unknown) => x);
    expect([e instanceof SourceError, (e as Error).message]).toEqual([false, "remotive: rejected reported without examined"]);
  });
});
