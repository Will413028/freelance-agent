import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { canonicalJobUrl, FEEDS, kept, normalize, parseFeed, parseItems, publicFeedConnector, REMOTEOK_SETTINGS, type FeedName } from ".";
import type { BatchCase, NormalizeCase } from "./fixtures/generate";

// Plan step 5b: the golden entries and feeds (fixtures/cases.json, written by fixtures/generate.ts from
// the old output, with its list of deliberate differences) against the native connector, then the
// connector's own rules.

const cases: { normalize: NormalizeCase[]; batch: BatchCase[] } = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

describe("public feeds over the golden entries and feeds", () => {
  it(`${cases.normalize.length} entries give the expected listing, set-aside or unknown field`, () => {
    const bad = cases.normalize.flatMap((c): unknown[] => {
      let got;
      try {
        got = normalize(c.source as FeedName, JSON.parse(c.input));
      } catch (e) {
        return "setAside" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      const e = c.expect;
      const ok = "setAside" in e ? false : "listing" in e ? JSON.stringify(got) === JSON.stringify(e.listing)
        : got.external_id === e.external_id && got.url === e.url && ("accepted" in e || e.unknown.every((f) => got[f as keyof typeof got] === null));
      return ok ? [] : [{ index: c.index, expect: e, got }];
    });
    expect(bad).toEqual([]);
  });

  it(`${cases.batch.length} feeds give the expected listings or refusal`, () => {
    const bad = cases.batch.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseItems(c.source as FeedName, Buffer.from(c.input, "latin1"));
      } catch (e) {
        return "error" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      const e = c.expect;
      if ("error" in e) return [{ index: c.index, expect: e, got: got.seen }];
      const same = got.seen === e.seen && Boolean(got.truncated) === e.truncated && (got.rejected ?? 0) === e.rejected
        && ("listings" in e ? JSON.stringify(got.listings) === JSON.stringify(e.listings)
          : JSON.stringify(got.listings.map((l) => l.external_id)) === JSON.stringify(e.ids) && got.listings.every((l) => e.unknown.every((f) => l[f as keyof typeof l] === null)));
      return same ? [] : [{ index: c.index, expect: e, got }];
    });
    expect(bad).toEqual([]);
  });

  it("covers all four feeds, and every job URL the old reader accepted names one id, stable when read again", () => {
    expect(new Set([...cases.normalize, ...cases.batch].map((c) => c.source))).toEqual(new Set(Object.keys(FEEDS)));
    const urls = cases.normalize.flatMap((c) => ("listing" in c.expect ? [[c.source, (c.expect.listing as { url: string }).url] as const] : []));
    expect(urls.length).toBeGreaterThan(50);
    for (const [s, u] of urls) {
      const id = canonicalJobUrl(s as FeedName, u);
      expect(id).not.toBeNull();
      expect(canonicalJobUrl(s as FeedName, id)).toBe(id);
    }
  });
});

const NOW = new Date("2026-10-01T00:00:00Z");
const job = (o: Record<string, unknown> = {}) => ({
  id: "123", position: "Contract API engineer", description: "<p>Build APIs.</p>", url: "https://remoteok.com/remote-jobs/api-123",
  tags: ["contract"], date: "2026-09-18T12:00:00+00:00", location: "Worldwide", ...o,
});
const json = (...entries: unknown[]) => new TextEncoder().encode(JSON.stringify([{ legal: "Link back to Remote OK" }, ...entries]));
const item = (o: { title?: string; link?: string; pubDate?: string; extra?: string } = {}) => {
  const v = { title: "Part-time Backend developer", link: "https://weworkremotely.com/remote-jobs/acme-backend", pubDate: "Fri, 18 Sep 2026 12:00:00 +0000", ...o };
  return `<item><title><![CDATA[${v.title}]]></title><description><![CDATA[<p>Build APIs.</p>]]></description><link>${v.link}</link><pubDate>${v.pubDate}</pubDate>`
    + `<region>Anywhere</region><category>Programming</category>${v.extra ?? ""}</item>`;
};
const rss = (...items: string[]) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>WWR</title>${items.join("")}</channel></rss>`);

describe("public feed rules", () => {
  it("marks contract or part-time jobs of the last 90 days kept; returns the rest marked (plan D9)", () => {
    const got = parseFeed("remoteok", json(
      job(), job({ id: "2", url: "https://remoteok.com/remote-jobs/2", position: "Full-time engineer", tags: [] }),
      job({ id: "3", url: "https://remoteok.com/remote-jobs/3", date: "2026-06-01T00:00:00Z" }), job({ id: "4", url: "https://remoteok.com/remote-jobs/4", date: "2026-10-02T00:00:00Z" }),
    ), NOW);
    expect([got.seen, got.listings.map((l) => [l.external_id, got.sourceKept(l)])]).toEqual([4, [["123", true], ["2", false], ["3", false], ["4", false]]]);
    expect(kept({ ...got.listings[0], published_at: "2026-07-03T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("reads the employment type from title, tags and explicit body statements, not smart contracts; full time wins", () => {
    const kind = (o: Record<string, unknown>) => normalize("remoteok", job(o)).kind;
    expect([
      kind({}), kind({ position: "Engineer", tags: [] }), kind({ position: "Smart contract engineer", tags: [] }),
      kind({ position: "Engineer", tags: [], description: "<p>Employment type: part-time</p>" }), kind({ description: "<p>This is a full-time role.</p>" }),
    ]).toEqual(["contract", null, null, "contract", "full_time"]);
  });

  it("keeps unknown unknown: a location that is not text is null, hours, budget and eligibility stay null", () => {
    const l = normalize("remoteok", job({ location: 5 }));
    expect([l.location, l.weekly_hours, l.budget_min, l.taiwan_eligible]).toEqual([null, null, null, null]);
    expect(normalize("remoteok", job({ location: "Worldwide" })).taiwan_eligible).toBeNull();
  });

  it("names one job by one id across spellings of its URL; a URL off the board is set aside", () => {
    expect(normalize("weworkremotely", { title: "t", description: "d", url: "https://WeWorkRemotely.com/remote-jobs/caf\u00e9?x=1", date: "2026-09-18T12:00:00Z", tags: [] }))
      .toMatchObject({ external_id: "https://weworkremotely.com/remote-jobs/caf%C3%A9", url: "https://weworkremotely.com/remote-jobs/caf\u00e9" });
    for (const u of ["https://REMOTEOK.com/remote-jobs/a?ref=x#y", "https://remoteok.com:443/remote-jobs/a", " https://remoteok.com/remote-jobs/a "]) {
      expect(canonicalJobUrl("remoteok", u)).toBe("https://remoteok.com/remote-jobs/a");
    }
    for (const u of ["https://remoteok.com\\remote-jobs\\a", "https://remoteok.com/remote-\tjobs/a", "http://remoteok.com/remote-jobs/a", "https://evil.example/remote-jobs/a", "https://remoteok.com/remote-jobs/", "https://u:p@remoteok.com/remote-jobs/a", "https://remoteok.com:8443/remote-jobs/a"]) {
      expect(canonicalJobUrl("remoteok", u)).toBeNull();
    }
    expect([canonicalJobUrl("workingnomads", "https://www.workingnomads.com/job/go/12/"), canonicalJobUrl("workingnomads", "https://www.workingnomads.com/job/go/x/")])
      .toEqual(["https://www.workingnomads.com/job/go/12/", null]);
  });

  it("sets aside and counts an entry without its identity, keeping the others", () => {
    for (const bad of [{ url: "https://evil.example/remote-jobs/x" }, { id: "12a" }, { id: -1 }, { id: 2 ** 53 }, { position: "" }, { description: "<p> </p>" }, { position: "x".repeat(501) }, { url: 5 },
      // The source's rule reads these two, so unreadable means set aside.
      { tags: "contract" }, { tags: [1] }, { date: "2026-09-18T12:00:00" }, { date: "nonsense" }, { date: null }]) {
      const got = parseItems("remoteok", json(job({ id: "1", url: "https://remoteok.com/remote-jobs/ok" }), job(bad)));
      expect([got.seen, got.rejected, got.examined, got.listings.map((l) => l.external_id)]).toEqual([2, 1, 2, ["1"]]);
    }
  });

  it("keeps a job listed twice once, as its last entry", () => {
    const got = parseItems("remoteok", json(job({ position: "First contract" }), job({ position: "Second contract" })));
    expect([got.seen, got.listings.map((l) => l.title)]).toEqual([2, ["Second contract"]]);
  });

  it("reads at most 200 entries and marks the read truncated when the feed has more", () => {
    const many = Array.from({ length: 201 }, (_, i) => job({ id: String(i), url: `https://remoteok.com/remote-jobs/${i}` }));
    const got = parseItems("remoteok", json(...many));
    expect([got.seen, got.listings.length, got.truncated]).toEqual([200, 200, true]);
    expect(parseItems("remoteok", json(...many.slice(0, 200))).truncated).toBe(false);
  });

  it("reads Working Nomads' comma-separated tags and pub_date", () => {
    const l = normalize("workingnomads", { url: "https://www.workingnomads.com/job/go/7/", title: "Engineer", description: "<p>x</p>", tags: "python, freelance", pub_date: "2026-09-18T12:00:00Z" });
    expect([l.external_id, l.kind, l.published_at]).toEqual(["https://www.workingnomads.com/job/go/7/", "contract", "2026-09-18T12:00:00.000Z"]);
  });

  it("reads RSS items, repairing only naked ampersands in enclosure URLs", () => {
    const enclosure = '<enclosure url="https://cdn.example/logo.png?w=1&h=2" type="image/png"/>';
    const got = parseItems("weworkremotely", rss(item({ extra: enclosure })));
    expect([got.seen, got.listings.map((l) => [l.external_id, l.kind, l.location, l.published_at])])
      .toEqual([1, [["https://weworkremotely.com/remote-jobs/acme-backend", "contract", "Anywhere", "2026-09-18T12:00:00.000Z"]]]);
    expect(() => parseItems("weworkremotely", rss(item({ title: "a & b" }).replace("<![CDATA[a & b]]>", "a & b")))).toThrow(/well-formed/);
  });

  it("refuses a feed that is empty, oversize, not the expected shape, empty of entries, or declares a DTD", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const [name, body] of [["remoteok", enc(" \n")], ["remoteok", new Uint8Array(8_000_001)], ["remoteok", enc("{}")], ["remoteok", enc("[nope")], ["remoteok", enc('[{"legal": "x"}]')],
      ["workingnomads", enc("[]")], ["weworkremotely", enc('<!DOCTYPE rss><rss><channel>' + item() + "</channel></rss>")], ["weworkremotely", enc("<feed></feed>")],
      ["weworkremotely", rss()], ["realworkfromanywhere", new Uint8Array([0xff, 0xfe])]] as const) {
      expect(() => parseItems(name, body)).toThrow(new RegExp(name));
    }
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

describe("public feed connector", () => {
  it("reads each feed in one request from its endpoint", async () => {
    const f = fakeFetcher({ [FEEDS.weworkremotely.endpoint]: rss(item()) });
    expect((await publicFeedConnector("weworkremotely", f, NOW)).listings.length).toBe(1);
    expect(f.urls).toEqual(["https://weworkremotely.com/remote-jobs.rss"]);
    await expect(publicFeedConnector("remoteok", fakeFetcher({}), NOW)).rejects.toThrow();
  });
});

describe("public feed into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...REMOTEOK_SETTINGS, order: 0 };
  const recent = () => new Date(Date.now() - 86_400_000).toISOString();
  const body = () => json(job({ date: recent() }), job({ id: "2", url: "https://remoteok.com/remote-jobs/2", position: "Full-time engineer", tags: [], date: recent() }));
  const at = (b: Uint8Array) => fakeFetcher({ [FEEDS.remoteok.endpoint]: b });

  it("writes every listing read, marked by the source's rule (plan D9)", async () => {
    const run = await collectSource(db, settings, new Date(), at(body()));
    expect([run.seen, run.externalIds]).toEqual([2, ["123", "2"]]);
    expect([(await listingBy(db, "remoteok", "123"))?.sourceKept, (await listingBy(db, "remoteok", "2"))?.sourceKept]).toEqual([true, false]);
  });

  it("writes the good entries when one lacks its identity; nothing when more than half do; exactly half is written", async () => {
    const run = await collectSource(db, settings, new Date(), at(json(job({ date: recent() }), job({ id: "x" }), job({ id: "9", url: "https://remoteok.com/remote-jobs/9" }))));
    expect([run.rejected, run.externalIds]).toEqual([1, ["123", "9"]]);
    await db.execute(sql`truncate listings cascade`);
    await expect(collectSource(db, settings, new Date(), at(json(job(), job({ id: "x" }), job({ position: "" }))))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "remoteok", "123")).toBeNull();
    expect((await collectSource(db, settings, new Date(), at(json(job(), job({ id: "x" }))))).externalIds).toEqual(["123"]);
  });

  it("writes nothing when the feed fails", async () => {
    await expect(collectSource(db, settings, new Date(), at(new TextEncoder().encode("{}")))).rejects.toThrow(/remoteok/);
    expect(await listingBy(db, "remoteok", "123")).toBeNull();
  });

  it("a second run of the same feed adds no rows and changes nothing (D24)", async () => {
    const b = body();
    await collectSource(db, settings, new Date(), at(b));
    expect((await collectSource(db, settings, new Date(), at(b))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
