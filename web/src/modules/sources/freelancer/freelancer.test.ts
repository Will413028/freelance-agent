import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { FREELANCER_SETTINGS, freelancerConnector, normalize, outOfScope, pageUrl, QUERIES, searchQuery, titleSignal } from ".";

// Plan step 5a: the golden payloads (fixtures/cases.json, written by fixtures/generate.ts (deleted in step 5a2 with legacyToInput, D10; see it and its list of deliberate differences at 9a68d6b) from legacyToInput
// of the old output) against the native connector, then the connector's own rules and intake.

type Expected = Record<string, unknown> | { error: true } | { unknown: string } | { listing: true };
type Cases = {
  normalize: { payload: unknown; expect: Expected; why?: string }[];
  search: { query: string; limit: number; maxPages: number; pages: Record<string, [number, string]>; urls: string[]; expect: { error: true } | { listings: unknown[]; rejected?: number } | { ids: string[]; rejected?: number }; why?: string }[];
  regex: { pattern: "TITLE_SIGNAL" | "OUT_OF_SCOPE"; input: string; match: boolean }[];
};
const cases: Cases = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

const attempt = <T,>(fn: () => T) => {
  try {
    return fn() as Record<string, unknown>;
  } catch (e) {
    return { error: true, message: (e as Error).message };
  }
};

/** A Fetcher over {url: [status, latin1 body]} recording the URLs; an unknown URL fails like the network, a status but 200 like the real Fetcher. */
function site(pages: Record<string, [number, string]>) {
  const urls: string[] = [];
  const fetcher: Fetcher = {
    get requests() { return urls.length; },
    async get({ url }) {
      urls.push(url);
      if (!Object.hasOwn(pages, url)) throw new FetchError("network", "unknown url");
      const [status, body] = pages[url];
      if (status !== 200) throw new FetchError("http_status", `HTTP ${status}`, status);
      return { status, tier: "plain", body: new Uint8Array(Buffer.from(body, "latin1")) };
    },
  };
  return { urls, fetcher };
}

describe("freelancer connector over the golden payloads", () => {
  it(`${cases.normalize.length} projects give the expected listing or refusal`, () => {
    const wrong = (e: Expected, got: Record<string, unknown>) =>
      "error" in e ? !("error" in got)
      : "unknown" in e ? "error" in got || (e.unknown as string in got ? got[e.unknown as string] : (got.extra as Record<string, unknown>)[e.unknown as string]) !== null
      : "listing" in e ? "error" in got
      : JSON.stringify(got) !== JSON.stringify(e);
    const bad = cases.normalize.map((c) => ({ c, got: attempt(() => normalize(c.payload)) })).filter(({ c, got }) => wrong(c.expect, got))
      .map(({ c, got }) => ({ payload: JSON.stringify(c.payload).slice(0, 300), expect: c.expect, got }));
    expect(bad).toEqual([]);
  });

  it(`${cases.search.length} search response sets give the expected listings, with the same requests`, async () => {
    const bad = [];
    for (const c of cases.search) {
      const { urls, fetcher } = site(c.pages);
      let got: unknown;
      try {
        const r = await searchQuery(fetcher, c.query, c.limit, c.maxPages);
        got = { listings: r.listings, ...(r.rejected ? { rejected: r.rejected } : {}) };
      } catch (e) {
        got = { error: true, message: (e as Error).message };
      }
      const ok = "error" in c.expect ? "error" in (got as object)
        : "ids" in c.expect ? !("error" in (got as object)) && JSON.stringify((got as { listings: { external_id: string }[] }).listings.map((l) => l.external_id).sort()) === JSON.stringify(c.expect.ids)
          && ((got as { rejected?: number }).rejected ?? 0) === (c.expect.rejected ?? 0)
        : JSON.stringify(got) === JSON.stringify(c.expect);
      // A refused batch may stop before the requests the old search went on to make.
      if (!ok || ("listings" in c.expect && JSON.stringify(urls) !== JSON.stringify(c.urls))) bad.push({ query: c.query, why: c.why, expect: c.expect, got, urls, oldUrls: c.urls });
    }
    expect(bad).toEqual([]);
  });

  it(`title patterns match as Python's did on ${cases.regex.length} golden inputs`, () => {
    const re = { TITLE_SIGNAL: titleSignal, OUT_OF_SCOPE: outOfScope };
    expect(cases.regex.filter((c) => re[c.pattern](c.input) !== c.match)).toEqual([]);
  });
});

const NOW = new Date("2026-09-20T00:00:00Z");
const project = (changes: Record<string, unknown> = {}) => ({
  id: 42, title: "AI agent backend", description: "Build an API", status: "active", type: "fixed",
  budget: { minimum: 100, maximum: 500 }, currency: { code: "USD" }, time_updated: 1789742168,
  seo_url: "python/AI-agent", deleted: false, nonpublic: false, ...changes,
});
const body = (projects: unknown[], total = projects.length) => JSON.stringify({ status: "success", result: { projects, total_count: total } });
/** Each query's first page from `byQuery` (latin1 = the UTF-8 bytes of an ASCII body), other queries empty. */
const serving = (byQuery: Partial<Record<(typeof QUERIES)[number], unknown[]>>) =>
  site(Object.fromEntries(QUERIES.map((q) => [pageUrl(q, 100, 0), [200, body(byQuery[q] ?? [])] as [number, string]])));

describe("freelancer connector", () => {
  it("marks titles that name the work kept and out-of-scope ones not; counts every distinct project seen", async () => {
    const { fetcher, urls } = serving({
      "AI agent": [project(), project({ id: 43, title: "Logo design for AI startup" }), project({ id: 44, title: "Bookkeeping help" })],
      "API integration": [project({ id: 42 }), project({ id: 45, title: "Stripe API integration" })],
    });
    const got = await freelancerConnector(fetcher);
    expect([got.seen, got.listings.filter(got.sourceKept).map((l) => l.external_id), urls.length]).toEqual([4, ["42", "45"], 3]);
  });

  it("follows pages to the reported total, the offset advancing by the requested page", async () => {
    const { fetcher, urls } = site({
      [pageUrl("AI agent", 2, 0)]: [200, body([project({ id: 1 }), project({ id: 2 })], 3)],
      [pageUrl("AI agent", 2, 2)]: [200, body([project({ id: 3 })], 3)],
    });
    expect(await searchQuery(fetcher, "AI agent", 2)).toMatchObject({ limited: false, listings: [{ external_id: "1" }, { external_id: "2" }, { external_id: "3" }] });
    expect(urls).toHaveLength(2);
  });

  it("marks a query stopped by the page cap before the reported total as limited, and the run as truncated", async () => {
    const pages = Object.fromEntries(Array.from({ length: 2 }, (_, n) => [pageUrl("AI agent", 1, n), [200, body([project({ id: n + 1 })], 5)] as [number, string]]));
    expect((await searchQuery(site(pages).fetcher, "AI agent", 1, 2)).limited).toBe(true);
    const capped = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [pageUrl("AI agent", 100, n * 100), [200, body([project({ id: n + 1 })], 5000)] as [number, string]]));
    for (const q of QUERIES.slice(1)) capped[pageUrl(q, 100, 0)] = [200, body([])];
    expect((await freelancerConnector(site(capped).fetcher)).truncated).toBe(true);
    expect((await freelancerConnector(serving({ "AI agent": [project()] }).fetcher)).truncated).toBe(false);
  });

  it("refuses the batch for a response that is not a success, not JSON, or over the page size", async () => {
    for (const b of [JSON.stringify({ status: "error" }), "<html>", body([project(), project({ id: 2 })], 2)]) {
      const { fetcher } = site({ [pageUrl("AI agent", 1, 0)]: [200, b] });
      await expect(searchQuery(fetcher, "AI agent", 1)).rejects.toThrow(/freelancer/);
    }
  });

  it("sets aside and counts a project without identity, keeping the others", async () => {
    for (const bad of [{ description: "" }, { status: "closed" }, { seo_url: "../x" }, { seo_url: "no-slash" }, { id: 2 ** 53 }]) {
      const { fetcher } = serving({ "AI agent": [project(), project({ id: 2, ...bad })] });
      const got = await freelancerConnector(fetcher);
      // seen: distinct projects read; examined: project entries checked, like rejected.
      expect([got.seen, got.rejected, got.examined, got.listings.filter(got.sourceKept).map((l) => l.external_id)]).toEqual([1, 1, 2, ["42"]]);
    }
  });

  it("counts a broken project returned by every query once per query in both rejected and examined", async () => {
    const all = [project(), project({ id: 45, title: "Stripe API integration" }), project({ id: 2, description: "" })];
    const got = await freelancerConnector(serving({ "AI agent": all, "API integration": all, "MVP web development": all }).fetcher);
    expect([got.seen, got.rejected, got.examined, got.listings.filter(got.sourceKept).map((l) => l.external_id)]).toEqual([2, 3, 9, ["42", "45"]]);
  });

  it("refuses two different versions of a project with the same update time", async () => {
    const { fetcher } = site({ [pageUrl("AI agent", 2, 0)]: [200, body([project(), project({ title: "AI agent backend v2" })])] });
    await expect(searchQuery(fetcher, "AI agent", 2)).rejects.toThrow(/conflicting/);
  });

  it("keeps unknown fields unknown: time, type, currency, budget; hours and eligibility are never guessed", () => {
    const l = normalize(project({ time_updated: "soon", type: "contest", currency: { code: "usd" }, budget: { minimum: 500, maximum: 100 } }));
    expect([l.kind, l.currency, l.budget_min, l.budget_max, l.extra, l.weekly_hours, l.taiwan_eligible, l.published_at])
      .toEqual([null, null, null, null, { time_updated: null, project_type: "contest" }, null, null, null]);
    expect(normalize(project()).extra).toEqual({ time_updated: "2026-09-18T14:36:08.000Z", project_type: "fixed" });
  });

  it("asks for at most 60 pages per run, one second apart", () => {
    expect([FREELANCER_SETTINGS.maxRequestsPerRun, FREELANCER_SETTINGS.minIntervalMs, FREELANCER_SETTINGS.maxTier, FREELANCER_SETTINGS.disabled]).toEqual([60, 1000, "plain", null]);
  });
});

describe("freelancer intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...FREELANCER_SETTINGS, order: 0 };

  it("writes every listing read, marked by the source's rule, and counts as jobs what the rule and screening keep (plan D9)", async () => {
    const { fetcher } = serving({ "AI agent": [project(), project({ id: 43, title: "SEO for AI agency" })] });
    const run = await collectSource(db, settings, NOW, fetcher);
    expect([run.seen, run.jobs, run.externalIds]).toEqual([2, 1, ["42", "43"]]);
    expect([(await listingBy(db, "freelancer", "42"))?.sourceKept, (await listingBy(db, "freelancer", "43"))?.sourceKept]).toEqual([true, false]);
  });

  it("screening marks a project that matches no work category hard-excluded (old score > 0)", async () => {
    const { fetcher } = serving({ "AI agent": [project(), project({ id: 46, title: "Telegram bot for my club", description: "Small job." })] });
    expect((await collectSource(db, settings, NOW, fetcher)).jobs).toBe(1);
    expect((await listingBy(db, "freelancer", "46"))?.hardExcluded).toBe(true);
  });

  it("writes the others when one project lacks its identity, and nothing when most do", async () => {
    const run = await collectSource(db, settings, NOW, serving({ "AI agent": [project(), project({ id: 43, title: "" })] }).fetcher);
    expect([run.seen, run.rejected, run.examined, run.externalIds]).toEqual([1, 1, 2, ["42"]]);
    await db.execute(sql`truncate listings cascade`);
    const most = serving({ "AI agent": [project(), project({ id: 43, title: "" }), project({ id: 44, seo_url: "x" })] }).fetcher;
    await expect(collectSource(db, settings, NOW, most)).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "freelancer", "42")).toBeNull();
  });

  it("writes the 2 good projects when one broken project comes back from all 3 queries", async () => {
    const all = [project(), project({ id: 45, title: "Stripe API integration" }), project({ id: 2, description: "" })];
    const run = await collectSource(db, settings, NOW, serving({ "AI agent": all, "API integration": all, "MVP web development": all }).fetcher);
    expect([run.rejected, run.examined, run.externalIds]).toEqual([3, 9, ["42", "45"]]);
  });

  it("a second run of the same responses changes nothing", async () => {
    await collectSource(db, settings, NOW, serving({ "AI agent": [project()] }).fetcher);
    expect((await collectSource(db, settings, NOW, serving({ "AI agent": [project()] }).fetcher)).intake).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
  });
});
