import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { indexEntry, INDEX, JUSTREMOTE_SETTINGS, jobUrl, justRemoteConnector, kept, parseArticle, parseIndex } from ".";

// Plan step 5c: the golden index pages and detail pages against the native connector, then its own
// rules. fixtures/cases.json was generated once from golden.json's justremote_index and
// justremote_article at ce1254d by a throwaway generator (not committed): the old output mapped into
// the contract directly (independent of this connector), every deliberate difference listed there by
// golden index with its reason and carried in each case's `why`. Differences: SET_ASIDE 17 (old
// rejected_count, same count, now per listing), ACCEPTED 3 (index 20: id 1.0 is 1 in JavaScript;
// index 24: an upper-case scheme and host name the same job URL; article 34: the entry's url comes
// from its href, never a 'url' key), D8_UNKNOWN 3 (index 22: location restrictions not a list of
// text; article 13 and 15: an unreadable validThrough is an invalid deadline), PATCHED 0, REFUSED 0.

type IndexCase = { index: number; input: string; why?: string; expect: { error: true } | { seen: number; ids: string[]; urls: string[]; rejected: number } };
type ArticleCase = { index: number; input: string; entry: string; why?: string; expect: { listing: unknown } | { setAside: true } };
const cases: { index: IndexCase[]; article: ArticleCase[] } = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

describe("justremote over the golden pages", () => {
  it(`${cases.index.length} index pages give the expected entries or refusal`, () => {
    const bad = cases.index.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseIndex(latin1(c.input));
      } catch (e) {
        return "error" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      const e = c.expect;
      if ("error" in e) return [{ index: c.index, expect: e, got }];
      const same = got.entries.length === e.seen && got.rejected === e.rejected && got.examined === got.entries.length + got.rejected
        && isDeepStrictEqual(got.entries.map((x) => x.id), e.ids) && isDeepStrictEqual(got.entries.map((x) => x.url), e.urls);
      return same ? [] : [{ index: c.index, expect: e, got }];
    });
    expect(bad).toEqual([]);
  });

  it(`${cases.article.length} detail pages give the expected listing or set-aside`, () => {
    const bad = cases.article.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseArticle(latin1(c.input), indexEntry(JSON.parse(c.entry)));
      } catch (e) {
        return "setAside" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      return "listing" in c.expect && isDeepStrictEqual(JSON.parse(JSON.stringify(got)), c.expect.listing) ? [] : [{ index: c.index, expect: c.expect, got }];
    });
    expect(bad).toEqual([]);
  });
});

const NOW = new Date("2026-10-01T00:00:00Z");
type E = Record<string, unknown>;
const entry = (o: E = {}): E => ({ id: 42, title: "AI agent API engineer", job_type: "contract", category: "developer", is_active: true, location_restrictions: [], href: "remote-developer-jobs/ai-agent-acme", ...o });
const indexPage = (...entries: E[]) => new TextEncoder().encode(`<html><script>window.__PRELOADED_STATE__ = ${JSON.stringify({ jobsState: { entity: { all: entries }, meta: { status: "success" } } })};</script></html>`);
const posting = (o: E = {}) => ({ "@type": "JobPosting", title: "AI agent API engineer", description: "<p>Build an AI agent API</p>", employmentType: "CONTRACTOR", datePosted: "2026-09-26T10:00:00+00:00", jobLocationType: "TELECOMMUTE", ...o });
const detail = (o: E = {}) => new TextEncoder().encode(`<html><script type="application/ld+json">${JSON.stringify(posting(o))}</script></html>`);
const article = (e: E = {}, p: E = {}) => parseArticle(detail(p), indexEntry(entry(e)));

describe("justremote rules", () => {
  it("marks active remote contract technical jobs of the last 90 days kept (plan D9)", () => {
    const k = (e: E, p: E = {}) => kept(article(e, p), NOW);
    expect([
      k({}), k({ is_active: false }), k({ category: "marketing" }), k({}, { jobLocationType: "REMOTE" }), k({}, { employmentType: "PART_TIME" }),
      k({ job_type: "permanent" }, { employmentType: "FULL_TIME" }), k({}, { datePosted: "2026-06-01T00:00:00Z" }), k({}, { datePosted: "2026-10-02T00:00:00Z" }),
      k({ category: "devopsandsysadmin" }),
    ]).toEqual([true, false, false, false, true, false, false, false, true]);
  });

  it("keeps unknown unknown: unreadable restrictions, hours, budget and eligibility stay null; a non-Taiwan restriction is false", () => {
    const l = article({ location_restrictions: "US" });
    expect([l.location, l.taiwan_eligible, l.weekly_hours, l.budget_min, l.company, l.extra.location_restrictions]).toEqual([null, null, null, null, null, null]);
    expect([article({ location_restrictions: ["Worldwide"] }).taiwan_eligible, article({ location_restrictions: ["United States", "Canada"] })].map((x) => (typeof x === "object" && x ? [x.location, x.taiwan_eligible] : x)))
      .toEqual([null, ["United States, Canada", false]]);
    expect(article({}, { validThrough: "2026-12-01" }).deadline).toEqual({ kind: "date", date: "2026-12-01" });
    expect(article({}, { validThrough: "2026-12-01T00:00:00" }).deadline).toEqual({ kind: "no_timezone", text: "2026-12-01T00:00:00" });
  });

  it("names a job by JustRemote's numeric id; spellings of its URL give one URL; a URL off the board is refused", () => {
    for (const u of ["/remote-developer-jobs/xy", "//justremote.co/remote-developer-jobs/xy", "https://JustRemote.co:443/remote-developer-jobs/xy?utm=1#f", " remote-developer-jobs/xy "]) {
      expect(jobUrl(u)).toBe("https://justremote.co/remote-developer-jobs/xy");
    }
    for (const u of ["https://evil.example/remote-developer-jobs/xy", "http://justremote.co/remote-developer-jobs/xy", "remote-developer-jobs/XY", "remote-jobs/xy", "remote-developer-jobs/xy/", 5, null]) expect(jobUrl(u)).toBeNull();
    expect(article({ href: "https://JUSTREMOTE.CO/remote-developer-jobs/ai-agent-acme" })).toMatchObject({ external_id: "42", url: "https://justremote.co/remote-developer-jobs/ai-agent-acme" });
  });

  it("sets aside and counts an index entry without its identity, keeping the others", () => {
    for (const bad of [{ id: "1" }, { id: 0 }, { id: 2 ** 53 }, { job_type: "freelance" }, { category: 5 }, { is_active: 1 }, { href: "https://evil.example/x" }, { title: "" }, { id: 42 }]) {
      const got = parseIndex(indexPage(entry(), entry({ id: 7, ...bad })));
      expect([got.entries.map((e) => e.id), got.rejected, got.examined]).toEqual([["42"], 1, 2]);
    }
  });

  it("sets aside a detail that does not match its entry or lacks what the rule reads", () => {
    for (const [e, p] of [[{}, { title: "Other" }], [{ job_type: "permanent" }, {}], [{}, { employmentType: null }], [{}, { datePosted: "2026-09-26" }], [{}, { description: "" }]] as [E, E][]) {
      expect(() => article(e, p)).toThrow(/justremote/);
    }
  });

  it("refuses an index page without exactly one complete, literal, non-empty state of at most 2,000 entries", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const many = Array.from({ length: 2001 }, (_, i) => entry({ id: i + 1 }));
    for (const body of [enc("<h1>none</h1>"), enc("<script>window.__PRELOADED_STATE__ = {};alert(1)</script>"), indexPage(), indexPage(...many), new Uint8Array([0xff]), new Uint8Array(0),
      enc(`<script>window.__PRELOADED_STATE__ = {"jobsState": {"entity": {"all": [${JSON.stringify(entry())}]}, "meta": {"status": "loading"}}}</script>`)]) {
      expect(() => parseIndex(body)).toThrow(/justremote/);
    }
    expect(parseIndex(indexPage(...many.slice(0, 2000))).entries.length).toBe(2000);
  });
});

/** A fake Fetcher: a body per URL, or a FetchError to throw; it enforces a request cap like the real one. */
const fakeFetcher = (pages: Record<string, Uint8Array | FetchError>, cap = Infinity): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get(req) {
      if (urls.length >= cap) throw new FetchError("request_limit", "cap");
      urls.push(req.url);
      const page = pages[req.url];
      if (page === undefined) throw new FetchError("network", "no page");
      if (page instanceof FetchError) throw page;
      return { status: 200, body: page, tier: "plain" };
    },
  };
};
const url = (slug: string) => `https://justremote.co/remote-developer-jobs/job-${slug}`;
const site = (details: Record<string, Uint8Array | FetchError>, ...entries: E[]) => ({ [INDEX]: indexPage(...entries), ...Object.fromEntries(Object.entries(details).map(([s, b]) => [url(s), b])) });
const three = [entry({ id: 1, href: "remote-developer-jobs/job-a" }), entry({ id: 2, href: "remote-developer-jobs/job-b" }), entry({ id: 3, href: "remote-developer-jobs/job-c" })];

describe("justremote connector", () => {
  it("reads the index, then the detail of each contract or technical entry only", async () => {
    const f = fakeFetcher(site({ a: detail(), b: detail() }, ...three.slice(0, 2), entry({ id: 9, job_type: "permanent", category: "marketing", href: "remote-marketing-jobs/mkt" })));
    const got = await justRemoteConnector(f, NOW);
    expect([got.seen, got.listings.map((l) => l.external_id), got.rejected, got.examined, got.truncated]).toEqual([3, ["1", "2"], 0, 2, false]);
    expect(f.urls).toEqual([INDEX, url("a"), url("b")]);
  });

  it("sets aside a detail page that answers 404 or does not parse; keeps the others", async () => {
    const got = await justRemoteConnector(fakeFetcher(site({ a: detail(), b: new FetchError("http_status", "404", 404), c: detail({ title: "Other" }) }, ...three)), NOW);
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([["1"], 2, 3]);
  });

  it("fails the source on a detail 403 or an access challenge, or when the index fails", async () => {
    await expect(justRemoteConnector(fakeFetcher(site({ a: detail(), b: new FetchError("http_status", "403", 403) }, ...three)), NOW)).rejects.toThrow(/403/);
    await expect(justRemoteConnector(fakeFetcher(site({ a: new TextEncoder().encode("<title>Just a moment...</title>") }, ...three)), NOW)).rejects.toThrow(/challenge/);
    await expect(justRemoteConnector(fakeFetcher({}), NOW)).rejects.toThrow();
  });

  it("stops at the request cap and marks the read truncated, keeping what was read", async () => {
    const got = await justRemoteConnector(fakeFetcher(site({ a: detail(), b: detail(), c: detail() }, ...three), 3), NOW);
    expect([got.listings.map((l) => l.external_id), got.truncated, got.rejected]).toEqual([["1", "2"], true, 0]);
  });
});

describe("justremote into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...JUSTREMOTE_SETTINGS, order: 0 };
  const recent = () => new Date(Date.now() - 86_400_000).toISOString();

  it("writes every listing read, marked by the source's rule (plan D9)", async () => {
    const run = await collectSource(db, settings, new Date(), fakeFetcher(site({ a: detail({ datePosted: recent() }), b: detail({ datePosted: recent(), jobLocationType: "REMOTE" }) }, ...three.slice(0, 2))));
    expect(run.externalIds).toEqual(["1", "2"]);
    expect([(await listingBy(db, "justremote", "1"))?.sourceKept, (await listingBy(db, "justremote", "2"))?.sourceKept]).toEqual([true, false]);
  });

  it("writes nothing when the source fails", async () => {
    await expect(collectSource(db, settings, new Date(), fakeFetcher(site({ a: detail(), b: new FetchError("http_status", "429", 429) }, ...three)))).rejects.toThrow();
    expect(await listingBy(db, "justremote", "1")).toBeNull();
  });

  it("refuses and writes nothing when more than half are set aside; exactly half is written", async () => {
    await expect(collectSource(db, settings, new Date(), fakeFetcher(site({ a: detail(), b: detail({ title: "x" }), c: detail({ title: "y" }) }, ...three)))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "justremote", "1")).toBeNull();
    const run = await collectSource(db, settings, new Date(), fakeFetcher(site({ a: detail() }, three[0], entry({ id: 5, href: "https://evil.example/x" }))));
    expect([run.externalIds, run.rejected, run.examined]).toEqual([["1"], 1, 2]);
  });

  it("a second run of the same pages adds no rows and changes nothing (D24)", async () => {
    const pages = site({ a: detail({ datePosted: recent() }), b: detail() }, ...three.slice(0, 2));
    await collectSource(db, settings, new Date(), fakeFetcher(pages));
    expect((await collectSource(db, settings, new Date(), fakeFetcher(pages))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
