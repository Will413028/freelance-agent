import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { intakeListings, listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { HIMALAYAS_SETTINGS, himalayasConnector, normalize, readAll, searchUrl } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Plan step 5: golden's payloads and fetch scenarios (fixtures/cases.json, written by generate.ts
// from legacyToInput of the old output) against the native connector.

type NormalizeCase = { payload: unknown; expect: Record<string, unknown> | { error: true } | { field: string; value: unknown }; why?: string };
type FetchCase = { pages: Record<string, [number, string]>; expect: { error: true } | { ids: string[] }; why?: string };
const cases: { normalize: NormalizeCase[]; fetch: FetchCase[] } = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

const run = (payload: unknown): Record<string, unknown> => {
  try {
    return normalize(payload);
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

describe("himalayas connector over the golden cases", () => {
  it(`${cases.normalize.length} payloads give the expected listing or refusal`, () => {
    const wrong = (e: NormalizeCase["expect"], got: Record<string, unknown>) =>
      "error" in e ? !("error" in got)
      : "field" in e && "value" in e && Object.keys(e).length === 2 ? "error" in got || JSON.stringify(got[e.field as string]) !== JSON.stringify(e.value)
      : JSON.stringify(got) !== JSON.stringify(e);
    const bad = cases.normalize.map((c) => ({ c, got: run(c.payload) })).filter(({ c, got }) => wrong(c.expect, got))
      .map(({ c, got }) => ({ payload: JSON.stringify(c.payload).slice(0, 300), expect: c.expect, got }));
    expect(bad).toEqual([]);
  });

  it(`${cases.fetch.length} fetch scenarios read the same listings or fail`, async () => {
    const bad = [];
    for (const c of cases.fetch) {
      let got: unknown;
      try {
        got = { ids: (await readAll(serving(c.pages))).map((l) => l.external_id) };
      } catch {
        got = { error: true };
      }
      if (JSON.stringify(got) !== JSON.stringify(c.expect)) bad.push({ urls: Object.keys(c.pages).length, expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

const job = (changes: Record<string, unknown> = {}) => ({
  title: "AI agent backend engineer", description: "<p>Build AI agents and APIs</p>", employmentType: "Contractor",
  locationRestrictions: [], timezoneRestrictions: [], pubDate: 1789746632, expiryDate: 1893456000,
  applicationLink: "https://himalayas.app/companies/example/jobs/engineer", guid: "https://himalayas.app/companies/example/jobs/engineer", ...changes,
});
const empty = JSON.stringify({ jobs: [] });
/** Every search answers with no jobs except the ones given. */
const searches = (given: Record<string, string> = {}) => {
  const pages: Record<string, [number, string]> = {};
  for (const q of ["AI agent", "automation", "backend", "full stack"]) for (const e of ["Contractor", "Part Time"]) pages[searchUrl(q, e)] = [200, empty];
  for (const [url, body] of Object.entries(given)) pages[url] = [200, body];
  return pages;
};
const first = searchUrl("AI agent", "Contractor");

describe("himalayas searches", () => {
  it("sends the 8 searches its settings allow, and keeps only Contractor and Part Time listings", async () => {
    const jobs = [job(), job({ guid: "b", employmentType: "Full Time" }), job({ guid: "c", employmentType: "Part Time" }), job({ guid: "d", employmentType: "Intern" })];
    const f = serving(searches({ [first]: JSON.stringify({ jobs }) }));
    const got = await himalayasConnector(f);
    expect([f.urls.length, HIMALAYAS_SETTINGS.maxRequestsPerRun, got.seen, got.listings.map((l) => l.external_id)]).toEqual([8, 8, 4, [job().guid, "c"]]);
  });

  it("keeps a listing found by two searches once, as its last entry", async () => {
    const f = serving(searches({ [first]: JSON.stringify({ jobs: [job({ title: "First" })] }), [searchUrl("backend", "Part Time")]: JSON.stringify({ jobs: [job({ title: "Second" })] }) }));
    const got = await himalayasConnector(f);
    expect([got.seen, got.listings.map((l) => l.title)]).toEqual([1, ["Second"]]);
  });

  it("refuses a search that is not JSON, has no jobs list, lists over 20, or holds one listing without identity or employment type", async () => {
    for (const body of ["<html>", JSON.stringify({ items: [] }), JSON.stringify({ jobs: Array.from({ length: 21 }, (_, i) => job({ guid: String(i) })) }),
      JSON.stringify({ jobs: [job(), job({ guid: "x", description: null })] }), JSON.stringify({ jobs: [job({ guid: 5 })] }), JSON.stringify({ jobs: [job({ employmentType: null })] })]) {
      await expect(himalayasConnector(serving(searches({ [first]: body })))).rejects.toThrow(/himalayas/);
    }
  });

  it("fails when a search fails", async () => {
    const pages = searches();
    pages[searchUrl("automation", "Part Time")] = [503, ""];
    await expect(himalayasConnector(serving(pages))).rejects.toThrow(/503/);
  });

  it("keeps unknown hours, budget and geography unknown; restrictions without Taiwan or UTC+8 exclude it", () => {
    const l = normalize(job());
    expect([l.weekly_hours, l.budget_min, l.taiwan_eligible, l.timezone_compatible, l.published_at]).toEqual([null, null, null, null, "2026-09-18T15:50:32.000Z"]);
    expect(normalize(job({ locationRestrictions: [{ alpha2: "US", name: "United States" }] })).taiwan_eligible).toBe(false);
    expect(normalize(job({ locationRestrictions: ["Taiwan"] })).taiwan_eligible).toBeNull();
    expect(normalize(job({ timezoneRestrictions: [-5, 0] })).timezone_compatible).toBe(false);
    expect(normalize(job({ timezoneRestrictions: [8, "bad"] })).timezone_compatible).toBeNull();
    expect(normalize(job({ pubDate: "2026-09-18T12:00:00" })).published_at).toBeNull();
  });
});

describe("himalayas into intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-09-20T00:00:00Z");
  const collect = async (pages: Record<string, [number, string]>) => {
    const got = await himalayasConnector(serving(pages));
    return intakeListings(db, "himalayas", got.listings, "page", NOW);
  };

  it("writes only what the source keeps, writes nothing when the batch fails, and a rerun changes nothing", async () => {
    const pages = searches({ [first]: JSON.stringify({ jobs: [job(), job({ guid: "full", employmentType: "Full Time" })] }) });
    expect((await collect(pages)).inserted).toBe(1);
    expect(await listingBy(db, "himalayas", "full")).toBeNull();
    expect(await collect(pages)).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
    await db.execute(sql`truncate listings cascade`);
    await expect(collect(searches({ [first]: JSON.stringify({ jobs: [job(), job({ guid: "x", title: "" })] }) }))).rejects.toThrow(/title/);
    expect(await listingBy(db, "himalayas", job().guid)).toBeNull();
  });
});
