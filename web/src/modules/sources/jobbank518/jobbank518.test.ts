import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { AccessChallenge } from "../shared/job-pages";
import { deadlineOf, INDEX, jobbank518Connector, JOBBANK518_SETTINGS, jobUrl, kept, parseArticle, parseIndex, postedOf } from ".";

// Plan step 5c: the golden index pages, detail pages and date values against the native connector,
// then the connector's own rules. fixtures/cases.json was generated once from golden.json's
// jobbank518_index, jobbank518_article and jobbank518_date at ce1254d by a throwaway generator (not
// committed): the old output mapped into the contract field by field, without calling this connector.
// Deliberate differences, each carried in its case's `why`:
//   D8_UNKNOWN 31 (article 12: datePosted, 更新日期 or validThrough unreadable, old rejected the page;
//     date 19: values the old date_value refused): the field is unknown, the listing is kept.
//   PATCHED 22 (article 18, date 4): a date-only datePosted has no zone, so published_at is unknown
//     and the date is kept in extra.posted_date (old stored the bare date as published_at).
//   SET_ASIDE 11: detail pages the old fetch rejected and counted; set aside and counted.
//   ACCEPTED 0, REFUSED 0.

type Listing = ReturnType<typeof parseArticle>;
const cases: {
  index: { index: number; input: string; expect: { urls: string[] } | { error: true } | { challenge: true } }[];
  article: { index: number; input: string; pageUrl: string; expect: { listing: Listing } | { setAside: true } | { challenge: true }; why?: string }[];
  date: { index: number; input: string; expect: { published_at: string | null; posted_date: string | null; deadline: unknown } }[];
} = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const bytes = (s: string) => Buffer.from(s, "latin1");

describe("jobbank518 over the golden pages", () => {
  it(`${cases.index.length} index pages give the expected job links or refusal`, () => {
    const bad = cases.index.flatMap((c): unknown[] => {
      try {
        const got = parseIndex(bytes(c.input));
        return "urls" in c.expect && JSON.stringify(got) === JSON.stringify(c.expect.urls) ? [] : [{ index: c.index, got }];
      } catch (e) {
        const ok = "challenge" in c.expect ? e instanceof AccessChallenge : "error" in c.expect && !(e instanceof AccessChallenge) && (e as Error).name === "SourceError";
        return ok ? [] : [{ index: c.index, error: (e as Error).message }];
      }
    });
    expect(bad).toEqual([]);
  });

  it(`${cases.article.length} detail pages give the expected listing, set-aside or challenge`, () => {
    const bad = cases.article.flatMap((c): unknown[] => {
      try {
        const got = parseArticle(bytes(c.input), c.pageUrl);
        if ("listing" in c.expect) {
          try {
            expect(got).toEqual(c.expect.listing);
            return [];
          } catch {
            return [{ index: c.index, expect: c.expect.listing, got }];
          }
        }
        return [{ index: c.index, expect: c.expect, got }];
      } catch (e) {
        const ok = "challenge" in c.expect ? e instanceof AccessChallenge : "setAside" in c.expect && !(e instanceof AccessChallenge) && ["SourceError", "ZodError"].includes((e as Error).name);
        return ok ? [] : [{ index: c.index, error: (e as Error).message }];
      }
    });
    expect(bad).toEqual([]);
  });

  it(`${cases.date.length} date values give the expected publication time and deadline`, () => {
    for (const c of cases.date) {
      const v = JSON.parse(c.input);
      expect([c.index, { ...postedOf(v), deadline: deadlineOf(v) }]).toEqual([c.index, c.expect]);
    }
  });
});

const NOW = new Date("2026-10-01T00:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);
const HEAD = "<h1>軟體設計工程師、Internet程式設計師、APP工程師、AI工程師 的兼職工作職缺</h1>";
const index = (...codes: string[]) => enc(HEAD + codes.map((c) => `<a href="/job-${c}.html">job</a>`).join(""));
const url = (code: string) => `https://www.518.com.tw/job-${code}.html`;
const post = (code: string, o: Record<string, unknown> = {}) => ({
  "@type": "JobPosting", title: "兼職 API 工程師", description: "<p>開發 API</p><br>職務類別<br>AI工程師<br>職缺條件<br>兼職",
  url: url(code), employmentType: ["PART_TIME"], datePosted: "2026-09-20", ...o,
});
const detail = (data: unknown) => enc(`<time>更新日期:2026-09-26</time><script type="application/ld+json">${JSON.stringify([data, { "@type": "BreadcrumbList" }])}</script>`);

describe("jobbank518 rules", () => {
  it("names one job by one id across spellings of its URL; a URL off the board or malformed is skipped", () => {
    for (const u of ["https://www.518.com.tw/job-Ab1234.html", "HTTPS://WWW.518.com.tw/job-Ab1234.html?x=1#y", "https://www.518.com.tw:443/job-Ab1234.html", " /job-Ab1234.html "]) {
      expect(jobUrl(u)).toBe("https://www.518.com.tw/job-Ab1234.html");
    }
    for (const u of ["http://www.518.com.tw/job-Ab1234.html", "https://www.tasker.com.tw/job-Ab1234.html", "https://www.518.com.tw/job-Ab12.html", "https://u:p@www.518.com.tw/job-Ab1234.html", "/job-Ab1234.html/x", "https://www.518.com.tw\\job-Ab1234.html", 5, null]) {
      expect(jobUrl(u)).toBeNull();
    }
    const a = parseArticle(detail(post("Ab1234")), "https://WWW.518.com.tw:443/job-Ab1234.html?ref=1");
    const b = parseArticle(detail(post("Ab1234", { url: "/job-Ab1234.html" })), url("Ab1234"));
    expect([a.external_id, b.external_id, a.url]).toEqual(["Ab1234", "Ab1234", url("Ab1234")]);
    expect(parseIndex(enc(HEAD + '<a href="https://www.518.com.tw/job-Ab12.html">x</a><a href="HTTPS://www.518.com.tw/job-Ab1234.html">y</a>'))).toEqual([url("Ab1234")]);
  });

  it("marks contract-kind jobs in the four software categories kept; returns the rest marked (plan D9)", () => {
    const l = (o: Record<string, unknown>) => parseArticle(detail(post("Ab1234", o)), url("Ab1234"));
    expect([
      kept(l({})), kept(l({ employmentType: ["FULL_TIME", "PART_TIME"] })), kept(l({ description: "文案<br>職務類別<br>網站行銷企劃<br>職缺條件<br>兼職" })),
      kept(l({ description: "<p>no category</p>" })), kept(l({ employmentType: "TEMPORARY" })),
    ]).toEqual([true, false, false, false, true]);
    expect(() => kept({ ...l({}), extra: { category: 5 } })).toThrow(/category/);
  });

  it("keeps unknown unknown: no zone means no instant, location, hours, budget and eligibility stay null", () => {
    const l = parseArticle(detail(post("Ab1234", { jobLocationType: "TELECOMMUTE" })), url("Ab1234"));
    expect([l.published_at, l.extra.posted_date, l.location, l.weekly_hours, l.budget_min, l.taiwan_eligible, l.timezone_compatible, l.extra.telecommute])
      .toEqual([null, "2026-09-20", null, null, null, null, null, true]);
    expect(parseArticle(detail(post("Ab1234", { datePosted: "2026-09-20T10:00:00+08:00" })), url("Ab1234")).published_at).toBe("2026-09-20T02:00:00.000Z");
  });

  it("refuses an index page that is not the confirmed search, ambiguous about being empty, or over 200 jobs", () => {
    expect(parseIndex(enc(HEAD + "<p>抱歉沒有搜到適合的職缺</p>"))).toEqual([]);
    const many = Array.from({ length: 201 }, (_, i) => `A${String(i).padStart(5, "0")}`);
    for (const body of [enc("<h1>No data</h1>"), enc(HEAD), index("Ab1234").slice(0, 0), enc(HEAD + '<a href="/job-Ab1234.html">x</a><p>抱歉沒有搜到適合的職缺</p>'), index(...many), new Uint8Array([0xff])]) {
      expect(() => parseIndex(body)).toThrow(/jobbank518/);
    }
    expect(parseIndex(index(...many.slice(0, 200))).length).toBe(200);
    expect(() => parseIndex(enc("<title>Just a moment</title>" + HEAD))).toThrow(AccessChallenge);
  });
});

/** A fake Fetcher: a body per URL, or a FetchError; the request cap is enforced like createFetcher. */
const fakeFetcher = (pages: Record<string, Uint8Array | FetchError>, cap = 201): Fetcher & { urls: string[] } => {
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
      if (p === undefined) throw new FetchError("http_status", "HTTP 404", 404);
      if (p instanceof FetchError) throw p;
      return { status: 200, body: p, tier: "plain" };
    },
  };
};
const site = (extra: Record<string, Uint8Array | FetchError> = {}, codes = ["Aa0001", "Aa0002", "Aa0003"]) => ({
  [INDEX]: index(...codes), ...Object.fromEntries(codes.map((c) => [url(c), detail(post(c))])), ...extra,
});

describe("jobbank518 connector", () => {
  it("reads the index, then each detail page", async () => {
    const f = fakeFetcher(site());
    const got = await jobbank518Connector(f, NOW);
    expect([got.seen, got.listings.map((l) => l.external_id), got.rejected, got.examined, got.truncated]).toEqual([3, ["Aa0001", "Aa0002", "Aa0003"], 0, 3, false]);
    expect(f.urls).toEqual([INDEX, url("Aa0001"), url("Aa0002"), url("Aa0003")]);
  });

  it("sets aside one bad listing between good ones (a 404, a page without its identity)", async () => {
    for (const bad of [new FetchError("http_status", "HTTP 404", 404), detail(post("Aa0002", { title: "" })), detail(post("Aa0009")), enc("<h1>Removed</h1>"), new FetchError("timeout", "t")]) {
      const got = await jobbank518Connector(fakeFetcher(site({ [url("Aa0002")]: bad })), NOW);
      expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([["Aa0001", "Aa0003"], 1, 3]);
    }
  });

  it("fails the source on a 401/403/429 or an access challenge on a detail page, and on a bad index", async () => {
    for (const bad of [new FetchError("http_status", "HTTP 403", 403), new FetchError("http_status", "HTTP 429", 429), enc("<title>Access denied</title>")]) {
      await expect(jobbank518Connector(fakeFetcher(site({ [url("Aa0002")]: bad })), NOW)).rejects.toThrow();
    }
    await expect(jobbank518Connector(fakeFetcher(site({ [INDEX]: enc("<h1>No data</h1>") })), NOW)).rejects.toThrow(/search filters/);
    await expect(jobbank518Connector(fakeFetcher({}), NOW)).rejects.toThrow(/404/);
  });

  it("stops at the request cap and marks the read truncated, keeping what was read", async () => {
    const got = await jobbank518Connector(fakeFetcher(site(), 3), NOW);
    expect([got.seen, got.listings.map((l) => l.external_id), got.truncated]).toEqual([3, ["Aa0001", "Aa0002"], true]);
  });
});

describe("jobbank518 into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...JOBBANK518_SETTINGS, order: 0 };
  const two = () => site({ [url("Aa0002")]: detail(post("Aa0002", { employmentType: ["FULL_TIME"] })) }, ["Aa0001", "Aa0002"]);

  it("writes every listing read, marked by the source's rule (plan D9)", async () => {
    const run = await collectSource(db, settings, new Date(), fakeFetcher(two()));
    expect([run.seen, run.externalIds, run.requests]).toEqual([2, ["Aa0001", "Aa0002"], 3]);
    expect([(await listingBy(db, "jobbank518", "Aa0001"))?.sourceKept, (await listingBy(db, "jobbank518", "Aa0002"))?.sourceKept]).toEqual([true, false]);
  });

  it("writes the good listings when one is set aside; nothing when more than half are; exactly half is written", async () => {
    const run = await collectSource(db, settings, new Date(), fakeFetcher(site({ [url("Aa0002")]: enc("<h1>Removed</h1>") })));
    expect([run.rejected, run.externalIds]).toEqual([1, ["Aa0001", "Aa0003"]]);
    await db.execute(sql`truncate listings cascade`);
    const removed = enc("<h1>Removed</h1>");
    await expect(collectSource(db, settings, new Date(), fakeFetcher(site({ [url("Aa0002")]: removed, [url("Aa0003")]: removed })))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "jobbank518", "Aa0001")).toBeNull();
    const half = await collectSource(db, settings, new Date(), fakeFetcher(site({ [url("Aa0002")]: removed }, ["Aa0001", "Aa0002"])));
    expect(half.externalIds).toEqual(["Aa0001"]);
  });

  it("writes nothing when the source fails", async () => {
    await expect(collectSource(db, settings, new Date(), fakeFetcher(site({ [url("Aa0003")]: new FetchError("http_status", "HTTP 403", 403) })))).rejects.toThrow(/403/);
    expect(await listingBy(db, "jobbank518", "Aa0001")).toBeNull();
  });

  it("a second run of the same pages adds no rows and changes nothing (D24)", async () => {
    const pages = two();
    await collectSource(db, settings, new Date(), fakeFetcher(pages));
    expect((await collectSource(db, settings, new Date(), fakeFetcher(pages))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
