import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy, parseListingInput } from "@/modules/listings/public";
import { SOURCES, type Collected, type SourceSettings } from "@/modules/sources/public";
import type { Fetcher } from "@/platform/fetch";
import { collectSource } from "./collect";
import { freshPg } from "../../tests/helpers/pg";

// Plan step 4: one source through screening into intake (the store cases of the old test_free_jobs.py).

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
  it("writes only contract listings that screening keeps, and reports seen, jobs and ids", async () => {
    const jobs = [rem(), rem({ id: 2, job_type: "full_time" }), rem({ id: 3, title: "Accountant", description: "Bookkeeping" }), rem({ id: 4, candidate_required_location: "USA" })];
    const run = await collectSource(db, "remotive", NOW, serving(jobs));
    expect([run.seen, run.jobs, run.externalIds, run.intake.inserted]).toEqual([4, 1, ["1"], 1]);
    expect((await listingBy(db, "remotive", "1"))?.publishedAt?.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect(await listingBy(db, "remotive", "3")).toBeNull();
  });

  it("writes nothing when one listing lacks its identity", async () => {
    await expect(collectSource(db, "remotive", NOW, serving([rem(), rem({ id: 2, description: null })]))).rejects.toThrow(/description/);
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

describe("collectSource for a source that refreshes stored listings (old `exists ||`)", () => {
  const listing = (id: string, kind: "contract" | "full_time", title = "Backend API engineer") =>
    ({ external_id: id, title, description: title === "Accountant" ? "Bookkeeping" : "Build an API", url: `https://example.com/${id}`, canonical_url: `https://example.com/${id}`, location: null,
      kind, taiwan_eligible: null, complete: false, published_at: null, extra: {} });
  const source = (got: () => Collected): SourceSettings =>
    ({ name: "remotive", order: 0, connector: async () => got(), maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1, disabled: null });
  const none: Fetcher = { requests: 0, get: async () => { throw new Error("no request"); } };

  it("refreshes a stored listing the rules now drop, never inserts one, and reports both kinds of written ids", async () => {
    await collectSource(db, source(() => ({ seen: 1, listings: [parseListingInput(listing("a", "contract"))] })), NOW, none);
    const run = await collectSource(db, source(() => ({
      seen: 3, listings: [parseListingInput(listing("c", "contract")), parseListingInput(listing("d", "contract", "Accountant"))],
      others: [parseListingInput(listing("a", "full_time")), parseListingInput(listing("b", "full_time"))],
    })), NOW, none);
    expect([run.jobs, run.externalIds, run.intake]).toEqual([2, ["c", "a"], { inserted: 1, updated: 1, unchanged: 0, versioned: 0 }]);
    expect((await listingBy(db, "remotive", "a"))?.kind).toBe("full_time");
    expect(await listingBy(db, "remotive", "b")).toBeNull();
    expect(await listingBy(db, "remotive", "d")).toBeNull();
  });

  it("refreshes a stored listing that screening now excludes", async () => {
    await collectSource(db, source(() => ({ seen: 1, listings: [parseListingInput(listing("a", "contract"))], others: [] })), NOW, none);
    const run = await collectSource(db, source(() => ({ seen: 1, listings: [parseListingInput(listing("a", "contract", "Accountant"))], others: [] })), NOW, none);
    expect([run.externalIds, run.intake.updated]).toEqual([["a"], 1]);
  });

  it("without `others` a dropped stored listing is left as it was", async () => {
    await collectSource(db, source(() => ({ seen: 1, listings: [parseListingInput(listing("a", "contract"))] })), NOW, none);
    const run = await collectSource(db, source(() => ({ seen: 1, listings: [parseListingInput(listing("a", "contract", "Accountant"))] })), NOW, none);
    expect([run.externalIds, run.intake]).toEqual([[], { inserted: 0, updated: 0, unchanged: 0, versioned: 0 }]);
  });

  it("reports a truncated read", async () => {
    expect((await collectSource(db, source(() => ({ seen: 0, listings: [], truncated: true })), NOW, none)).truncated).toBe(true);
    expect((await collectSource(db, source(() => ({ seen: 0, listings: [] })), NOW, none)).truncated).toBe(false);
  });
});
