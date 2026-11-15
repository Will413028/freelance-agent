import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalize, parseFeed, type FreeJobSource } from ".";

// Plan step 4: the golden payloads of both boards (fixtures/cases.json, written by fixtures/generate.ts (deleted in step 5a2 with legacyToInput, D10; see it and its list of deliberate differences at 9a68d6b) from
// legacyToInput of the old output) against the native connector.

type Expected = Record<string, unknown> | { error: true } | { unknown: string } | { listing: true };
type Case = { source: FreeJobSource; payload: unknown; expect: Expected; why?: string };
const cases: Case[] = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

const run = (c: Case) => {
  try {
    return normalize(c.source, c.payload);
  } catch (e) {
    return { error: true, message: (e as Error).message };
  }
};

describe("free-jobs connector over the golden payloads", () => {
  it(`${cases.length} cases give the expected listing or refusal`, () => {
    const wrong = (e: Expected, got: Record<string, unknown>) =>
      "error" in e ? !("error" in got)
      : "unknown" in e ? "error" in got || got[e.unknown as string] !== null
      : "listing" in e ? "error" in got
      : JSON.stringify(got) !== JSON.stringify(e);
    const bad = cases.map((c) => ({ c, got: run(c) as Record<string, unknown> })).filter(({ c, got }) => wrong(c.expect, got))
      .map(({ c, got }) => ({ payload: JSON.stringify(c.payload).slice(0, 200), expect: c.expect, got }));
    expect(bad).toEqual([]);
  });
});

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const rem = (changes: Record<string, unknown> = {}) => ({
  id: 1, url: "https://remotive.com/remote-jobs/software-dev/backend-1", title: "Backend API engineer",
  description: "<p>Build an API</p>", job_type: "part_time", publication_date: "2026-09-18T12:00:00",
  candidate_required_location: "Worldwide", ...changes,
});

describe("free-jobs feed", () => {
  it("keeps only contract, part-time and freelance listings and counts every listing seen", () => {
    const got = parseFeed("remotive", enc({ jobs: [rem(), rem({ id: 2, job_type: "full_time" }), rem({ id: 3, job_type: "freelance" }), rem({ id: 4, job_type: "internship" })] }));
    expect([got.seen, got.listings.map((l) => l.external_id)]).toEqual([4, ["1", "3"]]);
  });

  it("keeps a job listed twice once, as its last entry", () => {
    const got = parseFeed("remotive", enc({ jobs: [rem({ title: "First" }), rem({ title: "Second" })] }));
    expect([got.seen, got.listings.map((l) => l.title)]).toEqual([2, ["Second"]]);
  });

  it("sets aside a listing whose employment types change format or that lacks its identity, and keeps the others (Will 2026-11-15)", () => {
    expect(() => normalize("remotive", rem({ job_type: ["contract"] }))).toThrow(/employment type/);
    for (const bad of [rem({ id: 2, job_type: ["contract"] }), rem({ id: 2, description: null }), rem({ id: "2" }), "x"]) {
      const got = parseFeed("remotive", enc({ jobs: [rem(), bad, rem({ id: 3 })] }));
      expect([got.seen, got.rejected, got.listings.map((l) => l.external_id)]).toEqual([3, 1, ["1", "3"]]);
    }
    const j = parseFeed("jobicy", enc({ jobs: [{ id: 2, url: "https://jobicy.com/jobs/2-python", jobTitle: "Python API", jobDescription: "<p>API</p>", jobType: ["contract"] }, { id: 3 }] }));
    expect([j.seen, j.rejected, j.listings.map((l) => l.external_id)]).toEqual([2, 1, ["2"]]);
  });

  it("refuses a feed that is not JSON, has no jobs list or lists over 200", () => {
    for (const body of [enc("<html>"), enc({ items: [] }), enc({ jobs: Array.from({ length: 201 }, (_, i) => rem({ id: i + 1 })) }), new Uint8Array([0x7b, 0xff, 0x7d])]) {
      expect(() => parseFeed("remotive", body)).toThrow(/remotive/);
    }
  });

  it("keeps unknown hours and geography unknown; names of a country exclude Taiwan; a salary is no project budget", () => {
    const l = normalize("remotive", rem());
    expect([l.weekly_hours, l.taiwan_eligible, l.budget_min, l.description, l.published_at]).toEqual([null, null, null, "Build an API", "2026-09-18T12:00:00.000Z"]);
    expect(normalize("remotive", rem({ candidate_required_location: " USA " })).taiwan_eligible).toBe(false);
    const j = normalize("jobicy", { id: 2, url: "https://jobicy.com/jobs/2-python", jobTitle: "Python API", jobDescription: "<p>API</p>", jobType: ["contract"], jobGeo: "Anywhere", pubDate: "2026-09-18 12:00:00", salaryMin: 100000, salaryPeriod: "yearly" });
    expect([j.kind, j.budget_min, j.published_at]).toEqual(["contract", null, "2026-09-18T12:00:00.000Z"]);
  });
});
