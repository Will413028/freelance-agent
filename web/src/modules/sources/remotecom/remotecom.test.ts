import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { INDEX, normalizeJob, parseIndex, REMOTECOM_SETTINGS } from ".";

// Plan step 8b: Remote.com Jobs is a new source (no old reader or golden pages); the entries below follow
// the page read on 2026-11-17 (spikes.md §2), with made-up values.

type J = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);
const job = (i: number, o: J = {}): J => ({
  status: "published", title: `AI agent engineer ${i}`, deadline: null, slug: `ai-agent-engineer-ab${i}cd`, insertedAt: "2026-11-01T00:00:00",
  compensation: { minimum: 1100000, maximum: 1600000, currency: { code: "USD" }, frequency: "yearly" },
  companyProfile: { name: "Acme", slug: "acme-x1" }, hiringLocation: { type: "location", includedLocations: [{ type: "country", value: { name: "South Africa", alpha2Code: "ZA" } }] },
  workplaceLocation: { type: "remote" }, publishedAt: "2026-08-28T07:16:12Z", employmentType: "contractor", ...o,
});
/** The page's server-component stream: the data split over two pushed chunks, as Next.js does. */
const page = (jobs: unknown[]) => {
  const flight = `8:["$","$L30",null,{"jobsData":${JSON.stringify({ jobs, totalCount: 5686, currentPage: 1, totalPages: 285 })}}]`;
  const cut = Math.floor(flight.length / 2);
  const push = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;
  return enc(`<html><script>self.__next_f.push([0])</script>${push(flight.slice(0, cut))}${push(flight.slice(cut))}</html>`);
};
const one = (o: J = {}) => normalizeJob(parseIndex(page([job(1, o)]))[0]);
const path = (i: number) => `/jobs/acme-x1/ai-agent-engineer-ab${i}cd`;

describeOnePageSource({
  settings: REMOTECOM_SETTINGS, index: INDEX, page, good: (i) => job(i), retitled: (i) => job(i, { title: "Retitled" }), id: path,
  bad: () => job(99, { slug: null }), broken: enc("<html><body>no data</body></html>"),
});

describe("remote.com jobs", () => {
  it("reads the job from the stream: link, company, kind, time, pay as evidence", () => {
    const l = one();
    expect([l.url, l.company, l.kind, l.published_at, l.listing_closed, l.location]).toEqual([`https://remote.com${path(1)}`, "Acme", "contract", "2026-08-28T07:16:12.000Z", false, "South Africa"]);
    expect([l.compensation_evidence, l.budget_min, l.budget_max, l.currency]).toEqual(["USD 11000–16000 yearly (listed in minor units, divided by 100)", null, null, null]);
  });

  it("refuses a stream with jobsData twice or not an object", () => {
    const two = new TextEncoder().encode(`<script>self.__next_f.push([1,${JSON.stringify(`{"jobsData":{"jobs":[]},"jobsData":{"jobs":[]}}`)}])</script>`);
    expect(() => parseIndex(two)).toThrow(/expected one jobsData/);
    const notObject = new TextEncoder().encode(`<script>self.__next_f.push([1,${JSON.stringify(`{"jobsData":"$L5"}`)}])</script>`);
    expect(() => parseIndex(notObject)).toThrow(/not an object/);
  });

  it("reads Taiwan eligibility only from listed places that leave Taiwan out; global stays unknown", () => {
    const at = (h: unknown) => one({ hiringLocation: h }).taiwan_eligible;
    expect([
      at({ type: "location", includedLocations: [{ type: "region", value: { name: "Europe" } }] }),
      at({ type: "location", includedLocations: [{ type: "country", value: { name: "Taiwan" } }] }),
      at({ type: "global", includedLocations: null }), at({ type: "timezone", includedLocations: [{ type: "region", value: { name: "Europe" } }] }), at(null), at({ type: "location", includedLocations: [{ type: "city", value: { name: "X" } }] }),
    ]).toEqual([false, null, null, null, null, null]);
    expect(one({ hiringLocation: { type: "global" } }).location).toBe("Global (as listed)");
  });

  it("keeps unknown unknown: a time without a zone, an odd kind or status, no pay", () => {
    const l = one({ publishedAt: "2026-08-28T07:16:12", employmentType: "other", status: "draft", compensation: null });
    expect([l.published_at, l.kind, l.listing_closed, l.compensation_evidence, l.description]).toEqual([null, null, null, null, null]);
    expect([one({ deadline: "2026-12-01" }).deadline, one({ deadline: "2026-12-01T10:00:00" }).deadline, one({ deadline: "soon" }).deadline])
      .toEqual([{ kind: "date", date: "2026-12-01" }, { kind: "no_timezone", text: "2026-12-01T10:00:00" }, { kind: "invalid", text: "soon" }]);
  });

  it("sets aside a job without slugs or title", () => {
    for (const o of [{ slug: "" }, { slug: "../x" }, { companyProfile: {} }, { title: " " }]) expect(() => one(o)).toThrow(/remotecom/);
  });
});
