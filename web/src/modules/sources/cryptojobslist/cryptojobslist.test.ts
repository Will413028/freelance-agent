import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetcher } from "@/platform/fetch";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { CRYPTOJOBSLIST_SETTINGS } from ".";
import { canonicalJobUrl, cryptojobslistConnector, FEED, parseFeed, parseItems, pubDateInstant } from ".";

// Plan step 5a: the golden feeds (fixtures/cases.json, written by generate.ts from legacyToInput of
// the old output) against the native connector, then the connector's own rules.

type Expected =
  | { error: true }
  | { seen: number; listings: Record<string, unknown>[] }
  | { seen: number; unknown: { external_id: string; field: string } }
  | { seen: number; ids: string[] };
type Case = { index: number; input: string; latin1?: boolean; expect: Expected; why?: string };
const cases: Case[] = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

const run = (c: Case) => {
  try {
    return parseItems(Buffer.from(c.input, c.latin1 ? "latin1" : "utf8"));
  } catch (e) {
    return { error: (e as Error).message };
  }
};

describe("cryptojobslist connector over the golden feeds", () => {
  it(`${cases.length} feeds give the expected listings or refusal`, () => {
    const wrong = (e: Expected, got: ReturnType<typeof run>) => {
      if ("error" in e) return !("error" in got);
      if ("error" in got) return true;
      if (got.seen !== e.seen) return true;
      if ("listings" in e) return JSON.stringify(got.listings) !== JSON.stringify(e.listings);
      if ("ids" in e) return JSON.stringify(got.listings.map((l) => l.external_id)) !== JSON.stringify(e.ids);
      const l = got.listings.find((x) => x.external_id === e.unknown.external_id) as Record<string, unknown> | undefined;
      return !l || l[e.unknown.field] !== null;
    };
    const bad = cases.map((c) => ({ c, got: run(c) })).filter(({ c, got }) => wrong(c.expect, got)).map(({ c, got }) => ({ index: c.index, expect: c.expect, got }));
    expect(bad).toEqual([]);
  });

  it("external_id equals the old canonical URL on every golden link the old reader accepted", () => {
    const pairs = cases.flatMap((c) => ("listings" in c.expect ? c.expect.listings.map((l) => l.external_id) : []));
    expect(pairs.length).toBeGreaterThan(50);
    for (const id of pairs) expect(canonicalJobUrl(id as string)).toBe(id);
  });
});

const item = (o: { link?: string; title?: string; description?: string; location?: string; pubDate?: string; canonical?: string } = {}) => {
  const v = { link: "https://cryptojobslist.com/jobs/backend-1", title: "Backend Engineer", location: "Remote", pubDate: "Sat, 24 Oct 2026 07:50:03 GMT",
    description: '<p>Tags: <a href="https://cryptojobslist.com/part-time">Part-time</a> <a href="https://cryptojobslist.com/remote">Remote</a></p><p>Build things.</p>', ...o };
  return `<item>${v.link === "" ? "" : `<link>${v.link}</link>`}<title><![CDATA[${v.title}]]></title><description><![CDATA[${v.description}]]></description>`
    + `${v.canonical ? `<media:canonical>${v.canonical}</media:canonical>` : ""}<media:location>${v.location}</media:location><pubDate>${v.pubDate}</pubDate></item>`;
};
const feed = (...items: string[]) => new TextEncoder().encode(`<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel>${items.join("")}</channel></rss>`);
const tagged = (...t: string[]) => `<p>Tags: ${t.map((x) => `<a href="https://cryptojobslist.com/${x}">${x}</a>`).join(" ")}</p><p>Body</p>`;

describe("cryptojobslist feed", () => {
  it("keeps only remote part-time or freelance jobs and counts every item seen", () => {
    const got = parseFeed(feed(
      item(),
      item({ link: "https://cryptojobslist.com/jobs/ft", description: tagged("full-time", "part-time", "remote") }),
      item({ link: "https://cryptojobslist.com/jobs/onsite", description: tagged("part-time"), location: "Berlin" }),
      item({ link: "https://cryptojobslist.com/jobs/smart", description: tagged("contract", "remote") }),
      item({ link: "https://cryptojobslist.com/jobs/free", description: tagged("freelance"), location: "Remote, worldwide" }),
    ));
    expect([got.seen, got.listings.map((l) => l.external_id)]).toEqual([5, ["https://cryptojobslist.com/jobs/backend-1", "https://cryptojobslist.com/jobs/free"]]);
    // Old `exists ||`: what the rule drops goes to others, for intake to refresh stored rows only.
    expect(got.others?.map((l) => l.external_id)).toEqual(["https://cryptojobslist.com/jobs/ft", "https://cryptojobslist.com/jobs/onsite", "https://cryptojobslist.com/jobs/smart"]);
  });

  it("keeps a job listed twice once, as its last entry; strips query and fragment from the id", () => {
    const got = parseItems(feed(item({ title: "First" }), item({ title: "Second", link: "https://cryptojobslist.com/jobs/backend-1?ref=x#y" })));
    expect([got.seen, got.listings.map((l) => [l.external_id, l.title])]).toEqual([2, [["https://cryptojobslist.com/jobs/backend-1", "Second"]]]);
  });

  it("refuses the whole feed when one item lacks its identity", () => {
    for (const bad of [{ link: "" }, { link: "https://cryptojobslist.com:443/jobs/x" }, { link: "https://CRYPTOJOBSLIST.com/jobs/x" }, { link: "https://cryptojobslist.com/jobs/x " },
      { title: "" }, { description: "<p></p>" }, { title: "x".repeat(501) }, { canonical: "https://cryptojobslist.com/jobs/other" }]) {
      expect(() => parseItems(feed(item({ link: "https://cryptojobslist.com/jobs/ok" }), item(bad)))).toThrow(/cryptojobslist/);
    }
  });

  it("refuses a body that is empty, oversize, has a DTD, is not XML or not RSS, or holds no items", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const body of [new Uint8Array(), new Uint8Array(2_000_001), enc('<!DOCTYPE rss><rss><channel>' + item() + "</channel></rss>"),
      enc("<html>"), enc("<feed><channel>" + item() + "</channel></feed>"), feed(), feed(...Array.from({ length: 2001 }, (_, i) => item({ link: `https://cryptojobslist.com/jobs/j${i}` })))]) {
      expect(() => parseItems(body)).toThrow(/cryptojobslist/);
    }
  });

  it("keeps unknown unknown: hours, budget, eligibility; a regional label excludes Taiwan; an unreadable date is null", () => {
    const [l] = parseItems(feed(item({ pubDate: "nonsense" }))).listings;
    expect([l.weekly_hours, l.budget_min, l.taiwan_eligible, l.published_at, l.location]).toEqual([null, null, null, null, "Remote"]);
    expect(parseItems(feed(item({ location: "Remote, US only" }))).listings[0].taiwan_eligible).toBe(false);
    expect(parseItems(feed(item())).listings[0].published_at).toBe("2026-10-24T07:50:03.000Z");
  });

  it("reads pubDate in ISO 8601 or RFC 2822 with a zone, and nothing without one", () => {
    expect(["Sat, 24 Oct 2026 15:50:03 +0800", "2026-10-24T07:50:03Z", "24 Oct 26 02:50:03 EST", "Sat, 24 Oct 2026 07:50:03 -0000", "2026-10-24T07:50:03", "31 Feb 2026 00:00:00 GMT"].map(pubDateInstant))
      .toEqual(["2026-10-24T07:50:03.000Z", "2026-10-24T07:50:03.000Z", "2026-10-24T07:50:03.000Z", null, null, null]);
  });
});

/** A fake Fetcher serving one body per URL; anything else fails like a network error. */
const fakeFetcher = (pages: Record<string, Uint8Array>): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get(req) {
      urls.push(req.url);
      if (!Object.hasOwn(pages, req.url)) throw new Error("network");
      return { status: 200, body: pages[req.url], tier: "plain" };
    },
  };
};

describe("cryptojobslist intake", () => {
  it("reads the feed in one request and gives only the listings its rule keeps; the same feed gives the same result", async () => {
    const body = feed(item(), item({ link: "https://cryptojobslist.com/jobs/ft", description: tagged("full-time", "remote") }));
    const f = fakeFetcher({ [FEED]: body });
    const a = await cryptojobslistConnector(f), b = await cryptojobslistConnector(fakeFetcher({ [FEED]: body }));
    expect([f.urls, a.seen, a.listings.map((l) => l.external_id)]).toEqual([[FEED], 2, ["https://cryptojobslist.com/jobs/backend-1"]]);
    expect(b).toEqual(a);
  });

  it("gives nothing when the feed fails or one item is broken", async () => {
    await expect(cryptojobslistConnector(fakeFetcher({}))).rejects.toThrow();
    await expect(cryptojobslistConnector(fakeFetcher({ [FEED]: feed(item(), item({ link: "" })) }))).rejects.toThrow(/cryptojobslist/);
  });
});

describe("cryptojobslist into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...CRYPTOJOBSLIST_SETTINGS, order: 0 };
  const body = () => feed(item(), item({ link: "https://cryptojobslist.com/jobs/ft", description: tagged("full-time", "remote") }));

  it("writes only listings the source's rule and screening keep", async () => {
    const run = await collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: body() }));
    expect([run.seen, run.externalIds]).toEqual([2, ["https://cryptojobslist.com/jobs/backend-1"]]);
    expect(await listingBy(db, "cryptojobslist", "https://cryptojobslist.com/jobs/ft")).toBeNull();
  });

  it("writes nothing when one item lacks its identity", async () => {
    await expect(collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: feed(item(), item({ link: "" })) }))).rejects.toThrow(/cryptojobslist/);
    expect(await listingBy(db, "cryptojobslist", "https://cryptojobslist.com/jobs/backend-1")).toBeNull();
  });

  it("a second run of the same feed changes nothing", async () => {
    await collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: body() }));
    expect((await collectSource(db, settings, new Date(), fakeFetcher({ [FEED]: body() }))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
  });
});
