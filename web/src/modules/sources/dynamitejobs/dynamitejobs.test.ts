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
import { DYNAMITEJOBS_SETTINGS, dynamiteJobsConnector, INDEX, jobUrl, kept, normalizeArticle, parseIndex } from ".";

// Plan step 5c: the golden index pages and job pages against the native connector, then its own rules.
// fixtures/cases.json was generated once from golden.json (dynamitejobs_index, dynamitejobs_article) at
// ce1254d by a throwaway generator (not committed): the old Python output mapped field by field into the
// contract, every deliberate difference listed there by golden index with its reason, carried in `why`.
// Differences: index SET_ASIDE 3 (3, 4, 20: a job-like link that is not a job URL is set aside, not the
// page refused), ACCEPTED 2 (7: a bare href is an empty href; 16: host case); article D8_UNKNOWN 7
// (5, 16, 17, 18, 20, 21: unreadable location requirements leave location and Taiwan eligibility unknown;
// 27: an unreadable validThrough is an invalid deadline). PATCHED 0, REFUSED 0. New: location is the
// requirement names joined by "; ".

type IndexCase = { index: number; input: string; why?: string; expect: { error: true } | { urls: string[]; rejected: number } };
type ArticleCase = {
  index: number; input: string; url: string; why?: string;
  expect: { listing: unknown } | { setAside: true } | { challenge: true } | { external_id: string; url: string; fields: Record<string, unknown> };
};
const cases: { index: IndexCase[]; article: ArticleCase[] } = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const bytes = (s: string) => Buffer.from(s, "latin1");

describe("dynamitejobs over the golden pages", () => {
  it(`${cases.index.length} index pages give the expected job URLs or refusal`, () => {
    const bad = cases.index.flatMap((c): unknown[] => {
      let got;
      try {
        got = parseIndex(bytes(c.input));
      } catch (e) {
        return "error" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      return JSON.stringify(got) === JSON.stringify(c.expect) ? [] : [{ index: c.index, expect: c.expect, got }];
    });
    expect(bad).toEqual([]);
  });

  it(`${cases.article.length} job pages give the expected listing, set-aside, challenge or unknown field`, () => {
    const bad = cases.article.flatMap((c): unknown[] => {
      let got;
      try {
        got = normalizeArticle(bytes(c.input), c.url);
      } catch (e) {
        if (e instanceof AccessChallenge) return "challenge" in c.expect ? [] : [{ index: c.index, error: e.message }];
        return "setAside" in c.expect ? [] : [{ index: c.index, error: (e as Error).message }];
      }
      const e = c.expect;
      const ok = "listing" in e ? JSON.stringify(got) === JSON.stringify(e.listing)
        : "fields" in e ? got.external_id === e.external_id && got.url === e.url && Object.entries(e.fields).every(([k, v]) => JSON.stringify(got[k as keyof typeof got]) === JSON.stringify(v))
          : false;
      return ok ? [] : [{ index: c.index, expect: e, got }];
    });
    expect(bad).toEqual([]);
  });
});

const NOW = new Date("2026-10-01T00:00:00Z");
const URL0 = "https://dynamitejobs.com/company/acme/remote-job/api-engineer";
const posting = (o: Record<string, unknown> = {}) => ({
  "@type": "JobPosting", title: "API engineer", description: "<p>Build APIs.</p>", url: URL0, employmentType: "CONTRACTOR",
  jobLocationType: "TELECOMMUTE", applicantLocationRequirements: [{ "@type": "Country", name: "Taiwan" }], datePosted: "2026-09-26T10:00:00+00:00", ...o,
});
const page = (o: Record<string, unknown> = {}) => new TextEncoder().encode(`<html><script type="application/ld+json">${JSON.stringify(posting(o))}</script></html>`);
const indexOf = (...hrefs: string[]) => new TextEncoder().encode(hrefs.map((h) => `<a href="${h}">job</a>`).join(""));

describe("dynamitejobs rules", () => {
  it("counts a bad job link once however many times a card repeats it, as a good link is", () => {
    const bad = "https://dynamitejobs.com/company/acme/remote-job/";
    expect(parseIndex(indexOf(URL0, URL0, bad, bad, bad))).toEqual({ urls: [URL0], rejected: 1 });
  });

  it("marks remote contract jobs of the last 90 days kept; returns the rest marked (plan D9)", () => {
    const l = (o: Record<string, unknown>) => kept(normalizeArticle(page(o), URL0), NOW);
    expect([l({}), l({ employmentType: "FULL_TIME" }), l({ jobLocationType: null }), l({ datePosted: "2026-06-01T00:00:00Z" }), l({ datePosted: "2026-10-02T00:00:00Z" })])
      .toEqual([true, false, false, false, false]);
  });

  it("keeps unknown unknown: unreadable locations, hours, budget; remote is not Taiwan-eligible", () => {
    const u = normalizeArticle(page({ applicantLocationRequirements: "Worldwide" }), URL0);
    expect([u.location, u.taiwan_eligible, u.weekly_hours, u.budget_min, u.deadline]).toEqual([null, null, null, null, null]);
    expect(normalizeArticle(page({ applicantLocationRequirements: [{ "@type": "Country", name: "Worldwide" }] }), URL0).taiwan_eligible).toBeNull();
    expect(normalizeArticle(page({ applicantLocationRequirements: { "@type": "Country", name: "Germany" } }), URL0)).toMatchObject({ taiwan_eligible: false, location: "Germany" });
    expect(normalizeArticle(page({ validThrough: "2026-12-01" }), URL0).deadline).toEqual({ kind: "date", date: "2026-12-01" });
    expect(normalizeArticle(page({ validThrough: "2026-12-01T00:00:00" }), URL0).deadline).toEqual({ kind: "no_timezone", text: "2026-12-01T00:00:00" });
  });

  it("names one job by one id across spellings of its URL; a URL off the board is not a job", () => {
    for (const u of [URL0, "https://DynamiteJobs.com/company/acme/remote-job/api-engineer?utm=1#x", "https://dynamitejobs.com:443/company/acme/remote-job/api-engineer", ` ${URL0} `, "/company/acme/remote-job/api-engineer"]) {
      expect(jobUrl(u)).toBe(URL0);
      expect(normalizeArticle(page(), u).external_id).toBe("/company/acme/remote-job/api-engineer");
    }
    for (const u of ["http://dynamitejobs.com/company/acme/remote-job/api-engineer", "https://evil.example/company/acme/remote-job/api-engineer", "https://dynamitejobs.com/company/acme/remote-job/API", "https://dynamitejobs.com:8443/company/a/remote-job/b", "/remote-job/"]) {
      expect(jobUrl(u)).toBeNull();
    }
    expect(parseIndex(indexOf("https://evil.example/company/a/remote-job/b", URL0, "/category/development"))).toEqual({ urls: [URL0], rejected: 1 });
  });

  it("refuses an index page that is empty, a challenge, not UTF-8, without job links or with more than 200", () => {
    const many = Array.from({ length: 201 }, (_, i) => `/company/a/remote-job/j${i}`);
    expect(parseIndex(indexOf(...many.slice(0, 200))).urls.length).toBe(200);
    for (const body of [new Uint8Array(), indexOf(...many), indexOf("/category/development"), new Uint8Array([0xff]), new TextEncoder().encode("<title>Just a moment</title>")]) {
      expect(() => parseIndex(body)).toThrow(/dynamitejobs/);
    }
  });
});

/** A fake Fetcher: a body per URL, or a FetchError; anything else fails like a network error. */
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
      const p = pages[req.url];
      if (p === undefined) throw new FetchError("network", "network");
      if (p instanceof FetchError) throw p;
      return { status: 200, body: p, tier: "plain" };
    },
  };
};
const U = (n: number) => `https://dynamitejobs.com/company/acme/remote-job/job-${n}`;
const site = (n: number, over: Record<string, Uint8Array | FetchError> = {}, datePosted = "2026-09-26T10:00:00+00:00") => ({
  [INDEX]: indexOf(...Array.from({ length: n }, (_, i) => U(i))),
  ...Object.fromEntries(Array.from({ length: n }, (_, i) => [U(i), page({ url: U(i), datePosted })])),
  ...over,
});

describe("dynamitejobs connector", () => {
  it("reads the index then each job page; a bad job page between good ones is set aside", async () => {
    const f = fakeFetcher(site(3, { [U(1)]: page({ url: U(1), title: "" }) }));
    const got = await dynamiteJobsConnector(f, NOW);
    expect([got.seen, got.listings.map((l) => l.external_id), got.rejected, got.examined, got.truncated]).toEqual([3, ["/company/acme/remote-job/job-0", "/company/acme/remote-job/job-2"], 1, 3, false]);
    expect(f.urls).toEqual([INDEX, U(0), U(1), U(2)]);
  });

  it("sets aside a job page answering 404; fails on 403 or a challenge; truncates at the request cap", async () => {
    const r404 = await dynamiteJobsConnector(fakeFetcher(site(2, { [U(0)]: new FetchError("http_status", "404", 404) })), NOW);
    expect([r404.listings.length, r404.rejected, r404.examined]).toEqual([1, 1, 2]);
    await expect(dynamiteJobsConnector(fakeFetcher(site(2, { [U(0)]: new FetchError("http_status", "403", 403) })), NOW)).rejects.toThrow(/403/);
    await expect(dynamiteJobsConnector(fakeFetcher(site(2, { [U(1)]: new TextEncoder().encode("<div class=\"cf-chl-x\"></div>") })), NOW)).rejects.toThrow(AccessChallenge);
    const capped = await dynamiteJobsConnector(fakeFetcher(site(3), 2), NOW);
    expect([capped.seen, capped.listings.length, capped.truncated]).toEqual([3, 1, true]);
    await expect(dynamiteJobsConnector(fakeFetcher({}), NOW)).rejects.toThrow();
  });
});

describe("dynamitejobs into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...DYNAMITEJOBS_SETTINGS, order: 0 };
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const id = (n: number) => `/company/acme/remote-job/job-${n}`;

  it("writes every listing read, marked by the source's rule (plan D9)", async () => {
    const f = fakeFetcher(site(2, { [U(1)]: page({ url: U(1), datePosted: recent, employmentType: "FULL_TIME" }) }, recent));
    const run = await collectSource(db, settings, new Date(), f);
    expect(run.externalIds).toEqual([id(0), id(1)]);
    expect([(await listingBy(db, "dynamitejobs", id(0)))?.sourceKept, (await listingBy(db, "dynamitejobs", id(1)))?.sourceKept]).toEqual([true, false]);
  });

  it("writes nothing when the source fails, or when more than half are set aside; exactly half is written", async () => {
    await expect(collectSource(db, settings, new Date(), fakeFetcher(site(2, { [INDEX]: new TextEncoder().encode("<p>none</p>") })))).rejects.toThrow(/dynamitejobs/);
    await expect(collectSource(db, settings, new Date(), fakeFetcher(site(2, { [U(0)]: new FetchError("http_status", "403", 403) })))).rejects.toThrow();
    expect(await listingBy(db, "dynamitejobs", id(1))).toBeNull();
    const bad = page({ title: "" });
    await expect(collectSource(db, settings, new Date(), fakeFetcher(site(3, { [U(0)]: bad, [U(1)]: bad })))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "dynamitejobs", id(2))).toBeNull();
    expect((await collectSource(db, settings, new Date(), fakeFetcher(site(2, { [U(0)]: bad })))).externalIds).toEqual([id(1)]);
  });

  it("a second run of the same pages adds no rows and changes nothing (D24)", async () => {
    const pages = site(2, {}, recent);
    await collectSource(db, settings, new Date(), fakeFetcher(pages));
    expect((await collectSource(db, settings, new Date(), fakeFetcher(pages))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
