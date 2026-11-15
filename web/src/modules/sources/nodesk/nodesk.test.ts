import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { FEED, jobUrl, kept, nodeskConnector, NODESK_SETTINGS, parseArticle, parseFeed } from ".";

// Plan step 5c: the golden feeds and job pages against the native connector, then its own rules.
// fixtures/cases.json was generated once from golden.json (nodesk_feed, nodesk_article) at ce1254d by a
// throwaway generator, not committed: the old output mapped straight into the contract, every deliberate
// difference listed there by golden index with its reason and carried in each case's `why`.
// Differences: feed ACCEPTED 1 (host case), SET_ASIDE 1 (pubDate past 9999: old refused the batch);
// job pages D8_UNKNOWN 2 (validThrough not text), REFUSED 2 (NaN in metadata; duplicate type attribute),
// ACCEPTED 3 (script tags and type attribute read by the HTML standard), PATCHED 1 (Unicode upper case version).

type FeedCase = { index: number; input: string; why?: string; expect: { error: true } | { entries: unknown[]; seen: number; rejected: number; examined: number; truncated: boolean } };
type ArticleCase = { index: number; input: string; entry: { url: string; published_at: string }; why?: string; expect: { listing: unknown } | { setAside: true } };
const cases: { feed: FeedCase[]; article: ArticleCase[] } = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

describe("nodesk over the golden feeds and job pages", () => {
  it(`${cases.feed.length} feeds give the expected entries or refusal`, () => {
    const bad = cases.feed.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseFeed(latin1(c.input));
      } catch (e) {
        return "error" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      const { entries, seen, rejected, examined, truncated } = got;
      const plain = { entries: entries.map((e) => ({ url: e.url, published_at: e.published_at })), seen, rejected, examined, truncated };
      return JSON.stringify(plain) === JSON.stringify(c.expect) ? [] : [{ index: c.index, expect: c.expect, got: plain }];
    });
    expect(bad).toEqual([]);
  });

  it(`${cases.article.length} job pages give the expected listing or are set aside`, () => {
    const bad = cases.article.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseArticle(latin1(c.input), c.entry);
      } catch (e) {
        return "setAside" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      return "listing" in c.expect && JSON.stringify(got) === JSON.stringify(c.expect.listing) ? [] : [{ index: c.index, expect: c.expect, got }];
    });
    expect(bad).toEqual([]);
  });

  it("every job URL the old reader accepted names one id, stable when read again", () => {
    const urls = cases.article.flatMap((c) => ("listing" in c.expect ? [(c.expect.listing as { url: string }).url] : []));
    expect(urls.length).toBeGreaterThan(30);
    for (const u of urls) expect(jobUrl(jobUrl(u))).toBe(u);
  });
});

const NOW = new Date("2026-10-01T00:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);
const item = (link: string, pubDate = "Sat, 26 Sep 2026 00:00:00 GMT") => `<item><title>t</title><link>${link}</link><pubDate>${pubDate}</pubDate></item>`;
const rss = (...items: string[]) => enc(`<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>NoDesk</title>${items.join("")}</channel></rss>`);
const job = (o: Record<string, unknown> = {}) => {
  const data = { "@type": "JobPosting", title: "AI agent developer", description: "<p>Build an AI agent.</p>", employmentType: ["CONTRACTOR"], jobLocationType: "TELECOMMUTE", datePosted: "2026-09-26", ...o };
  return enc(`<html><script type="application/ld+json">${JSON.stringify(data)}</script></html>`);
};
const A = "https://nodesk.co/remote-jobs/acme-ai/", B = "https://nodesk.co/remote-jobs/beta-dev/", C = "https://nodesk.co/remote-jobs/core-api/";
const entry = (url = A) => ({ url, published_at: "2026-09-26T00:00:00.000Z" });

describe("nodesk rules", () => {
  it("names one job by one id across spellings of its URL; a URL off the board is set aside", () => {
    for (const u of [" https://NoDesk.co/remote-jobs/acme-ai/?ref=x#y ", "https://nodesk.co:443/remote-jobs/acme-ai/", "/remote-jobs/acme-ai/"]) expect(jobUrl(u)).toBe(A);
    for (const u of ["http://nodesk.co/remote-jobs/acme-ai/", "https://nodesk.co/remote-jobs/acme-ai", "https://evil.example/remote-jobs/acme-ai/", "https://nodesk.co.evil/remote-jobs/acme-ai/",
      "https://nodesk.co/remote-jobs/Acme/", "https://nodesk.co/remote-jobs/-a/", "https://nodesk.co/remote-jobs/a/", "https://u:p@nodesk.co/remote-jobs/acme-ai/", "https://nodesk.co\\remote-jobs\\acme-ai\\", 5, null]) {
      expect(jobUrl(u)).toBeNull();
    }
    const got = parseFeed(rss(item(" https://NODESK.co:443/remote-jobs/acme-ai/?x=1"), item("https://evil.example/remote-jobs/acme-ai/")));
    expect([got.entries.map((e) => e.url), got.rejected, got.examined]).toEqual([[A], 1, 2]);
  });

  it("sets aside and counts a feed item without its job URL or zoned time, keeping the others", () => {
    for (const bad of [item("https://nodesk.co/remote-jobs/x"), item(B, ""), item(B, "2026-09-26T00:00:00"), "<item><link>" + B + "</link></item>"]) {
      const got = parseFeed(rss(item(A), bad, item(C)));
      expect([got.seen, got.rejected, got.examined, got.entries.map((e) => e.url)]).toEqual([3, 1, 3, [A, C]]);
    }
  });

  it("keeps a job listed twice once, as its last item", () => {
    const got = parseFeed(rss(item(A, "Sat, 26 Sep 2026 00:00:00 GMT"), item(B), item(A, "Sun, 27 Sep 2026 00:00:00 GMT")));
    expect(got.entries).toEqual([{ url: A, published_at: "2026-09-27T00:00:00.000Z", pubDate: "Sun, 27 Sep 2026 00:00:00 GMT" }, expect.objectContaining({ url: B })]);
  });

  it("reads at most 20 items and marks the feed truncated when it has more", () => {
    const many = Array.from({ length: 21 }, (_, i) => item(`https://nodesk.co/remote-jobs/j${i}/`));
    expect([parseFeed(rss(...many)).entries.length, parseFeed(rss(...many)).truncated, parseFeed(rss(...many.slice(0, 20))).truncated]).toEqual([20, true, false]);
  });

  it("refuses a feed that is empty, oversize, not UTF-8, declares a DTD, is not RSS or has no items", () => {
    for (const body of [enc(""), new Uint8Array(2_000_001), new Uint8Array([0xff]), enc("<!DOCTYPE rss>" + new TextDecoder().decode(rss(item(A)))), enc("<feed/>"), rss(), enc("not xml"),
      enc(`<rss><channel>${item(A).replace("<title>t", "<title>&mdash;")}</channel></rss>`)]) {
      expect(() => parseFeed(body)).toThrow(/nodesk/);
    }
    // Only the two observed entities are repaired.
    expect(parseFeed(enc(`<rss><channel>${item(A).replace("<title>t", "<title>&ndash;&rsquo;")}</channel></rss>`)).entries.length).toBe(1);
  });

  it("keeps unknown unknown: no location text, hours, budget or eligibility; a bad validThrough is an invalid deadline", () => {
    const l = parseArticle(job({ applicantLocationRequirements: { "@type": "Country", name: "Anywhere" }, validThrough: 5 }), entry());
    expect([l.location, l.weekly_hours, l.budget_min, l.taiwan_eligible, l.timezone_compatible, l.company, l.deadline]).toEqual([null, null, null, null, null, null, { kind: "invalid", text: "5" }]);
    expect(parseArticle(job({ employmentType: ["INTERN"] }), entry()).kind).toBeNull();
    expect(parseArticle(job({ validThrough: "2026-12-01" }), entry()).deadline).toEqual({ kind: "date", date: "2026-12-01" });
  });

  it("marks remote contract jobs kept; returns the rest marked (plan D9)", () => {
    const rule = (o: Record<string, unknown>) => kept(parseArticle(job(o), entry()));
    expect([rule({}), rule({ employmentType: "FULL_TIME" }), rule({ jobLocationType: "telecommute" }), rule({ jobLocationType: null }), rule({ employmentType: ["part_time"] })])
      .toEqual([true, false, false, false, true]);
  });

  it("sets aside a job page without its identity or a readable employment type", () => {
    for (const page of [enc(""), enc("<html>Pay or sign in</html>"), job({ title: "" }), job({ description: null }), job({ title: "x".repeat(501) }), job({ employmentType: [1] }), job({ employmentType: null }),
      enc('<script type="application/ld+json">{bad</script>')]) {
      expect(() => parseArticle(page, entry())).toThrow(/nodesk/);
    }
    expect(() => parseArticle(job(), entry("https://nodesk.co.evil/remote-jobs/acme-ai/"))).toThrow(/nodesk/);
  });
});

/** A fake Fetcher: a body or an HTTP status per URL, a request cap; anything else fails like a network error. */
const fakeFetcher = (pages: Record<string, Uint8Array | number>, cap = Infinity): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get(req) {
      if (urls.length >= cap) throw new FetchError("request_limit", "cap");
      urls.push(req.url);
      expect([req.maxBytes, req.timeoutMs, req.headers?.["User-Agent"]]).toEqual([2_000_000, 10_000, "side-income/0.1 personal-job-discovery"]);
      const p = pages[req.url];
      if (p === undefined) throw new Error("network");
      if (typeof p === "number") throw new FetchError("http_status", `HTTP ${p}`, p);
      return { status: 200, body: p, tier: "plain" };
    },
  };
};

describe("nodesk connector", () => {
  const feed = rss(item(A), item(B), item(C), item("https://nodesk.co/remote-jobs/old/", "Mon, 01 Jun 2026 00:00:00 GMT"));
  it("reads the feed, then the page of each job of the last 90 days", async () => {
    const f = fakeFetcher({ [FEED]: feed, [A]: job(), [B]: job({ employmentType: "FULL_TIME" }), [C]: job() });
    const got = await nodeskConnector(f, NOW);
    expect(f.urls).toEqual([FEED, A, B, C]);
    expect([got.seen, got.listings.map((l) => [l.external_id, got.sourceKept(l)]), got.rejected, got.examined, got.truncated]).toEqual([4, [[A, true], [B, false], [C, true]], 0, 4, false]);
  });

  it("sets aside a job whose page is missing (404) and keeps the others", async () => {
    const got = await nodeskConnector(fakeFetcher({ [FEED]: feed, [A]: job(), [B]: 404, [C]: job() }), NOW);
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([[A, C], 1, 4]);
  });

  it("fails on a forbidden page or an access challenge", async () => {
    await expect(nodeskConnector(fakeFetcher({ [FEED]: feed, [A]: job(), [B]: 403, [C]: job() }), NOW)).rejects.toThrow(/403/);
    await expect(nodeskConnector(fakeFetcher({ [FEED]: feed, [A]: enc("<title>Just a moment</title>"), [B]: job(), [C]: job() }), NOW)).rejects.toThrow(/challenge/);
    await expect(nodeskConnector(fakeFetcher({ [FEED]: 500 }), NOW)).rejects.toThrow(/500/);
  });

  it("stops at the request cap and marks the read truncated, keeping what was read", async () => {
    const got = await nodeskConnector(fakeFetcher({ [FEED]: feed, [A]: job(), [B]: job(), [C]: job() }, 2), NOW);
    expect([got.listings.map((l) => l.external_id), got.truncated, got.rejected]).toEqual([[A], true, 0]);
    expect(NODESK_SETTINGS.maxRequestsPerRun).toBe(21);
  });
});

describe("nodesk into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...NODESK_SETTINGS, order: 0 };
  const day = () => new Date(Date.now() - 86_400_000).toUTCString();
  const fresh = (...links: string[]) => rss(...links.map((l) => item(l, day())));

  it("writes every listing read, marked by the source's rule (plan D9)", async () => {
    const run = await collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: fresh(A, B), [A]: job(), [B]: job({ employmentType: "FULL_TIME" }) }));
    expect(run.externalIds).toEqual([A, B]);
    expect([(await listingBy(db, "nodesk", A))?.sourceKept, (await listingBy(db, "nodesk", B))?.sourceKept]).toEqual([true, false]);
  });

  it("writes the good jobs when one is set aside; nothing when more than half are; exactly half is written", async () => {
    expect((await collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: fresh(A, B, C), [A]: job(), [B]: 404, [C]: job() }))).rejected).toBe(1);
    await db.execute(sql`truncate listings cascade`);
    await expect(collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: fresh(A, B, C), [A]: job(), [B]: 404, [C]: job({ title: "" }) }))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "nodesk", A)).toBeNull();
    expect((await collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: fresh(A, B), [A]: job(), [B]: 404 }))).externalIds).toEqual([A]);
  });

  it("writes nothing when the source fails", async () => {
    await expect(collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: fresh(A, B), [A]: job(), [B]: 429 }))).rejects.toThrow(/429/);
    expect(await listingBy(db, "nodesk", A)).toBeNull();
  });

  it("a second run of the same pages adds no rows and changes nothing (D24)", async () => {
    const pages = { [FEED]: fresh(A, B), [A]: job(), [B]: job() };
    await collectSource(db, settings, new Date(), fakeFetcher(pages));
    expect((await collectSource(db, settings, new Date(), fakeFetcher(pages))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
