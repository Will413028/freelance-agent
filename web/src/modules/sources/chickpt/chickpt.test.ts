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
import { CHICKPT_SETTINGS, chickptConnector, INDEX, parseArticle, parseIndex, taskUrl } from ".";

// Plan step 5c: the golden index and task pages against the native connector, then its own rules.
// fixtures/cases.json was generated once from golden.json (chickpt_index, chickpt_article) at ce1254d
// by a throwaway generator (not committed): the old output mapped into the contract, every deliberate
// difference listed there by golden index with its reason and carried in each case's `why`.
// Differences: D8_UNKNOWN 3 (task budget $0, inverted or without digits: budget unknown, task kept),
// ACCEPTED 3 (bare class attribute on an index and a task page; duplicated id attribute keeps the first,
// per the HTML standard), PATCHED 1 (full-width digits in the amount: budget unknown), REFUSED 1 (result
// count in Arabic-Indic digits), SET_ASIDE 1 (a job-list link without href is set aside, not the index).

type IndexCase = { index: number; input: string; why?: string; expect: { error: true } | { blocked: true } | { urls: string[]; total: number; rejected: number } };
type ArticleCase = {
  index: number; input: string; why?: string;
  expect: { listing: unknown } | { setAside: true } | { blocked: true } | { unknown: readonly string[]; external_id: string; url: string } | { accepted: string; external_id: string; url: string };
};
const cases: { index: IndexCase[]; article: ArticleCase[] } = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const bytes = (s: string) => Buffer.from(s, "latin1");
const CK_URL = "https://www.chickpt.com.tw/job-Ab1234567890";

describe("chickpt over the golden pages", () => {
  it(`${cases.index.length} index pages give the expected links, refusal or challenge`, () => {
    const bad = cases.index.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseIndex(bytes(c.input));
      } catch (e) {
        const blocked = e instanceof AccessChallenge;
        return ("blocked" in c.expect && blocked) || ("error" in c.expect && !blocked) ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      return JSON.stringify(got) === JSON.stringify(c.expect) ? [] : [{ index: c.index, expect: c.expect, got }];
    });
    expect(bad).toEqual([]);
  });

  it(`${cases.article.length} task pages give the expected listing, set-aside, challenge or unknown field`, () => {
    const bad = cases.article.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseArticle(CK_URL, bytes(c.input));
      } catch (e) {
        const blocked = e instanceof AccessChallenge;
        return ("blocked" in c.expect && blocked) || ("setAside" in c.expect && !blocked) ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      const e = c.expect;
      const ok = "setAside" in e || "blocked" in e ? false : "listing" in e ? JSON.stringify(got) === JSON.stringify(e.listing)
        : got.external_id === e.external_id && got.url === e.url && ("accepted" in e || e.unknown.every((f) => got[f as keyof typeof got] === null));
      return ok ? [] : [{ index: c.index, expect: e, got }];
    });
    expect(bad).toEqual([]);
  });
});

const enc = (s: string) => new TextEncoder().encode(s);
const index = (urls: string[], total = urls.length) =>
  enc(`<h1><span>電腦</span>接案任務</h1><span id="job-count">${total}</span><ul id="job-list">${urls.map((u) => `<li><a href="${u}">task</a></li>`).join("")}</ul>`);
const task = (url: string, o: { salary?: string; title?: string; body?: string; og?: string } = {}) =>
  enc(`<meta property="og:url" content="${o.og ?? url}"><h1>${o.title ?? "AI agent 開發"}</h1><div class="job_salary_address-block"><h2>${o.salary ?? "單次$5000"}</h2></div>`
    + `<section class="job-content"><p>任務內容</p><p>${o.body ?? "Build an API"}</p></section><section class="job-work_time">工作日期：2026/09/20</section>`);
const url = (n: number) => `https://www.chickpt.com.tw/job-Ab${String(n).padStart(10, "0")}`;

describe("chickpt rules", () => {
  it("names one task by one id across spellings of its URL; a URL off the board is not a task", () => {
    for (const u of [CK_URL, "https://WWW.CHICKPT.com.tw/job-Ab1234567890", "https://www.chickpt.com.tw:443/job-Ab1234567890?from=list#x", " /job-Ab1234567890 "]) {
      expect(taskUrl(u)).toBe(CK_URL);
    }
    for (const u of ["http://www.chickpt.com.tw/job-Ab1234567890", "https://evil.example/job-Ab1234567890", "https://www.chickpt.com.tw/job-Ab123", "/ajax/jobs", "https://u:p@www.chickpt.com.tw/job-Ab1234567890", null]) {
      expect(taskUrl(u)).toBeNull();
    }
    expect(parseArticle("https://www.chickpt.com.tw:443/job-Ab1234567890", task(CK_URL, { og: "/job-Ab1234567890?x=1" })).external_id).toBe("Ab1234567890");
  });

  it("sets aside a link off the board between good ones, counting it", () => {
    expect(parseIndex(index([url(1), "https://evil.example/job-Ab1234567890", url(2)]))).toEqual({ urls: [url(1), url(2)], total: 3, rejected: 1 });
  });

  it("keeps unknown unknown: hourly or unstated pay has no budget; hours, eligibility, publication stay null", () => {
    const hourly = parseArticle(CK_URL, task(CK_URL, { salary: "時薪$200" }));
    expect([hourly.kind, hourly.budget_min, hourly.currency, hourly.compensation_evidence]).toEqual(["hourly", null, null, "時薪$200"]);
    const l = parseArticle(CK_URL, task(CK_URL, { salary: "面議" }));
    expect([l.kind, l.budget_min, l.budget_max, l.weekly_hours, l.taiwan_eligible, l.published_at, l.location, l.deadline]).toEqual([null, null, null, null, null, null, null, null]);
    expect(parseArticle(CK_URL, task(CK_URL, { salary: "單次$1,000~$2,000/次" }))).toMatchObject({ kind: "fixed", currency: "TWD", budget_min: 1000, budget_max: 2000 });
  });

  it("refuses a task page without its identity", () => {
    for (const o of [{ og: url(9) }, { title: "" }, { body: "" }, { title: "x".repeat(501) }]) expect(() => parseArticle(CK_URL, task(CK_URL, o))).toThrow(/chickpt/);
    expect(() => parseArticle("https://evil.example/job-Ab1234567890", task(CK_URL))).toThrow(/invalid task URL/);
  });

  it("has no rule of its own: every listing read is kept (plan D9; qualifyForIntake is evaluation's job)", async () => {
    const f = fakeFetcher({ [INDEX]: index([url(1), url(2)]), [url(1)]: task(url(1), { salary: "面議" }), [url(2)]: task(url(2), { salary: "時薪$1" }) });
    const got = await chickptConnector(f, new Date());
    expect(got.listings.map((l) => [l.external_id, l.kind, got.sourceKept(l)])).toEqual([["Ab0000000001", null, true], ["Ab0000000002", "hourly", true]]);
  });

  it("refuses an index that is not the category, lacks the count, or disagrees with it", () => {
    for (const body of [enc("<h1>Unavailable</h1>"), index([url(1)], 0), index([], 1), index(Array.from({ length: 201 }, (_, i) => url(i))), enc(""), new Uint8Array([0xff]), index([url(1)]).slice(0, 0)]) {
      expect(() => parseIndex(body)).toThrow(/chickpt/);
    }
  });
});

/** A fake Fetcher: one body per URL, a FetchError per URL, a request cap; anything else is a 404. */
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
      if (page instanceof FetchError) throw page;
      if (!page) throw new FetchError("http_status", "404", 404);
      return { status: 200, body: page, tier: "plain" };
    },
  };
};

describe("chickpt connector", () => {
  const now = new Date();
  it("reads the index, then each task in order; a detail 404 or bad page is set aside", async () => {
    const f = fakeFetcher({ [INDEX]: index([url(1), url(2), url(3)]), [url(1)]: task(url(1)), [url(3)]: task(url(3), { body: "" }) });
    const got = await chickptConnector(f, now);
    expect(f.urls).toEqual([INDEX, url(1), url(2), url(3)]);
    expect([got.seen, got.listings.map((l) => l.external_id), got.rejected, got.examined, got.truncated]).toEqual([3, ["Ab0000000001"], 2, 3, false]);
  });

  it("fails on a detail 401/403/429 or an access challenge; an index failure fails too", async () => {
    for (const bad of [new FetchError("http_status", "403", 403), new FetchError("http_status", "429", 429), enc("<title>Just a moment</title>")]) {
      await expect(chickptConnector(fakeFetcher({ [INDEX]: index([url(1), url(2)]), [url(1)]: task(url(1)), [url(2)]: bad }), now)).rejects.toThrow();
    }
    await expect(chickptConnector(fakeFetcher({}), now)).rejects.toThrow(FetchError);
    await expect(chickptConnector(fakeFetcher({ [INDEX]: enc("<h1>x</h1>") }), now)).rejects.toThrow(/chickpt/);
  });

  it("stops at the request cap and marks the read truncated, keeping what was read; more results than the page shows is truncated", async () => {
    const got = await chickptConnector(fakeFetcher({ [INDEX]: index([url(1), url(2)]), [url(1)]: task(url(1)), [url(2)]: task(url(2)) }, 2), now);
    expect([got.listings.length, got.truncated, got.rejected]).toEqual([1, true, 0]);
    const more = await chickptConnector(fakeFetcher({ [INDEX]: index([url(1)], 5), [url(1)]: task(url(1)) }), now);
    expect([more.listings.length, more.truncated]).toEqual([1, true]);
    expect(CHICKPT_SETTINGS.maxRequestsPerRun).toBe(201);
  });
});

describe("chickpt into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...CHICKPT_SETTINGS, order: 0 };
  const site = (good: number, bad: number) => {
    const urls = Array.from({ length: good + bad }, (_, i) => url(i + 1));
    return fakeFetcher(Object.fromEntries([[INDEX, index(urls)], ...urls.map((u, i) => [u, i < good ? task(u) : task(u, { title: "" })])]));
  };

  it("writes every task read; nothing when the index fails", async () => {
    const run = await collectSource(db, settings, new Date(), site(2, 0));
    expect([run.seen, run.externalIds]).toEqual([2, ["Ab0000000001", "Ab0000000002"]]);
    expect((await listingBy(db, "chickpt", "Ab0000000001"))?.sourceKept).toBe(true);
    await db.execute(sql`truncate listings cascade`);
    await expect(collectSource(db, settings, new Date(), fakeFetcher({ [INDEX]: enc("<h1>x</h1>") }))).rejects.toThrow(/chickpt/);
    expect(await listingBy(db, "chickpt", "Ab0000000001")).toBeNull();
  });

  it("refuses and writes nothing when more than half are set aside; exactly half is written", async () => {
    await expect(collectSource(db, settings, new Date(), site(1, 2))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "chickpt", "Ab0000000001")).toBeNull();
    const run = await collectSource(db, settings, new Date(), site(1, 1));
    expect([run.rejected, run.externalIds]).toEqual([1, ["Ab0000000001"]]);
  });

  it("a second run of the same pages adds no rows and changes nothing (D24)", async () => {
    await collectSource(db, settings, new Date(), site(2, 0));
    expect((await collectSource(db, settings, new Date(), site(2, 0))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
