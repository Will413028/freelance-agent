import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { INDEX, normalizeJob, parseIndex, YCJOBS_SETTINGS } from ".";

// Plan step 8b: YC Jobs is a new source (no old reader or recorded reference pages); the entries below follow the
// page read on 2026-11-17 (spikes.md §2), with made-up values.

type J = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);
const job = (i: number, o: J = {}): J => ({
  id: 100000 + i, title: `AI agent engineer ${i}`, url: `/companies/acme/jobs/Ab${i}cD-ai-agent-engineer`, location: "Remote (US)", type: "Full-time",
  prettyRole: "Engineering", salaryRange: "$150K - $200K", visa: "US citizen/visa only", minExperience: "3+ years", companyName: "Acme", companyBatchName: "S22", createdAt: "4 months", ...o,
});
const attr = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const page = (jobs: unknown[]) => enc(`<html><div id="app" data-page="${attr(JSON.stringify({ component: "Jobs", props: { jobPostings: jobs, jobsCount: "thousands" } }))}"></div></html>`);
const one = (o: J = {}) => normalizeJob(parseIndex(page([job(1, o)]))[0]);

describeOnePageSource({
  settings: YCJOBS_SETTINGS, index: INDEX, page, good: (i) => job(i), retitled: (i) => job(i, { title: "Retitled" }), id: (i) => String(100000 + i),
  bad: () => job(99, { id: "x" }), broken: enc("<html><body>no data</body></html>"),
});

describe("yc jobs", () => {
  it("reads the job, its company and its link", () => {
    const l = one();
    expect([l.url, l.company, l.location, l.kind, l.compensation_evidence]).toEqual(["https://www.ycombinator.com/companies/acme/jobs/Ab1cD-ai-agent-engineer", "Acme", "Remote (US)", "full_time", "$150K - $200K"]);
  });

  it("names a job by its id only", () => {
    expect(one({ title: "Renamed", url: "/companies/acme/jobs/Ab1cD-renamed" }).external_id).toBe("100001");
  });

  it("keeps unknown unknown: publication time (only words), Taiwan eligibility, description, budget", () => {
    const l = one({ type: "Internship" });
    expect([l.published_at, l.taiwan_eligible, l.description, l.budget_min, l.kind, l.extra.created_ago]).toEqual([null, null, null, null, null, "4 months"]);
    expect([one({ type: "Contract" }).kind, one({ type: "Part-time" }).kind]).toEqual(["contract", "contract"]);
  });

  it("sets aside a job without id, title or a YC company job path", () => {
    for (const o of [{ id: 0 }, { id: 1.5 }, { title: "" }, { url: "https://evil.example/companies/x/jobs/1" }, { url: "/jobs/1" }]) expect(() => one(o)).toThrow(/ycjobs/);
  });
});
