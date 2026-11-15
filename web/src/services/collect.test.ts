import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { SOURCES, type SourceSettings } from "@/modules/sources/public";
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
const serving = (jobs: unknown[]): Fetcher => ({ requests: 1, get: async () => ({ status: 200, tier: 1, body: new TextEncoder().encode(JSON.stringify({ jobs })) }) });
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
