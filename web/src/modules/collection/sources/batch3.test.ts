import { describe, expect, it } from "vitest";
import { pyIsInstance } from "@/platform/errors";
import { dateFromIsoformat, PyDateTime } from "@/platform/py/datetime";
import { encode, rawDecode } from "@/platform/py/json";
import { pyFullmatch, pyMatch, pyRe, translate } from "@/platform/py/re";
import { codePoints, pyUpper } from "@/platform/py/unicode";
import { urljoin } from "@/platform/py/url";
import { asDict, py, PyError, type PyDict, type PyValue } from "@/platform/py/value";
import { attempt, attemptAsync, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import * as chickpt from "./chickpt";
import * as dynamitejobs from "./dynamitejobs";
import * as jobbank518 from "./jobbank518";
import { regexes as pageRegexes } from "./job-pages";
import * as justremote from "./justremote";
import * as nodesk from "./nodesk";

// Plan step 8, batch 3: nodesk.py, justremote.py, dynamitejobs.py, jobbank518.py and chickpt.py, plus
// the urljoin, str.upper, raw_decode, date.fromisoformat and re behaviour they rely on, against the
// ground truth gen_golden.py wrote with the production image's Python (3.13.15). Following batch 1's
// rule, error classes are compared only where a caller branches on them (each fetch's per-page catch);
// envelope failures, which every sync turns into one failed source, are compared as failures.

type Case<I, O> = { input: I; expect: Expect<O> };
type Pages = Record<string, [number, string]>;
type Span = { span: number[]; groups: (string | null)[] } | null;
const golden = fixture<{
  urljoin: { base: string; url: string; expect: Expect<string> }[];
  canonical_b3: { source: string; input: Tagged; expect: Expect<string> }[];
  py_upper: { input: string; expect: string }[];
  raw_decode: Case<string, [string, number]>[];
  date_iso: Case<string, string>[];
  b3_re: { pattern: string; ignorecase: boolean; dotall: boolean; mode: "fullmatch" | "search" | "match"; input: string; expect: Span }[];
  nodesk_feed: Case<string, { entries: nodesk.Entry[]; rejected: number; truncated: boolean }>[];
  nodesk_article: { input: string; entry: nodesk.Entry; expect: Expect<string> }[];
  justremote_index: Case<string, { entries: string[]; rejected: number }>[];
  justremote_article: { input: string; entry: Tagged; expect: Expect<string> }[];
  dynamitejobs_index: Case<string, string[]>[];
  dynamitejobs_article: { input: string; url: string; expect: Expect<string> }[];
  jobbank518_index: Case<string, string[]>[];
  jobbank518_article: Case<string, string>[];
  jobbank518_date: Case<Tagged, string>[];
  chickpt_index: Case<string, { urls: string[]; total: number }>[];
  chickpt_article: Case<string, string>[];
  page_fetch: { source: string; pages: Pages; expect: Expect<string> }[];
}>("golden.json");

const NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (latin1: string) => new Uint8Array(Buffer.from(latin1, "latin1"));
const failed = <T,>(e: Expect<T>) => ("error" in e ? { error: true } : e);
/** Mismatches of `run` against each case's expectation, failures compared as failures when `strict` is off. */
function mismatches<C extends { expect: Expect<unknown> }>(cases: C[], run: (c: C) => unknown, strict = false) {
  return cases.map((c) => ({ c, got: attempt(() => run(c)) })).filter(({ c, got }) => !same(strict ? got : failed(got), strict ? c.expect : failed(c.expect)));
}

/** The per-page catch of each fetch: `blocked` for an access challenge, `rejected` for the classes it counts, else the class. */
function classify(fn: () => PyDict, ...rejected: string[]): Expect<string> {
  try {
    return { ok: encode(fn()) };
  } catch (e) {
    if (pyIsInstance(e, "AccessBlocked")) return { error: "blocked" };
    if (pyIsInstance(e, ...rejected)) return { error: "rejected" };
    return { error: (e as { pyType?: string }).pyType ?? `JS:${(e as Error).message}` };
  }
}

describe("Python semantics the batch-3 sources use (CPython 3.13.15)", () => {
  it(`urljoin: ${golden.urljoin.length} base × reference pairs`, () => {
    expect(mismatches(golden.urljoin, (c) => urljoin(c.base, c.url), true)).toEqual([]);
  });
  it(`canonical(): ${golden.canonical_b3.length} values over the five sources`, () => {
    const canon: Record<string, (v: PyValue) => string> = {
      nodesk: nodesk.canonical, justremote: justremote.canonical, dynamitejobs: dynamitejobs.canonical, jobbank518: jobbank518.canonical, chickpt: chickpt.canonical,
    };
    expect(mismatches(golden.canonical_b3, (c) => canon[c.source](untag(c.input)), true)).toEqual([]);
  });
  it(`str.upper: ${golden.py_upper.length} strings`, () => {
    expect(golden.py_upper.filter((c) => pyUpper(c.input) !== c.expect)).toEqual([]);
  });
  it("\\Z is the very end: unlike $, it does not match before a final newline", () => {
    expect([pyRe(String.raw`a\Z`).test("a"), pyRe(String.raw`a\Z`).test("a\n"), pyRe("a$").test("a\n")]).toEqual([true, false, true]);
  });
  it(`JSONDecoder().raw_decode: ${golden.raw_decode.length} documents`, () => {
    expect(mismatches(golden.raw_decode, (c) => { const [v, end] = rawDecode(c.input); return [encode(v), end]; }, true)).toEqual([]);
  });
  it(`date.fromisoformat(...).isoformat(): ${golden.date_iso.length} strings`, () => {
    expect(mismatches(golden.date_iso, (c) => dateFromIsoformat(c.input), true)).toEqual([]);
  });
  it(`re fullmatch/search/match: ${golden.b3_re.length} pattern × input pairs, search patterns on the production objects`, () => {
    const production = [...Object.values(pageRegexes()), ...Object.values(jobbank518.regexes())];
    const run = (c: (typeof golden.b3_re)[number]) => {
      let m: RegExpExecArray | null;
      if (c.mode === "fullmatch") m = pyFullmatch(c.pattern, c.input);
      else if (c.mode === "match") {
        expect(c.pattern).toBe(chickpt.MONEY);
        m = pyMatch(chickpt.MONEY, c.input);
      } else {
        const re = production.find((r) => r.source === translate(c.pattern, c.ignorecase, c.dotall));
        expect(re, c.pattern).toBeDefined();
        m = re!.exec(c.input);
      }
      const cp = (i: number) => codePoints(c.input.slice(0, i)).length;
      return m && { span: [cp(m.index), cp(m.index + m[0].length)], groups: m.slice(1).map((g) => g ?? null) };
    };
    expect(golden.b3_re.filter((c) => !same(run(c), c.expect)).map((c) => ({ ...c, got: run(c) }))).toEqual([]);
  });
});

describe("nodesk matches Python", () => {
  it(`parse_feed: ${golden.nodesk_feed.length} feeds`, () => {
    expect(mismatches(golden.nodesk_feed, (c) => {
      const r = nodesk.parseFeed(bytes(c.input));
      return { entries: r.entries, rejected: Number(r.rejected), truncated: r.truncated };
    })).toEqual([]);
  });
  it(`parse_article: ${golden.nodesk_article.length} pages, as fetch's catch sees them`, () => {
    const bad = golden.nodesk_article.filter((c) => !same(classify(() => nodesk.parseArticle(bytes(c.input), c.entry), "ValueError", "OSError", "TimeoutError"), c.expect));
    expect(bad.map((c) => ({ input: c.input.slice(0, 300), expect: c.expect, got: classify(() => nodesk.parseArticle(bytes(c.input), c.entry), "ValueError", "OSError", "TimeoutError") }))).toEqual([]);
  });
});

describe("justremote matches Python", () => {
  it(`parse_index: ${golden.justremote_index.length} listing pages`, () => {
    expect(mismatches(golden.justremote_index, (c) => {
      const r = justremote.parseIndex(bytes(c.input));
      return { entries: r.entries.map((e) => encode(e)), rejected: Number(r.rejected) };
    }).map(({ c, got }) => ({ input: c.input.slice(0, 300), expect: c.expect, got }))).toEqual([]);
  });
  it(`parse_article: ${golden.justremote_article.length} pages, as fetch's catch sees them`, () => {
    const run = (c: (typeof golden.justremote_article)[number]) => classify(() => justremote.parseArticle(bytes(c.input), asDict(untag(c.entry))), "ValueError", "TypeError", "KeyError", "OSError");
    expect(golden.justremote_article.filter((c) => !same(run(c), c.expect)).map((c) => ({ input: c.input.slice(0, 300), expect: c.expect, got: run(c) }))).toEqual([]);
  });
});

describe("dynamitejobs matches Python", () => {
  it(`parse_index: ${golden.dynamitejobs_index.length} listing pages`, () => {
    expect(mismatches(golden.dynamitejobs_index, (c) => dynamitejobs.parseIndex(bytes(c.input)))).toEqual([]);
  });
  it(`parse_article: ${golden.dynamitejobs_article.length} pages, as fetch's catch sees them`, () => {
    const run = (c: (typeof golden.dynamitejobs_article)[number]) => classify(() => dynamitejobs.parseArticle(bytes(c.input), c.url), "ValueError", "TypeError", "KeyError", "OSError");
    expect(golden.dynamitejobs_article.filter((c) => !same(run(c), c.expect)).map((c) => ({ input: c.input.slice(0, 300), expect: c.expect, got: run(c) }))).toEqual([]);
  });
});

describe("jobbank518 matches Python", () => {
  it(`parse_index: ${golden.jobbank518_index.length} search pages`, () => {
    expect(mismatches(golden.jobbank518_index, (c) => jobbank518.parseIndex(bytes(c.input)))).toEqual([]);
  });
  it(`parse_article: ${golden.jobbank518_article.length} pages, as fetch's catch sees them`, () => {
    const run = (c: Case<string, string>) => classify(() => jobbank518.parseArticle(bytes(c.input), "https://www.518.com.tw/job-Ab1234.html"), "ValueError", "TypeError", "KeyError", "OSError");
    expect(golden.jobbank518_article.filter((c) => !same(run(c), c.expect)).map((c) => ({ input: c.input.slice(0, 300), expect: c.expect, got: run(c) }))).toEqual([]);
  });
  it(`date_value: ${golden.jobbank518_date.length} values`, () => {
    expect(mismatches(golden.jobbank518_date, (c) => jobbank518.dateValue(untag(c.input)), true)).toEqual([]);
  });
});

describe("chickpt matches Python", () => {
  it(`parse_index: ${golden.chickpt_index.length} category pages`, () => {
    expect(mismatches(golden.chickpt_index, (c) => {
      const r = chickpt.parseIndex(bytes(c.input));
      return { urls: r.urls, total: Number(r.total) };
    })).toEqual([]);
  });
  it(`parse_article: ${golden.chickpt_article.length} pages, as fetch's catch sees them (AttributeError fails the fetch)`, () => {
    const run = (c: Case<string, string>) => classify(() => chickpt.parseArticle(bytes(c.input), "https://www.chickpt.com.tw/job-Ab1234567890", NOW), "ValueError", "TypeError", "OSError");
    expect(golden.chickpt_article.filter((c) => !same(run(c), c.expect)).map((c) => ({ input: c.input.slice(0, 300), expect: c.expect, got: run(c) }))).toEqual([]);
  });
});

const FETCH: Record<string, (s: { request: (url: string) => Promise<{ status: number; body: Uint8Array }>; pause: () => Promise<void>; now: () => PyDateTime }) => Promise<PyDict>> = {
  nodesk: nodesk.fetchNoDesk, justremote: justremote.fetchJustRemote, dynamitejobs: dynamitejobs.fetchDynamiteJobs,
  jobbank518: jobbank518.fetchJobbank518, chickpt: chickpt.fetchChickpt,
};

describe("the five fetch() functions match Python over the same responses", () => {
  it(`${golden.page_fetch.length} response sets (urllib statuses: redirects, 4xx/5xx, network failures)`, async () => {
    const bad = [];
    for (const c of golden.page_fetch) {
      const request = async (url: string) => {
        if (!Object.hasOwn(c.pages, url)) throw new PyError("OSError", "unknown url " + url);
        return { status: c.pages[url][0], body: bytes(c.pages[url][1]) };
      };
      const got = failed(await attemptAsync(async () => encode(await FETCH[c.source]({ request, pause: async () => {}, now: () => NOW }))));
      if (!same(got, failed(c.expect))) bad.push({ source: c.source, expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------- the Python test cases (parse and fetch)
const enc = (s: string) => new Uint8Array(Buffer.from(s));
const nowIso = () => new Date().toISOString().replace("Z", "+00:00");
/** A request seam over {url: body | status}; records every URL it is asked for. */
function site(map: Record<string, Uint8Array | number>) {
  const calls: string[] = [];
  const request = async (url: string) => {
    calls.push(url);
    const hit = map[url];
    if (hit === undefined) throw new PyError("OSError", "unknown url " + url);
    return typeof hit === "number" ? { status: hit, body: new Uint8Array() } : { status: 200, body: hit };
  };
  return { calls, request };
}
const noPause = async () => {};

describe("nodesk (Python cases)", () => {
  const URL = "https://nodesk.co/remote-jobs/acme-ai-agent/";
  const feed = (description = "AI &ndash; agent &rsquo; work", url = URL) =>
    `<rss><channel><item><title>AI agent</title><description>${description}</description><link>${url}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
  it("the advertised feed's two entities are repaired; unknown entities and a DTD are rejected", () => {
    expect(nodesk.parseFeed(enc(feed())).entries.length).toBe(1);
    for (const raw of [feed("&unknown;"), feed().replace("<rss>", "<!DOCTYPE rss><rss>")]) expect(() => nodesk.parseFeed(enc(raw))).toThrow(PyError);
  });
  it("the canonical host is pinned and bad entries are counted", () => {
    expect(nodesk.parseFeed(enc(feed(undefined, "https://evil.example/remote-jobs/acme-ai-agent/"))).rejected).toBe(1n);
    expect(() => nodesk.parseArticle(enc("<script type=\"application/ld+json\">{}</script>"), { url: "https://nodesk.co.evil/remote-jobs/acme-ai-agent/", published_at: nowIso() })).toThrow(PyError);
  });
  it("a page without metadata is not a zero-jobs success", () => {
    expect(() => nodesk.parseArticle(enc("<html>Pay or sign in</html>"), { url: URL, published_at: nowIso() })).toThrow(PyError);
  });
  it("the source deadline stops before more page requests", async () => {
    // Python patches monotonic to [0, 0, 100]: start, the feed request, then the first page check.
    let t = 0;
    const { calls, request } = site({ [nodesk.FEED]: enc(feed()) });
    const pauses: number[] = [];
    const result = await nodesk.fetchNoDesk({ request: async (u, r) => { const out = await request(u); t = 89_500; return out; }, monotonic: () => t, pause: async (ms) => { pauses.push(ms); } });
    expect(result.at("rejected_count")).toBe(1n);
    expect(calls).toEqual([nodesk.FEED]);
    expect(pauses).toEqual([]);
  });
});

describe("justremote (Python cases)", () => {
  const entry = (changes: Record<string, unknown> = {}) => ({ id: 42, title: "AI agent API engineer", job_type: "contract", category: "developer",
    is_active: true, location_restrictions: [], href: "remote-developer-jobs/ai-agent-acme", url: "https://justremote.co/remote-developer-jobs/ai-agent-acme", ...changes });
  const detail = (changes: Record<string, unknown> = {}) => enc(`<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "AI agent API engineer",
    description: "<p>Build an AI agent API</p>", employmentType: "CONTRACTOR", datePosted: nowIso(), jobLocationType: "TELECOMMUTE", ...changes })}</script>`);
  const asEntry = (e: Record<string, unknown>) => asDict(py({ ...e, id: BigInt(e.id as number) }));

  it("the public state is parsed as JSON, never run, and a bad entry is isolated", () => {
    const data = { jobsState: { entity: { all: [entry(), entry({ id: 43, href: "https://evil.example/x" })] }, meta: { status: "success" } } };
    const raw = `<script>window.__PRELOADED_STATE__ = ${JSON.stringify(data)};</script>`;
    const { entries, rejected } = justremote.parseIndex(enc(raw));
    expect([entries.length, rejected]).toEqual([1, 1n]);
    expect(() => justremote.parseIndex(enc(raw.replace(";</script>", ";alert(1)</script>")))).toThrow(PyError);
    expect(() => justremote.parseIndex(enc("<h1>No jobs</h1>"))).toThrow(PyError);
    expect(() => justremote.canonical("https://justremote.co.evil.example/remote-developer-jobs/a-b")).toThrow(PyError);
  });
  it("regions stay unknown unless excluded, and full-time detail metadata wins", () => {
    expect(justremote.parseArticle(detail(), asEntry(entry({ location_restrictions: ["United States"] }))).at("taiwan_eligible")).toBe(false);
    const unknown = justremote.parseArticle(detail(), asEntry(entry()));
    for (const key of ["taiwan_eligible", "weekly_hours", "budget_min"]) expect(unknown.at(key)).toBeNull();
    expect(justremote.parseArticle(detail({ employmentType: "FULL_TIME" }), asEntry(entry())).at("kind")).toBe("full_time");
    expect(() => justremote.parseArticle(detail({ title: "Different job" }), asEntry(entry()))).toThrow(PyError);
  });
  it("the deadline counts the unread details as rejected", async () => {
    let t = 0;
    const data = { jobsState: { entity: { all: [entry(), entry({ id: 2, href: "remote-developer-jobs/second" })] }, meta: { status: "success" } } };
    const { request } = site({ [justremote.INDEX]: enc(`<script>window.__PRELOADED_STATE__ = ${JSON.stringify(data)}</script>`) });
    const result = await justremote.fetchJustRemote({ request: async (u) => { const out = await request(u); t = 89_000; return out; }, monotonic: () => t, pause: noPause });
    expect([result.at("rejected_count"), (result.at("jobs") as unknown[]).length]).toEqual([2n, 0]);
  });
});

describe("dynamitejobs (Python cases)", () => {
  const URL = "https://dynamitejobs.com/company/example/remote-job/ai-agent-engineer";
  const detail = (changes: Record<string, unknown> = {}) => enc(`<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "AI agent API engineer",
    description: "<p>Build an AI agent API.</p>", url: URL, employmentType: "CONTRACTOR", jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: [{ "@type": "Country", name: "Taiwan" }], datePosted: nowIso(), ...changes })}</script>`);
  const twoLinks = enc(`<a href="${URL}">a</a><a href="${URL}-two">b</a>`);

  it("canonical is strict and the index deduplicates", () => {
    expect(dynamitejobs.canonical(URL + "?utm_source=test#apply")).toBe(URL);
    expect(dynamitejobs.parseIndex(enc(`<a href="${URL}">job</a><a href="${URL}">job</a>`))).toEqual([URL]);
    for (const v of ["https://dynamitejobs.com.evil.example/company/a/remote-job/b", "https://dynamitejobs.com/api/jobs", "http://dynamitejobs.com/company/a/remote-job/b"]) {
      expect(() => dynamitejobs.canonical(v)).toThrow(PyError);
    }
    expect(() => dynamitejobs.parseIndex(enc("<h1>No recognized jobs</h1>"))).toThrow(PyError);
  });
  it("unknowns are preserved and an explicit region is excluded", () => {
    const job = dynamitejobs.parseArticle(detail(), URL);
    for (const key of ["taiwan_eligible", "weekly_hours", "budget_min"]) expect(job.at(key)).toBeNull();
    expect(job.at("body_available")).toBe(true);
    expect(dynamitejobs.parseArticle(detail({ applicantLocationRequirements: [{ "@type": "Country", name: "United States" }] }), URL).at("taiwan_eligible")).toBe(false);
  });
  it("a mismatched URL, missing body, bad location, date or employment type is rejected", () => {
    for (const changes of [{ url: URL + "-other" }, { description: "" }, { applicantLocationRequirements: "Worldwide" }, { datePosted: "yesterday" }, { employmentType: null }]) {
      expect(() => dynamitejobs.parseArticle(detail(changes), URL)).toThrow(PyError);
    }
  });
  it("an access block stops the remaining requests", async () => {
    for (const blocked of [enc("<title>Just a moment...</title>"), 403, 429]) {
      const { calls, request } = site({ [dynamitejobs.INDEX]: twoLinks, [URL]: blocked, [URL + "-two"]: detail() });
      await expect(dynamitejobs.fetchDynamiteJobs({ request, pause: noPause })).rejects.toBeInstanceOf(PyError);
      expect(calls).toEqual([dynamitejobs.INDEX, URL]);
    }
  });
  it("a bad detail is partial and the good one survives", async () => {
    const { request } = site({ [dynamitejobs.INDEX]: twoLinks, [URL]: detail(), [URL + "-two"]: enc("<h1>Missing metadata</h1>") });
    const result = await dynamitejobs.fetchDynamiteJobs({ request, pause: noPause });
    expect([result.at("seen"), result.at("rejected_count"), (result.at("jobs") as unknown[]).length, result.at("complete_scan")]).toEqual([2n, 1n, 1, false]);
  });
  it("the deadline stops reading details and marks the scan truncated", async () => {
    let t = 0;
    const { calls, request } = site({ [dynamitejobs.INDEX]: twoLinks, [URL]: detail(), [URL + "-two"]: detail() });
    const result = await dynamitejobs.fetchDynamiteJobs({ request: async (u) => { const out = await request(u); if (u === URL) t = 89_500; return out; }, monotonic: () => t, pause: noPause });
    expect(calls).toEqual([dynamitejobs.INDEX, URL]);
    expect([result.at("truncated"), result.at("rejected_count")]).toEqual([true, 0n]);
  });
});

describe("jobbank518 (Python cases)", () => {
  const URL = "https://www.518.com.tw/job-Ab1234.html";
  const index = (urls: string[], empty = false) => enc(`<h1>${jobbank518.CATEGORIES.join("、")} 的兼職工作職缺</h1>${urls.map((u) => `<a href="${u}">job</a>`).join("")}${empty ? "<p>抱歉沒有搜到適合的職缺</p>" : ""}`);
  it("an explicit empty result is distinct from a broken page or the wrong filter", () => {
    expect(jobbank518.parseIndex(index([], true))).toEqual([]);
    for (const raw of [enc("<h1>No data</h1>"), index([]), index([URL], true), enc(Buffer.from(index([URL])).toString().replace("兼職", "全職"))]) {
      expect(() => jobbank518.parseIndex(raw)).toThrow(PyError);
    }
  });
  it("URLs are strict and deduplicated; external ads are not jobs", () => {
    expect(jobbank518.canonical(URL + "?tracking=x#apply")).toBe(URL);
    expect(jobbank518.parseIndex(index([URL, URL, "https://www.tasker.com.tw/job-Ab1234.html"]))).toEqual([URL]);
    for (const v of ["http://www.518.com.tw/job-Ab1234.html", "https://www.518.com.tw.evil/job-Ab1234.html", "/job-index.html"]) expect(() => jobbank518.canonical(v)).toThrow(PyError);
  });
  it("an access block stops the remaining requests", async () => {
    const two = URL.replace("Ab1234", "Ab1235");
    for (const blocked of [enc("<title>Just a moment...</title>"), 401, 403, 429]) {
      const { calls, request } = site({ [jobbank518.INDEX]: index([URL, two]), [URL]: blocked });
      await expect(jobbank518.fetchJobbank518({ request, pause: noPause })).rejects.toBeInstanceOf(PyError);
      expect(calls).toEqual([jobbank518.INDEX, URL]);
    }
  });
});

describe("chickpt (Python cases)", () => {
  const URL = "https://www.chickpt.com.tw/job-Ab1234567890";
  const index = (urls: string[], total?: number) => enc(`<h1><span>電腦</span>接案任務</h1><span id="job-count">${total ?? urls.length}</span><ul id="job-list">${urls.map((u) => `<li><a href="${u}">task</a></li>`).join("")}</ul>`);
  const detail = (salary = "單次$5000", body = "Build an AI agent API", url = URL) => enc(`<meta property="og:url" content="${url}"><h1 id="job-h1-title">AI agent 開發</h1>`
    + `<div class="job_salary_address-block"><h2>${salary}</h2><h2>在家兼職</h2></div><section class="job-content"><p>任務內容</p><ul><li>${body}</li></ul></section>`
    + `<section class="job-work_time">工作日期：2026/09/20~2026/10/20</section><section class="similar"><p>無薪 FULL_TIME unrelated advertisement</p></section>`);
  it("the index checks the count and category and takes only listing links", () => {
    expect(chickpt.parseIndex(index([]))).toEqual({ urls: [], total: 0n });
    expect(chickpt.parseIndex(new Uint8Array([...index([URL]), ...enc(`<a href="${URL}extra">similar</a>`)]))).toEqual({ urls: [URL], total: 1n });
    for (const raw of [index([], 1), index([URL], 0), enc(Buffer.from(index([URL])).toString().replace("電腦", "其他")), enc("<h1>Unavailable</h1>")]) expect(() => chickpt.parseIndex(raw)).toThrow(PyError);
    for (const v of ["https://evil.example/job-Ab1234567890", "/ajax/jobs", "http://www.chickpt.com.tw/job-Ab1234567890"]) expect(() => chickpt.canonical(v)).toThrow(PyError);
  });
  it("the full body, not similar tasks; unknown dates stay unknown", () => {
    const job = chickpt.parseArticle(detail(), URL);
    expect(job.at("description")).toBe("Build an AI agent API");
    expect([job.at("budget_min"), job.at("budget_max")]).toEqual([5000n, 5000n]);
    for (const key of ["published_at", "deadline", "weekly_hours", "taiwan_eligible"]) expect(job.at(key)).toBeNull();
    expect(job.str("work_time_evidence")).toContain("2026/10/20");
  });
  it("an hourly rate, a range and bad budgets", () => {
    const hourly = chickpt.parseArticle(detail("時薪$500"), URL);
    expect([hourly.at("kind"), hourly.at("budget_max")]).toEqual(["hourly", null]);
    const range = chickpt.parseArticle(detail("單次$3,000 ~ $5,000"), URL);
    expect([range.at("budget_min"), range.at("budget_max")]).toEqual([3000n, 5000n]);
    expect(() => chickpt.parseArticle(detail("單次$0"), URL)).toThrow(PyError);
    expect(() => chickpt.parseArticle(detail(undefined, undefined, URL.replace("Ab", "Ac")), URL)).toThrow(PyError);
    expect(() => chickpt.parseArticle(detail(undefined, ""), URL)).toThrow(PyError);
  });
  it("an access block stops the remaining requests", async () => {
    for (const blocked of [401, 403, 429, enc("<title>Just a moment</title>")]) {
      const { calls, request } = site({ [chickpt.INDEX]: index([URL, URL.replace("Ab", "Ac")]), [URL]: blocked });
      await expect(chickpt.fetchChickpt({ request, pause: noPause })).rejects.toBeInstanceOf(PyError);
      expect(calls).toEqual([chickpt.INDEX, URL]);
    }
  });
});
