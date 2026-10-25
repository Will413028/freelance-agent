import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existingSourceIds, runSource, sourcesIn, syncFreeJobs } from "@/modules/collection/public";
import { PyDict, type PyValue } from "@/platform/py/value";
import { db, pool, resetSchema } from "./helpers/db";

// The two store cases of backend/tests/collection/test_free_jobs.py. runSource marks the source
// failed first, as free_jobs.sync does on its first line.

const rem = (changes: Record<string, PyValue> = {}) => PyDict.of({
  id: 1n, url: "https://remotive.com/remote-jobs/software-dev/backend-1", title: "Backend API engineer",
  description: "<p>Build an API</p>", job_type: "part_time", publication_date: "2026-09-18T12:00:00",
  candidate_required_location: "Worldwide", ...changes,
});
const feed = (jobs: PyValue[]) => async () => PyDict.of({ jobs });

beforeEach(resetSchema);
afterAll(() => pool.end());

describe("free_jobs.sync", () => {
  it("imports only matching non-full-time listings", async () => {
    const reader = feed([rem(), rem({ id: 2n, job_type: "full_time" }), rem({ id: 3n, title: "Accountant", description: "Bookkeeping" })]);
    const result = await syncFreeJobs(db, "remotive", reader);
    expect(result.at("jobs")).toBe(1n);
    expect(result.at("seen")).toBe(3n);
    expect([...(await existingSourceIds(db, "remotive"))]).toEqual(["1"]);
    expect((await sourcesIn(db)).at("remotive")).toBe("ok");
  });

  it("fails a malformed batch instead of reporting an empty success", async () => {
    const status = await runSource(db, "remotive", (d) => syncFreeJobs(d, "remotive", feed([rem(), rem({ id: 2n, description: null })])));
    expect(status.status).toBe("failed");
    expect((await existingSourceIds(db, "remotive")).size).toBe(0);
    expect((await sourcesIn(db)).at("remotive")).toBe("failed");
  });
});
