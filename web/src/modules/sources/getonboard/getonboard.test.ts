import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { intakeListings, listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { GETONBOARD_SETTINGS, getonboardConnector, normalize, readAll, ROOT, type Modalities } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Plan step 5: golden's items and fetch scenarios (fixtures/cases.json, written by fixtures/generate.ts (deleted in step 5a2 with legacyToInput, D10; see it and its list of deliberate differences at 9a68d6b) from
// legacyToInput of the old output) against the native connector.

type Expected = Record<string, unknown> | { error: true } | { unknown: string } | { listing: true };
type FetchExpect = { error: true } | { seen: number; ids: string[]; pages: number; truncated: boolean; rejected?: number };
const cases: {
  modalities: Record<string, unknown>;
  normalize: { item: unknown; expect: Expected; why?: string }[];
  fetch: { pages: Record<string, [number, string]>; expect: FetchExpect; why?: string }[];
} = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const goldenModalities: Modalities = new Map(Object.entries(cases.modalities));

const run = (item: unknown, modalities = goldenModalities): Record<string, unknown> => {
  try {
    return normalize(item, modalities);
  } catch (e) {
    return { error: true, message: (e as Error).message };
  }
};

/** A Fetcher over {url: [status, latin-1 body]}; an unknown URL, a status but 200 or a body over the cap fails as the real one does. */
const serving = (pages: Record<string, [number, string]>): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get({ url, maxBytes }) {
      urls.push(url);
      if (!Object.hasOwn(pages, url)) throw new FetchError("network", "unknown url");
      const [status, body] = pages[url];
      if (status !== 200) throw new FetchError("http_status", `HTTP ${status}`, status);
      const bytes = new Uint8Array(Buffer.from(body, "latin1"));
      if (bytes.length > maxBytes) throw new FetchError("too_large", `body over ${maxBytes} bytes`);
      return { status, body: bytes, tier: "plain" };
    },
  };
};

describe("getonboard connector over the golden cases", () => {
  it(`${cases.normalize.length} items give the expected listing or refusal`, () => {
    const wrong = (e: Expected, got: Record<string, unknown>) =>
      "error" in e ? !("error" in got)
      : "unknown" in e ? "error" in got || got[e.unknown as string] !== null
      : "listing" in e ? "error" in got
      : JSON.stringify(got) !== JSON.stringify(e);
    const bad = cases.normalize.map((c) => ({ c, got: run(c.item) })).filter(({ c, got }) => wrong(c.expect, got))
      .map(({ c, got }) => ({ item: JSON.stringify(c.item).slice(0, 300), expect: c.expect, got }));
    expect(bad).toEqual([]);
  });

  it(`${cases.fetch.length} fetch scenarios read the same listings or fail`, async () => {
    const bad = [];
    for (const c of cases.fetch) {
      let got: unknown;
      try {
        const r = await readAll(serving(c.pages));
        got = { seen: r.seen, ids: r.listings.map((l) => l.external_id), pages: r.pages, truncated: r.truncated, ...(r.rejected ? { rejected: r.rejected } : {}) };
      } catch {
        got = { error: true };
      }
      if (JSON.stringify(got) !== JSON.stringify(c.expect)) bad.push({ urls: Object.keys(c.pages), expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

const NOW = new Date("2026-09-20T00:00:00Z");
const taxonomy = JSON.stringify({ data: [["42", "part_time"], ["43", "full_time"], ["44", "freelance"]].map(([id, k]) => ({ id, attributes: { locale_key: k } })), meta: { total_pages: 1 } });
const job = (id = "acme-ai-agent", changes: Record<string, unknown> = {}) => ({
  id, links: { public_url: `https://www.getonbrd.com/jobs/${id}` },
  attributes: {
    title: "Part time AI agent backend engineer", description: "<p>Build an AI agent and API.</p>", modality: { data: { id: 42 } },
    remote: true, remote_modality: "fully_remote", countries: ["Remote"], published_at: Date.parse("2026-09-18T12:00:00Z") / 1000,
    category_name: "Programming", lang: "en", min_salary: 1000, max_salary: 2000, ...changes,
  },
});
const searchUrl = (page: number) => `${ROOT}search/jobs?remote=true&per_page=120&page=${page}`;
const site = (pages: unknown[][], totalPages = pages.length): Record<string, [number, string]> => ({
  [`${ROOT}modalities?per_page=120&page=1`]: [200, taxonomy],
  ...Object.fromEntries(pages.map((data, i) => [searchUrl(i + 1), [200, JSON.stringify({ data, meta: { page: i + 1, total_pages: totalPages } })]])),
});

describe("getonboard search", () => {
  it("keeps only fresh remote part-time or freelance listings in tech categories, and counts every listing seen", async () => {
    const jobs = [job(), job("full", { modality: { data: { id: 43 } } }), job("free", { modality: { data: { id: 44 } } }), job("office", { remote: false }),
      job("design", { category_name: "Design / UX" }), job("old", { published_at: Date.parse("2026-06-01T00:00:00Z") / 1000 }),
      job("future", { published_at: Date.parse("2026-09-21T00:00:00Z") / 1000 })];
    const got = await getonboardConnector(serving(site([jobs])), NOW);
    expect([got.seen, got.listings.map((l) => l.external_id)]).toEqual([7, ["acme-ai-agent", "free"]]);
  });

  it("reads at most the 11 requests its settings allow and stops at 10 pages", async () => {
    const f = serving(site(Array.from({ length: 12 }, (_, i) => [job(`job-${i + 1}`)])));
    const r = await readAll(f);
    expect([f.urls.length, GETONBOARD_SETTINGS.maxRequestsPerRun, r.pages, r.truncated, r.seen]).toEqual([11, 11, 10, true, 10]);
    expect((await getonboardConnector(serving(site(Array.from({ length: 12 }, (_, i) => [job(`job-${i + 1}`)]))), NOW)).truncated).toBe(true);
  });

  it("keeps a job listed twice once, as its last entry", async () => {
    const got = await getonboardConnector(serving(site([[job("a", { title: "First" })], [job("a", { title: "Second" })]])), NOW);
    expect([got.seen, got.listings.map((l) => l.title)]).toEqual([2, ["Second"]]);
  });

  it("sets aside and counts a listing without identity, an unknown modality or an unreadable publication time, keeping the others", async () => {
    for (const bad of [{ modality: { data: { id: 99 } } }, { description: null }, { published_at: 0 }, { title: null }]) {
      const got = await getonboardConnector(serving(site([[job(), job("b", bad)]])), NOW);
      expect([got.seen, got.rejected, got.listings.map((l) => l.external_id)]).toEqual([2, 1, ["acme-ai-agent"]]);
    }
  });

  it("refuses the batch on a page that is not JSON, a broken envelope or pagination, or a category the rule cannot read", async () => {
    const pages = [
      { ...site([[job()]]), [searchUrl(1)]: [200, "<html>"] as [number, string] },
      { ...site([[job()]]), [searchUrl(1)]: [200, JSON.stringify({ data: Array.from({ length: 121 }, (_, i) => job(`j${i}`)), meta: { page: 1, total_pages: 1 } })] as [number, string] },
      { ...site([[job()]]), [searchUrl(1)]: [200, JSON.stringify({ data: [job()], meta: { page: 2, total_pages: 1 } })] as [number, string] },
      site([[job("b", { category_name: ["Programming"] })]]),
      { ...site([[job()]]), [`${ROOT}modalities?per_page=120&page=1`]: [200, JSON.stringify({ data: [], meta: { total_pages: 2 } })] as [number, string] },
    ];
    for (const p of pages) await expect(getonboardConnector(serving(p), NOW)).rejects.toThrow(/getonboard/);
  });

  it("fails when the source time budget is spent", async () => {
    let t = 0;
    await expect(readAll(serving(site([[job()]])), () => (t += 50_000))).rejects.toThrow(/time budget/);
  });

  it("keeps unknown hours, budget and eligibility unknown; a regional title excludes Taiwan; a salary is no project budget", () => {
    const l = normalize(job(), goldenModalities);
    expect([l.weekly_hours, l.budget_min, l.taiwan_eligible, l.location, l.published_at]).toEqual([null, null, null, "Remote", "2026-09-18T12:00:00.000Z"]);
    for (const title of ["Backend LATAM", "Remote (US Only)", "EU-only dev"]) expect(normalize(job("a", { title }), goldenModalities).taiwan_eligible).toBe(false);
    expect(normalize(job("a", { title: "ÉLATAM" }), goldenModalities).taiwan_eligible).toBeNull();
    expect(normalize(job("a", { countries: [5] }), goldenModalities).location).toBeNull();
  });
});

describe("getonboard into intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const collect = async (pages: Record<string, [number, string]>) => {
    const got = await getonboardConnector(serving(pages), NOW);
    return intakeListings(db, "getonboard", got.listings, "page", NOW);
  };

  it("writes only what the source keeps, writes nothing when the batch fails, and a rerun changes nothing", async () => {
    const pages = site([[job(), job("full", { modality: { data: { id: 43 } } })]]);
    expect((await collect(pages)).inserted).toBe(1);
    expect(await listingBy(db, "getonboard", "full")).toBeNull();
    expect(await collect(pages)).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
    await db.execute(sql`truncate listings cascade`);
    await expect(collect({ ...site([[job()]]), [searchUrl(1)]: [200, "<html>"] })).rejects.toThrow(/getonboard/);
    expect(await listingBy(db, "getonboard", "acme-ai-agent")).toBeNull();
  });
});
