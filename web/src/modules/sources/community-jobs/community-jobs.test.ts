import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { HACKERNEWS_SETTINGS, V2EX_SETTINGS } from ".";
import { hackernewsConnector, hnListing, parseV2ex, v2exConnector, v2exTopicId } from ".";

// Plan step 5a: the golden comments, fetch scenarios and feeds (fixtures/cases.json, written by
// fixtures/generate.ts (deleted in step 5a2 with legacyToInput, D10; see it at 9a68d6b) from legacyToInput of the old output) against the native connectors, then their own rules.

type Expected = { error: true } | { skip: true } | Record<string, unknown>;
type Pages = Record<string, [number, string]>;
type Cases = {
  hn_job: { index: number; p: unknown; parent: never; expect: Expected; why?: string }[];
  hn_fetch: { index: number; pages: Pages; expect: Expected; why?: string }[];
  v2ex_jobs: { index: number; input: string; expect: Expected; why?: string }[];
};
const cases: Cases = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
/** The time the golden cases were written against. */
const NOW = new Date("2026-09-28T01:00:00Z");

/** A fake Fetcher over {url: [status, latin-1 body]}; another status or an unknown URL fails as the real one does. */
const fakeFetcher = (pages: Pages): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get(req) {
      urls.push(req.url);
      if (!Object.hasOwn(pages, req.url)) throw new FetchError("network", "unknown url");
      const [status, body] = pages[req.url];
      if (status !== 200) throw new FetchError("http_status", `HTTP ${status}`, status);
      return { status, body: new Uint8Array(Buffer.from(body, "latin1")), tier: "plain" };
    },
  };
};

const outcome = async (fn: () => unknown) => {
  try {
    const r = await fn();
    return r === null ? { skip: true } : (r as Record<string, unknown>);
  } catch (e) {
    return { error: true, message: (e as Error).message } as Record<string, unknown>;
  }
};
const wrong = (e: Expected, got: Record<string, unknown>) =>
  "error" in e ? !("error" in got)
  : "unknown" in e ? "error" in got || "skip" in got || got[e.unknown as string] !== null
  : "listing" in e ? "error" in got || "skip" in got
  // examined (entries checked) is not in the old output, so the oracle cannot carry it; unit tests below check it.
  : JSON.stringify({ ...got, examined: undefined }) !== JSON.stringify(e);

describe("community-jobs connectors over the golden cases", () => {
  it(`hn_job: ${cases.hn_job.length} comments`, async () => {
    const bad = [];
    for (const c of cases.hn_job) {
      const got = await outcome(() => hnListing(c.p, c.parent));
      if (wrong(c.expect, got)) bad.push({ index: c.index, expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
  it(`hn_fetch: ${cases.hn_fetch.length} scenarios`, async () => {
    const bad = [];
    for (const c of cases.hn_fetch) {
      const got = await outcome(() => hackernewsConnector(fakeFetcher(c.pages), NOW));
      if (wrong(c.expect, got)) bad.push({ index: c.index, expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
  it(`v2ex_jobs: ${cases.v2ex_jobs.length} feeds`, async () => {
    const bad = [];
    for (const c of cases.v2ex_jobs) {
      const got = await outcome(() => parseV2ex(Buffer.from(c.input), NOW));
      if (wrong(c.expect, got)) bad.push({ index: c.index, expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

const comment = (o: Record<string, unknown> = {}) => ({ id: 11, type: "comment", parent: 1, time: 1790470800, text: "<p>Acme | Part-time contract | Remote</p><p>Build an API.</p>", ...o });
const json = (v: unknown): [number, string] => [200, JSON.stringify(v)];
const HN = "https://hacker-news.firebaseio.com/v0/";
const thread = (id: number, kids: number[], o: Record<string, unknown> = {}) => ({ id, by: "whoishiring", type: "story", title: "Ask HN: Who is hiring? (September 2026)", time: 1790125200, kids, ...o });
const hnPages = (threads: Record<string, unknown>[], comments: Record<string, unknown>[]): Pages => ({
  [HN + "user/whoishiring.json"]: json({ id: "whoishiring", submitted: threads.map((t) => t.id) }),
  ...Object.fromEntries(threads.map((t) => [`${HN}item/${t.id}.json`, json(t)])),
  ...Object.fromEntries(comments.map((c) => [`${HN}item/${c.id}.json`, json(c)])),
});

describe("hackernews", () => {
  it("keeps contract and part-time comments, skips seekers, full-time-only, deleted and other threads' comments", () => {
    expect(hnListing(comment(), 1)?.external_id).toBe("11");
    for (const o of [{ text: "SEEKING WORK | Remote | contract" }, { text: "Full-time only, no contractors" }, { text: "Acme | Full-time | Remote" },
      { deleted: true }, { parent: 2 }, { type: "story" }, { text: "Location: Taipei Remote: yes Willing to relocate: no contract" }]) {
      expect(hnListing(comment(o), 1)).toBeNull();
    }
  });

  it("refuses a comment without its identity; keeps an unreadable time unknown", () => {
    for (const o of [{ text: null }, { id: "11" }, { id: 1.5 }]) expect(() => hnListing(comment(o), 1)).toThrow(/hackernews/);
    expect(() => hnListing([], 1)).toThrow(/hackernews/);
    const l = hnListing(comment({ time: "soon" }), 1)!;
    expect([l.published_at, l.weekly_hours, l.budget_min, l.taiwan_eligible]).toEqual([null, null, null, null]);
    expect(hnListing(comment({ text: "Contract | Remote (EU) | Python" }), 1)!.taiwan_eligible).toBe(false);
  });

  it("reads the two latest recent hiring threads, at most 100 comments each, within the request cap", async () => {
    const kids = Array.from({ length: 101 }, (_, i) => 1000 + i);
    const threads = [thread(1, kids), thread(2, [21], { title: "Ask HN: Freelancer? Seeking freelancer?" }), thread(3, [31])];
    const comments = [...kids.map((id) => comment({ id, parent: 1 })), comment({ id: 21, parent: 2 }), comment({ id: 31, parent: 3 })];
    const f = fakeFetcher(hnPages(threads, comments));
    const got = await hackernewsConnector(f, NOW);
    expect([got.seen, got.listings.length, got.listings.at(-1)!.external_id, f.urls.length]).toEqual([101, 101, "21", 1 + 3 + 100 + 1]);
    expect(f.urls.length).toBeLessThanOrEqual(1 + 6 + 2 * 100);
    expect(await hackernewsConnector(fakeFetcher(hnPages(threads, comments)), NOW)).toEqual(got);
  });

  it("fails the run with nothing kept on an old thread only or a failed request", async () => {
    await expect(hackernewsConnector(fakeFetcher(hnPages([thread(1, [11], { time: 1700000000 })], [comment()])), NOW)).rejects.toThrow(/no recent/);
    await expect(hackernewsConnector(fakeFetcher(hnPages([thread(1, [11, 12])], [comment()])), NOW)).rejects.toThrow(FetchError);
    await expect(hackernewsConnector(fakeFetcher({ [HN + "user/whoishiring.json"]: [200, "<html>"] }), NOW)).rejects.toThrow(/not JSON/);
  });

  it("sets aside one comment without its identity and keeps the others (Will 2026-11-15)", async () => {
    for (const bad of [comment({ id: 12, text: null }), comment({ id: 12 })]) {
      const pages = hnPages([thread(1, [11, 13, 12])], [comment(), comment({ id: 13 }), bad]);
      // The second variant: comment 12 answers with an id that is no whole number.
      if (bad.text !== null) pages[HN + "item/12.json"] = json({ ...bad, id: 12.5 });
      const got = await hackernewsConnector(fakeFetcher(pages), NOW);
      // seen: the leads picked; examined: every comment checked, the threshold's denominator.
      expect([got.seen, got.rejected, got.examined, got.listings.map((l) => l.external_id)]).toEqual([2, 1, 3, ["11", "13"]]);
    }
  });

  it("counts every comment checked, picked or not, as examined, so a few set aside among many skipped do not refuse the source", async () => {
    const kids = Array.from({ length: 100 }, (_, i) => 1000 + i);
    const comments = kids.map((id, i) => comment({ id, ...(i < 4 ? {} : i < 9 ? { text: null } : { text: "<p>Acme | Full-time | Onsite</p>" }) }));
    const got = await hackernewsConnector(fakeFetcher(hnPages([thread(1, kids)], comments)), NOW);
    expect([got.seen, got.rejected, got.examined, got.listings.length]).toEqual([4, 5, 100, 4]);
  });
});

const entry = (o: { title?: string; href?: string | null; published?: string; content?: string } = {}) => {
  const v = { title: "招聘 Python 工程师", href: "https://www.v2ex.com/t/123456#reply3", published: "2026-09-27T12:00:00Z", content: "&lt;p&gt;需要 API 開發&lt;/p&gt;", ...o };
  return `<entry><title>${v.title}</title>${v.href === null ? "" : `<link rel="alternate" type="text/html" href="${v.href}"/>`}<published>${v.published}</published><content type="html">${v.content}</content></entry>`;
};
const atom = (...entries: string[]) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>V2EX</title>${entries.join("")}</feed>`);

describe("v2ex", () => {
  it("keeps recent posts asking for help, skips offers of service and old posts", () => {
    const got = parseV2ex(atom(entry(), entry({ title: "承接 Python 外包", href: "https://www.v2ex.com/t/2" }), entry({ title: "闲聊", href: "https://www.v2ex.com/t/3" }),
      entry({ href: "https://www.v2ex.com/t/4", published: "2026-06-01T00:00:00Z" })), NOW);
    expect([got.seen, got.listings.map((l) => [l.external_id, l.url, l.description, l.published_at])]).toEqual([1, [["123456", "https://www.v2ex.com/t/123456", "需要 API 開發", "2026-09-27T12:00:00.000Z"]]]);
  });

  it("sets aside a lead without one canonical link, a bad link or a time without zone, and keeps the others (Will 2026-11-15)", () => {
    for (const e of [entry({ href: null }), entry({ href: "https://v2ex.com/t/1" }), entry({ href: "https://www.v2ex.com/t/abc" }), entry({ published: "2026-09-27T12:00:00" }), entry({ published: "" })]) {
      const got = parseV2ex(atom(entry({ href: "https://www.v2ex.com/t/9" }), e, entry({ href: "https://www.v2ex.com/t/8" })), NOW);
      expect([got.seen, got.rejected, got.examined, got.listings.map((l) => l.external_id)]).toEqual([2, 1, 3, ["9", "8"]]);
    }
  });

  it("refuses a feed that declares a DTD, is not Atom, is not well-formed or holds over 100 entries", () => {
    for (const body of [new TextEncoder().encode("<!doctype feed><feed/>"), new TextEncoder().encode("<rss/>"), new TextEncoder().encode("<feed"), atom(...Array.from({ length: 101 }, () => "<entry/>"))]) {
      expect(() => parseV2ex(body, NOW)).toThrow(/v2ex/);
    }
  });

  it("reads the topic number with the standard URL parser: one id per topic, ASCII digits only", () => {
    expect(["https://www.v2ex.com/t/1?a=1", " https://www.v2ex.com/t/1", "HTTPS://www.v2ex.com/t/1", "https://WWW.v2ex.com/t/1", "https://www.v2ex.com:443/t/1"].map(v2exTopicId))
      .toEqual(["1", "1", "1", "1", "1"]);
    expect(["https://www.v2ex.com/t/١٢٣", "http://www.v2ex.com/t/1", "https://v2ex.com/t/1", "https://a@www.v2ex.com/t/1", "https://www.v2ex.com/t/1/x"].map(v2exTopicId))
      .toEqual([null, null, null, null, null]);
  });

  it("a post without body uses its title; unknown stays unknown; the same feed gives the same result", async () => {
    const pages: Pages = { "https://www.v2ex.com/feed/outsourcing.xml": [200, Buffer.from(atom(entry({ content: "" }))).toString("latin1")] };
    const f = fakeFetcher(pages);
    const got = await v2exConnector(f, NOW);
    const l = got.listings[0];
    expect([f.urls.length, l.description, l.extra, l.taiwan_eligible, l.budget_min]).toEqual([1, "招聘 Python 工程师", { body_available: false }, null, null]);
    expect(await v2exConnector(fakeFetcher(pages), NOW)).toEqual(got);
    await expect(v2exConnector(fakeFetcher({}), NOW)).rejects.toThrow(FetchError);
  });
});

describe("hackernews and v2ex into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const hn = { ...HACKERNEWS_SETTINGS, order: 0 }, v2 = { ...V2EX_SETTINGS, order: 0 };
  const V2EX_FEED = "https://www.v2ex.com/feed/outsourcing.xml";
  const v2exPages = (...entries: string[]): Pages => ({ [V2EX_FEED]: [200, Buffer.from(atom(...entries)).toString("latin1")] });
  const hnFixture = () => hnPages([thread(1, [11, 12])], [comment(), comment({ id: 12, text: "<p>Acme | Full-time | Onsite</p>" })]);

  it("writes only the leads the source's rule keeps", async () => {
    const a = await collectSource(db, hn, NOW, fakeFetcher(hnFixture()));
    expect(a.externalIds).toEqual(["11"]);
    expect(await listingBy(db, "hackernews", "12")).toBeNull();
    const b = await collectSource(db, v2, NOW, fakeFetcher(v2exPages(entry(), entry({ title: "承接 Python 外包", href: "https://www.v2ex.com/t/2" }))));
    expect(b.externalIds).toEqual(["123456"]);
    expect(await listingBy(db, "v2ex", "2")).toBeNull();
  });

  it("writes the others when one lead lacks its identity, and nothing when more than half do (Will 2026-11-15)", async () => {
    const one = await collectSource(db, hn, NOW, fakeFetcher(hnPages([thread(1, [11, 12])], [comment(), comment({ id: 12, text: null })])));
    expect([one.externalIds, one.rejected]).toEqual([["11"], 1]);
    await expect(collectSource(db, v2, NOW, fakeFetcher(v2exPages(entry(), entry({ href: "https://www.v2ex.com/t/x" }), entry({ href: "https://www.v2ex.com/t/y" }))))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "v2ex", "123456")).toBeNull();
  });

  it("writes the 4 picked leads when 5 of 100 comments lack text and 91 are skipped by the rules", async () => {
    const kids = Array.from({ length: 100 }, (_, i) => 1000 + i);
    const comments = kids.map((id, i) => comment({ id, ...(i < 4 ? {} : i < 9 ? { text: null } : { text: "<p>Acme | Full-time | Onsite</p>" }) }));
    const run = await collectSource(db, hn, NOW, fakeFetcher(hnPages([thread(1, kids)], comments)));
    expect([run.seen, run.rejected, run.examined, run.externalIds.length]).toEqual([4, 5, 100, 4]);
  });

  it("a second run of the same responses changes nothing", async () => {
    await collectSource(db, hn, NOW, fakeFetcher(hnFixture()));
    await collectSource(db, v2, NOW, fakeFetcher(v2exPages(entry())));
    expect((await collectSource(db, hn, NOW, fakeFetcher(hnFixture()))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
    expect((await collectSource(db, v2, NOW, fakeFetcher(v2exPages(entry())))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
  });
});
