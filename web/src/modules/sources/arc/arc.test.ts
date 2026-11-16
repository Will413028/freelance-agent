import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { ARC_SETTINGS, INDEX, normalizeJob, parseIndex } from ".";

// Plan step 8b: Arc is a new source (no old reader or golden pages); the entries below follow the page
// read on 2026-11-17 (spikes.md §2), with made-up values.

type J = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);
const job = (i: number, o: J = {}): J => ({
  randomKey: `key${String(i).padStart(4, "0")}`, title: `AI agent engineer ${i}`, jobType: "contract", urlString: `ai-agent-engineer-${i}`,
  postedAt: 1794581467, minHourlyRate: 65, maxHourlyRate: 115, requiredCountries: [], company: { randomKey: null }, categories: [{ name: "Llm agents" }], ...o,
});
const page = (own: unknown[], external: unknown[] = []) =>
  enc(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { arcJobs: own, externalJobs: external } } })}</script></html>`);
const one = (o: J = {}, external = false) => normalizeJob({ job: job(1, o), external });

describeOnePageSource({
  settings: ARC_SETTINGS, index: INDEX, page: (jobs) => page(jobs), good: (i) => job(i), retitled: (i) => job(i, { title: "Retitled" }), id: (i) => `key${String(i).padStart(4, "0")}`,
  bad: () => job(99, { randomKey: null }), broken: enc("<html><body>no data</body></html>"),
});

describe("arc entries", () => {
  it("reads Arc's own jobs and the external ones, each under its own link", () => {
    const entries = parseIndex(page([job(1)], [job(2, { company: { name: "Acme" }, jobType: "permanent", minHourlyRate: null, maxHourlyRate: null, minAnnualSalary: 90000, maxAnnualSalary: 120000 })]));
    const [a, b] = entries.map(normalizeJob);
    expect([a.url, a.kind, a.company, a.compensation_evidence, a.extra.listed_by]).toEqual(["https://arc.dev/remote-jobs/details/ai-agent-engineer-1-key0001", "contract", null, "USD 65–115 per hour", "arc"]);
    expect([b.url, b.kind, b.company, b.compensation_evidence, b.extra.listed_by]).toEqual(["https://arc.dev/remote-jobs/j/ai-agent-engineer-2-key0002", "full_time", "Acme", "USD 90000–120000 per year", "external"]);
  });

  it("names a job by its key only: a changed title or slug is the same listing", () => {
    expect(one({ title: "Renamed", urlString: "renamed" }).external_id).toBe(one().external_id);
  });

  it("reads Taiwan eligibility only from required countries that leave Taiwan out", () => {
    expect([one({ requiredCountries: ["US"] }), one({ requiredCountries: ["US", "TW"] }), one({ requiredCountries: [] }), one({ requiredCountries: "US" })].map((l) => l.taiwan_eligible))
      .toEqual([false, null, null, null]);
  });

  it("keeps unknown unknown: description, budget, hours, a missing time or job type", () => {
    const l = one({ postedAt: "yesterday", jobType: "other", minHourlyRate: null, maxHourlyRate: null });
    expect([l.description, l.budget_min, l.budget_max, l.weekly_hours, l.published_at, l.kind, l.currency, l.compensation_evidence]).toEqual([null, null, null, null, null, null, null, null]);
    expect(one().published_at).toBe("2026-11-13T14:51:07.000Z");
  });

  it("sets aside a job without key, title or slug", () => {
    for (const o of [{ randomKey: "" }, { randomKey: "BAD KEY" }, { title: "  " }, { urlString: null }, { urlString: "../x" }]) expect(() => one(o)).toThrow(/arc/);
  });
});
