import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { INDEX, normalizeJob, parseIndex, WELLFOUND_SETTINGS } from ".";

// Plan step 8b: Wellfound is a new source (no old reader or recorded reference pages); the entries below follow the
// page read on 2026-11-17 (spikes.md §2), with made-up values.

type J = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);
const job = (i: number, o: J = {}): J => ({
  __typename: "JobListing", id: String(5000000 + i), slug: `ai-agent-engineer-${i}`, title: `AI agent engineer ${i}`, compensation: "$50k – $70k • No equity",
  locationNames: ["Taipei"], acceptedRemoteLocationNames: [], remote: false, liveStartAt: 1794830582, primaryRole: { slug: "engineering" }, startup: { __ref: "Startup:1" }, ...o,
});
const page = (jobs: unknown[]) => {
  const data: J = { ROOT_QUERY: { talent: {} }, "Startup:1": { __typename: "Startup", id: "1", name: "Acme" } };
  // The cache is keyed by id: a listing shown twice is one entry, so the second copy gets its own key.
  jobs.forEach((j, n) => (data[`JobListing:${n}`] = j));
  return enc(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloState: { data } } } })}</script></html>`);
};
const one = (o: J = {}) => {
  const { cache, jobs } = parseIndex(page([job(1, o)]));
  return normalizeJob(cache, jobs[0]);
};

describeOnePageSource({
  settings: WELLFOUND_SETTINGS, index: INDEX, page, good: (i) => job(i), retitled: (i) => job(i, { title: "Retitled" }), id: (i) => String(5000000 + i),
  bad: () => job(99, { id: null }), broken: enc("<html><body>no data</body></html>"),
});

describe("wellfound listings", () => {
  it("reads the listing, its startup and its link", () => {
    const l = one();
    expect([l.url, l.company, l.location, l.compensation_evidence, l.published_at]).toEqual(["https://wellfound.com/jobs/5000001-ai-agent-engineer-1", "Acme", "Taipei", "$50k – $70k • No equity", "2026-11-16T12:03:02.000Z"]);
  });

  it("names a listing by its id only: a changed title or slug is the same listing", () => {
    expect(one({ title: "Renamed", slug: "renamed" }).external_id).toBe(one().external_id);
  });

  it("never reads free-text places as a Taiwan exclusion; remote places are kept in the location", () => {
    const tw = (o: J) => one(o).taiwan_eligible;
    expect([tw({ remote: true, acceptedRemoteLocationNames: ["Europe"] }), tw({ remote: true, acceptedRemoteLocationNames: ["Taipei"] }), tw({ remote: false })]).toEqual([null, null, null]);
    expect(one({ remote: true, acceptedRemoteLocationNames: ["Europe"] }).location).toBe("Taipei; Remote: Europe");
  });

  it("keeps unknown unknown: description, kind, budget, a missing startup or time", () => {
    const l = one({ startup: null, liveStartAt: null, compensation: "" });
    expect([l.description, l.kind, l.budget_min, l.company, l.published_at, l.compensation_evidence, l.taiwan_eligible]).toEqual([null, null, null, null, null, null, null]);
  });

  it("sets aside a listing without id, title or slug", () => {
    for (const o of [{ id: "" }, { id: "12a" }, { title: "" }, { slug: "Bad Slug" }]) expect(() => one(o)).toThrow(/wellfound/);
  });
});
