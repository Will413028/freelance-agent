import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { INDEX, normalizeJob, parseIndex, REMOTECO_SETTINGS } from ".";

// Plan step 8c: Remote.co is a new source (no old reader or recorded reference pages); the entries below
// follow the page read on 2026-11-17 (spikes.md §2), with made-up values.

type J = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const job = (i: number, o: J = {}): J => ({
  id: uuid(i), title: `Backend developer ${i}`, slug: `backend-developer-${uuid(i)}`,
  description: "Build and maintain APIs for a small team.", jobSummary: "Build and maintain APIs for a small team.",
  postedDate: "2026-11-16T17:17:27Z", expireOn: "2027-01-10T00:00:00Z", allowedCandidateLocation: ["US National"], countries: [],
  remoteOptions: ["100% Remote Work"], jobTypes: ["Employee"], jobSchedules: ["Full-Time"], company: {},
  salaryRange: "70,000.00 - 80,000.00 USD Annually", jobCategories: [{ categoryID: 29, name: "Software Development" }], ...o,
});
const page = (jobs: unknown[]) =>
  enc(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { jobCardData: { jobs: { totalCount: 9000, results: jobs } } } } })}</script></html>`);
const one = (o: J = {}) => normalizeJob(job(1, o));

describeOnePageSource({
  settings: REMOTECO_SETTINGS, index: INDEX, tier: "browser_like", page, good: (i) => job(i), retitled: (i) => job(i, { title: "Retitled" }), id: uuid,
  bad: () => job(99, { id: null }), broken: enc("<html><body>no data</body></html>"),
});

describe("remoteco entries", () => {
  it("reads the job under its own link with the summary, place and pay text", () => {
    const l = one();
    expect([l.url, l.canonical_url, l.description, l.location, l.compensation_evidence, l.kind, l.published_at, l.complete])
      .toEqual([`https://remote.co/job-details/backend-developer-${uuid(1)}`, `https://remote.co/job-details/backend-developer-${uuid(1)}`,
        "Build and maintain APIs for a small team.", "US National", "70,000.00 - 80,000.00 USD Annually", "full_time", "2026-11-16T17:17:27.000Z", false]);
    expect(l.extra).toMatchObject({ job_types: ["Employee"], categories: ["Software Development"], expires_at: "2027-01-10T00:00:00.000Z" });
  });

  it("names a job by its id only: a changed title or slug is the same listing", () => {
    expect(one({ title: "Renamed", slug: "renamed" }).external_id).toBe(one().external_id);
  });

  it("never says Taiwan is out: places are free text and country names, not codes", () => {
    for (const o of [{ allowedCandidateLocation: ["Houston, TX"], countries: ["United States"] }, { allowedCandidateLocation: ["US"] }, { allowedCandidateLocation: [] }])
      expect(one(o).taiwan_eligible).toBeNull();
  });

  it("calls a job full_time only for an employee on a full-time schedule; freelance stays unknown", () => {
    expect([one().kind, one({ jobTypes: ["Freelance"], jobSchedules: [] }).kind, one({ jobTypes: ["Employee", "Temporary"] }).kind, one({ jobSchedules: ["Part-Time"] }).kind, one({ jobSchedules: ["Full-Time", "Part-Time"] }).kind, one({ jobSchedules: ["Flexible Schedule", "Full-Time"] }).kind])
      .toEqual(["full_time", null, null, null, null, "full_time"]);
  });

  it("keeps unknown unknown: company, budget, hours, a missing time, summary or pay", () => {
    const l = one({ postedDate: "yesterday", description: null, jobSummary: "", salaryRange: null, company: { name: "  " } });
    expect([l.company, l.description, l.budget_min, l.budget_max, l.weekly_hours, l.published_at, l.currency, l.compensation_evidence, l.taiwan_eligible]).toEqual([null, null, null, null, null, null, null, null, null]);
    expect(one({ description: null, jobSummary: "Short summary." }).description).toBe("Short summary.");
  });

  it("sets aside a job without id, title or slug", () => {
    for (const o of [{ id: "" }, { id: "12345" }, { title: "  " }, { slug: null }, { slug: "../x" }]) expect(() => one(o)).toThrow(/remoteco/);
  });

  it("builds the link from any slug that stays one path segment", () => {
    expect(one({ slug: "Senior_PM.v2-x" }).url).toBe("https://remote.co/job-details/Senior_PM.v2-x");
    for (const slug of ["a/b", "..", "a?b", "a#b", "a b", "%2e%2e"]) expect(() => one({ slug })).toThrow(/slug/);
  });

  it("fails the page when the job list is not where it was", () => {
    expect(() => parseIndex(enc(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { jobCardData: {} } } })}</script></html>`))).toThrow(/job list not found/);
  });
});
