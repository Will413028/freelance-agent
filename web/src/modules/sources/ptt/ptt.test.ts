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
import { CODEJOB, MAX_ARTICLES, parseArticle, parseIndex, postUrl, PTT_SOHO_SETTINGS, pttConnector, SOHO, type Entry } from ".";

// Plan step 8a. fixtures/cases.json ports the old Python tests' inputs and results (no recorded reference cases
// existed for PTT); the rest are this connector's own rules.

type Board = typeof SOHO;
const cases = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const NOW = new Date("2026-09-19T00:00:00Z");
const SECONDS = 1789626499; // 2026-09-17T06:28:19Z
const enc = (s: string) => new TextEncoder().encode(s);
const postPath = (b: Board, i = 0, hex = "2F9") => `/bbs/${b.board}/M.${SECONDS + i}.A.${hex}.html`;
const postAt = (b: Board, i = 0) => `https://www.ptt.cc${postPath(b, i)}`;
const indexPage = (b: Board, rows: [string, string][], previous: string | null = `/bbs/${b.board}/index1442.html`) =>
  enc(`<div class="r-list-container">${rows.map(([href, title]) => `<div class="r-ent"><div class="title"><a href="${href}">${title}</a></div><div class="meta"><div class="item"><a href="/bbs/${b.board}/search?q=x">搜尋同標題文章</a></div></div></div>`).join("")}</div>${previous ? `<a class="btn wide" href="${previous}">&lsaquo; 上頁</a>` : ""}`);
const article = (body = "工作內容：開發AI agent與後端API。\n案件預算：詳談") =>
  enc(`<div id="main-content"><div class="article-metaline"><span>作者 SECRET_AUTHOR</span></div><div class="article-metaline-right">SECRET_BOARD</div>${body}<span class="f2">※ 發信站：SECRET_IP</span><div class="push">已徵到 SECRET_COMMENT</div><script>SECRET_SCRIPT</script></div>`);
const entryOf = (b: Board, title = "[徵才] AI agent 後端 API"): Entry => parseIndex(b, indexPage(b, [[postPath(b), title]]), NOW).entries[0];

describe.each([[SOHO], [CODEJOB]])("%s.name index", (b) => {
  const fx = cases[b.name];
  it("takes the board's job posts in scope and leaves the rest (old title rules)", () => {
    const titles = (t: string) => parseIndex(b, indexPage(b, [[postPath(b), t]]), NOW).entries.map((e) => e.title);
    expect(fx.index.inScope.filter((t: string) => titles(t).length !== 1)).toEqual([]);
    expect(fx.index.outOfScope.filter((t: string) => titles(t).length !== 0)).toEqual([]);
    expect(fx.index.closedTitle.filter((t: string) => !entryOf(b, t).closedTitle)).toEqual([]);
    expect(entryOf(b, "[徵才] API").closedTitle).toBe(false);
  });

  it("names one post by one id across spellings of its link; links off the board, malformed or out of 90 days are skipped", () => {
    for (const u of [postPath(b), `HTTPS://WWW.PTT.CC:443${postPath(b)}`, ` ${postPath(b)}?q=1#x `]) expect(postUrl(b, u)).toBe(postAt(b));
    const other = b === SOHO ? CODEJOB : SOHO;
    for (const href of ["https://evil.invalid/case", postPath(other), `http://www.ptt.cc${postPath(b)}`, `/bbs/${b.board}/M.1471033318.A.3B2.html`, `/bbs/${b.board}/M.${SECONDS + 86_400 * 3}.A.2F9.html`, `/bbs/${b.board}/M.12.A.2F9.html`]) {
      // A recognized post out of scope beside it, so the page is not "no post link recognized".
      expect(parseIndex(b, indexPage(b, [[href, "[徵才] API"], [postPath(b, 1), "[自介] API"]]), NOW).entries).toEqual([]);
    }
    const e = entryOf(b, "[徵才]   AI\n agent ");
    expect(e).toEqual({ url: postAt(b), external_id: `M.${SECONDS}.A.2F9.html`, title: "[徵才] AI agent", published_at: "2026-09-17T06:28:19.000Z", closedTitle: false });
  });

  it("finds the page before only from the board's own link, and refuses a page without the post list", () => {
    expect(parseIndex(b, indexPage(b, []), NOW).previous).toBe(`/bbs/${b.board}/index1442.html`);
    expect(parseIndex(b, indexPage(b, [], "https://evil.invalid/index.html"), NOW).previous).toBeNull();
    for (const raw of [enc("<form action='/ask/over18'>over18</form>"), enc("captcha"), new Uint8Array([0xff]), new Uint8Array()]) expect(() => parseIndex(b, raw, NOW)).toThrow(b.name);
    expect(() => parseIndex(b, enc("<title>Just a moment</title><div class='r-list-container'></div>"), NOW)).toThrow(AccessChallenge);
    expect(() => parseIndex(b, indexPage(b, [[`/bbs/${b.board}/P.${SECONDS}.html`, "[徵才] API"], ["https://evil.invalid/x", "[徵才] API"]]), NOW)).toThrow(/no post link/);
    expect(parseIndex(b, indexPage(b, [[postPath(b), "[自介] API"]]), NOW).entries).toEqual([]);
  });
});

describe("post pages", () => {
  it("keeps the post's text only: no author, board, IP, comments or scripts", () => {
    const l = parseArticle(SOHO, article(), entryOf(SOHO));
    expect(l.description).toBe("工作內容：開發AI agent與後端API。\n案件預算：詳談");
    expect(JSON.stringify(l)).not.toContain("SECRET");
  });

  it("keeps text the poster colored green (class f2); drops only the site's ※ notes", () => {
    const l = parseArticle(SOHO, article('預算：<span class="f2">5 萬</span>\n<span class="f2">※ 編輯: SECRET_EDIT</span>'), entryOf(SOHO));
    expect(l.description).toBe("預算：5 萬");
  });

  it("keeps unknown unknown and the id time as the publication time", () => {
    const l = parseArticle(SOHO, article(), entryOf(SOHO));
    expect([l.budget_min, l.budget_max, l.weekly_hours, l.taiwan_eligible, l.timezone_compatible, l.deadline, l.currency, l.location, l.listing_closed, l.kind, l.published_at])
      .toEqual([null, null, null, null, null, null, null, null, false, "contract", "2026-09-17T06:28:19.000Z"]);
  });

  it.each([[SOHO], [CODEJOB]])("%s.name: a closing line closes the listing; 徵到為止 does not", (b) => {
    const fx = cases[b.name].closedBody;
    const closed = (body: string) => parseArticle(b, article(body), entryOf(b)).listing_closed;
    expect([fx.true.map(closed), fx.false.map(closed)]).toEqual([fx.true.map(() => true), fx.false.map(() => false)]);
    expect(parseArticle(b, article(), entryOf(b, cases[b.name].index.closedTitle[0])).listing_closed).toBe(true);
  });

  it("CodeJob reads employment evidence; negated, optional or incidental full-time stays contract", () => {
    const k = cases.ptt_codejob.kind;
    const kind = (body: string, title = "[發案] AI agent 後端 API") => parseArticle(CODEJOB, article(body), entryOf(CODEJOB, title)).kind;
    expect(k.full_time.bodies.map((s: string) => kind(`${s}\n開發後端 API`))).toEqual(k.full_time.bodies.map(() => "full_time"));
    expect(k.full_time.titles.map((t: string) => kind("開發後端 API", t))).toEqual(["full_time"]);
    expect(k.contract.notes.flatMap((n: string) => [kind(`${n}\n開發後端 API`), kind("開發後端 API", `[徵才] API ${n}`)])).toEqual(k.contract.notes.flatMap(() => ["contract", "contract"]));
    expect(k.contract.bodies.map((s: string) => kind(s))).toEqual(["contract"]);
    expect(parseArticle(SOHO, article("這是全職職缺\n開發 API"), entryOf(SOHO)).kind).toBe("contract");
  });

  it("refuses a page without the article or with a body out of bounds", () => {
    for (const raw of [enc("<html>removed</html>"), article(""), article("abcd"), article("x".repeat(100_001)), new Uint8Array([0xff])]) {
      expect(() => parseArticle(SOHO, raw, entryOf(SOHO))).toThrow("ptt_soho");
    }
    expect(parseArticle(SOHO, article("abcde"), entryOf(SOHO)).description).toBe("abcde");
    expect(() => parseArticle(SOHO, article(), { ...entryOf(SOHO), url: "https://evil.invalid/x" })).toThrow(/post URL/);
  });

  it("SOHO keeps posts naming technical work; CodeJob keeps every post in scope", () => {
    const fx = cases.ptt_soho.kept;
    const kept = (t: string) => SOHO.kept(parseArticle(SOHO, article(), entryOf(SOHO, t)));
    expect([fx.true.map(kept), fx.false.map(kept)]).toEqual([fx.true.map(() => true), fx.false.map(() => false)]);
    expect(CODEJOB.kept(parseArticle(CODEJOB, article(), entryOf(CODEJOB, "[發案] 海報設計")))).toBe(true);
  });
});

/** A fake Fetcher: a body per URL, or a FetchError; the request cap is enforced like createFetcher. */
const fakeFetcher = (pages: Record<string, Uint8Array | FetchError>, cap = PTT_SOHO_SETTINGS.maxRequestsPerRun): Fetcher & { urls: string[] } => {
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

const INDEX = "https://www.ptt.cc/bbs/soho/index.html", PREV = "https://www.ptt.cc/bbs/soho/index1442.html";
/** Posts 0..n-1 on the newest page, then posts n..n+m-1 on the page before (older ids), each with a page. */
function site(newest: number[], older: number[] = [], extra: Record<string, Uint8Array | FetchError> = {}) {
  const rows = (ids: number[]) => ids.map((i): [string, string] => [postPath(SOHO, i), "[徵才] 後端 API"]);
  return {
    [INDEX]: indexPage(SOHO, rows(newest)), [PREV]: indexPage(SOHO, rows(older), null),
    ...Object.fromEntries([...newest, ...older].map((i) => [postAt(SOHO, i), article()])), ...extra,
  };
}
const ids = (n: number[]) => n.map((i) => `M.${SECONDS + i}.A.2F9.html`);

describe("PTT connector", () => {
  it("reads two index pages, then each post newest first", async () => {
    const f = fakeFetcher(site([3, 4], [1, 4]));
    const got = await pttConnector(SOHO, f, NOW);
    expect([got.seen, got.listings.map((l) => l.external_id), got.rejected, got.examined, got.truncated]).toEqual([3, ids([4, 3, 1]), 0, 3, false]);
    expect(f.urls).toEqual([INDEX, PREV, postAt(SOHO, 4), postAt(SOHO, 3), postAt(SOHO, 1)]);
  });

  it("sets aside one bad post between good ones", async () => {
    for (const bad of [new FetchError("http_status", "HTTP 404", 404), enc("<html>removed</html>"), article(""), new FetchError("timeout", "t")]) {
      const got = await pttConnector(SOHO, fakeFetcher(site([1, 2, 3], [], { [postAt(SOHO, 2)]: bad })), NOW);
      expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([ids([3, 1]), 1, 3]);
    }
  });

  it("fails the source on a 401/403/429 or a challenge on a post, and on a bad index", async () => {
    for (const bad of [new FetchError("http_status", "HTTP 403", 403), new FetchError("http_status", "HTTP 429", 429), enc("<title>Access denied</title>")]) {
      await expect(pttConnector(SOHO, fakeFetcher(site([1, 2], [], { [postAt(SOHO, 2)]: bad })), NOW)).rejects.toThrow();
    }
    await expect(pttConnector(SOHO, fakeFetcher(site([1], [], { [INDEX]: enc("<form>over18</form>") })), NOW)).rejects.toThrow(/post list/);
    await expect(pttConnector(SOHO, fakeFetcher({}), NOW)).rejects.toThrow(/404/);
    await expect(pttConnector(SOHO, fakeFetcher(site([1], [], { [INDEX]: indexPage(SOHO, [[postPath(SOHO, 1), "[徵才] API"]], null) })), NOW)).rejects.toThrow(/previous page link/);
  });

  it(`reads at most ${MAX_ARTICLES} posts and marks more in scope as truncated`, async () => {
    const many = Array.from({ length: MAX_ARTICLES + 2 }, (_, i) => i);
    const f = fakeFetcher(site(many));
    const got = await pttConnector(SOHO, f, NOW);
    expect([got.seen, got.listings.length, got.truncated, f.urls.length]).toEqual([MAX_ARTICLES + 2, MAX_ARTICLES, true, 2 + MAX_ARTICLES]);
    expect(got.listings[0].external_id).toBe(ids([MAX_ARTICLES + 1])[0]);
    // The limit is the connector's own, not only the request cap's.
    const loose = await pttConnector(SOHO, fakeFetcher(site(many), 100), NOW);
    expect([loose.listings.length, loose.truncated]).toEqual([MAX_ARTICLES, true]);
  });

  it("reads open posts before posts closed by their title", async () => {
    const rows: [string, string][] = [[postPath(CODEJOB, 1), "[發案] API"], [postPath(CODEJOB, 3), "[已解決] API"], [postPath(CODEJOB, 2), "[發案] 網站"]];
    const at = (i: number) => `https://www.ptt.cc${postPath(CODEJOB, i)}`;
    const f = fakeFetcher({
      "https://www.ptt.cc/bbs/CodeJob/index.html": indexPage(CODEJOB, rows), "https://www.ptt.cc/bbs/CodeJob/index1442.html": indexPage(CODEJOB, [], null),
      [at(1)]: article(), [at(2)]: article(), [at(3)]: article(),
    });
    const got = await pttConnector(CODEJOB, f, NOW);
    expect([got.listings.map((l) => [l.external_id, l.listing_closed]), got.truncated]).toEqual([[[`M.${SECONDS + 2}.A.2F9.html`, false], [`M.${SECONDS + 1}.A.2F9.html`, false], [`M.${SECONDS + 3}.A.2F9.html`, true]], false]);
  });

  it("stops at the request cap and marks the read truncated, keeping what was read", async () => {
    const got = await pttConnector(SOHO, fakeFetcher(site([1, 2, 3]), 4), NOW);
    expect([got.listings.map((l) => l.external_id), got.truncated]).toEqual([ids([3, 2]), true]);
  });
});

describe("PTT into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...PTT_SOHO_SETTINGS, order: 0, connector: (f: Fetcher) => pttConnector(SOHO, f, NOW) };
  const two = () => ({
    [INDEX]: indexPage(SOHO, [[postPath(SOHO, 1), "[徵才] 後端 API"], [postPath(SOHO, 2), "[徵才] 商品攝影"]]), [PREV]: indexPage(SOHO, [], null),
    [postAt(SOHO, 1)]: article(), [postAt(SOHO, 2)]: article("拍攝商品照片十張"),
  });

  it("writes every post read, marked by the source's rule (plan D9)", async () => {
    const run = await collectSource(db, settings, NOW, fakeFetcher(two()));
    expect([run.seen, run.externalIds, run.requests]).toEqual([2, ids([2, 1]), 4]);
    expect([(await listingBy(db, "ptt_soho", ids([1])[0]))?.sourceKept, (await listingBy(db, "ptt_soho", ids([2])[0]))?.sourceKept]).toEqual([true, false]);
  });

  it("writes the good posts when one is set aside; nothing when more than half are; exactly half is written", async () => {
    const removed = enc("<html>removed</html>");
    const run = await collectSource(db, settings, NOW, fakeFetcher(site([1, 2, 3], [], { [postAt(SOHO, 2)]: removed })));
    expect([run.rejected, run.externalIds]).toEqual([1, ids([3, 1])]);
    await db.execute(sql`truncate listings cascade`);
    await expect(collectSource(db, settings, NOW, fakeFetcher(site([1, 2, 3], [], { [postAt(SOHO, 2)]: removed, [postAt(SOHO, 3)]: removed })))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "ptt_soho", ids([1])[0])).toBeNull();
    const half = await collectSource(db, settings, NOW, fakeFetcher(site([1, 2], [], { [postAt(SOHO, 2)]: removed })));
    expect(half.externalIds).toEqual(ids([1]));
  });

  it("writes nothing when the source fails", async () => {
    await expect(collectSource(db, settings, NOW, fakeFetcher(site([1, 2], [], { [postAt(SOHO, 1)]: new FetchError("http_status", "HTTP 403", 403) })))).rejects.toThrow(/403/);
    expect(await listingBy(db, "ptt_soho", ids([2])[0])).toBeNull();
  });

  it("a second run of the same pages adds no rows and changes nothing (D24)", async () => {
    const pages = two();
    await collectSource(db, settings, NOW, fakeFetcher(pages));
    expect((await collectSource(db, settings, NOW, fakeFetcher(pages))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
