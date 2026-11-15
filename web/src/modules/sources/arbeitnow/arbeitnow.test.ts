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
import { arbeitnowConnector, ARBEITNOW_SETTINGS, descriptionText, ENDPOINT, MAX_PAGES, normalize, parsePage, scan } from ".";

// Plan step 5: the golden payloads (fixtures/cases.json, written by generate.ts from legacyToInput of
// the old output) against the native connector, then the batch, filter and unknown-field rules.

type Expected = Record<string, unknown>;
type Cases = {
  normalize: { payload: unknown; expect: Expected }[];
  page: { input: { body: string; page: number }; expect: Expected }[];
  scan: { input: Record<string, [number, string]>; expect: Expected }[];
};
const cases: Cases = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const attempt = <T,>(fn: () => T) => {
  try {
    return fn();
  } catch (e) {
    return { error: true, message: (e as Error).message };
  }
};

/** A fake Fetcher over fixed responses: any status but 200 and any unknown URL fail as the real one does. */
function site(pages: Record<string, [number, string]>): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get(req) {
      urls.push(req.url);
      const page = pages[req.url];
      if (!page) throw new FetchError("network", "no such page");
      if (page[0] !== 200) throw new FetchError("http_status", `HTTP ${page[0]}`, page[0]);
      return { status: 200, body: enc(page[1]), tier: "plain" };
    },
  };
}

describe("arbeitnow over the golden payloads", () => {
  it(`${cases.normalize.length} listings give the expected listing or refusal`, () => {
    const bad = cases.normalize.map((c) => ({ c, got: attempt(() => normalize(c.payload)) as Record<string, unknown> })).filter(({ c, got }) =>
      "error" in c.expect ? !("error" in got)
      : "unknown" in c.expect ? "error" in got || got[c.expect.unknown as string] !== null
      : "listing" in c.expect ? "error" in got
      : JSON.stringify(got) !== JSON.stringify(c.expect));
    expect(bad.map(({ c, got }) => ({ payload: JSON.stringify(c.payload).slice(0, 200), expect: c.expect, got }))).toEqual([]);
  });

  it(`${cases.page.length} pages give the expected listings and next page or refusal`, () => {
    const bad = cases.page.map((c) => {
      const got = attempt(() => {
        const p = parsePage(enc(c.input.body), c.input.page);
        return { count: p.count, ids: p.listings.map((l) => l.external_id), next: p.next, ...(p.rejected ? { rejected: p.rejected } : {}) };
      }) as Record<string, unknown>;
      const ok = "error" in c.expect ? "error" in got : "listing" in c.expect ? !("error" in got) : JSON.stringify(got) === JSON.stringify(c.expect);
      return { body: c.input.body.slice(0, 200), expect: c.expect, got, ok };
    }).filter((x) => !x.ok);
    expect(bad).toEqual([]);
  });

  it(`${cases.scan.length} response sets give the expected listings and requests or refusal`, async () => {
    const bad = [];
    for (const c of cases.scan) {
      const fetcher = site(c.input);
      let got: Record<string, unknown>;
      try {
        const r = await scan(fetcher);
        got = { seen: r.seen, ids: r.listings.map((l) => l.external_id), requests: fetcher.urls, ...(r.rejected ? { rejected: r.rejected } : {}) };
      } catch (e) {
        got = { error: true, message: (e as Error).message };
      }
      const ok = "error" in c.expect ? "error" in got : "listing" in c.expect ? !("error" in got) : JSON.stringify(got) === JSON.stringify(c.expect);
      if (!ok) bad.push({ input: Object.keys(c.input), expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

const job = (changes: Record<string, unknown> = {}) => ({
  slug: "ai-agent-123", title: "Part time AI agent developer", description: "<p>Build an AI agent and API.</p><p>Second line</p>",
  remote: true, url: "https://www.arbeitnow.com/jobs/companies/acme/ai-agent-123", tags: ["AI"], job_types: ["Part Time"],
  location: "Remote", created_at: 1790000000, ...changes,
});
const pageOf = (data: unknown[], n = 1, next: string | null = null, perPage = 2) => ({
  data, meta: { current_page: n, per_page: perPage, from: data.length ? (n - 1) * perPage + 1 : null, to: data.length ? (n - 1) * perPage + data.length : null },
  links: { next },
});
const NOW = new Date("2026-09-28T01:00:00Z"); // 1790000000 is 2026-09-21T14:13:20Z

describe("arbeitnow connector", () => {
  it("keeps remote contract listings of the last 90 days and counts every listing seen", async () => {
    const data = [job(), job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b", job_types: ["Full Time"] }),
      job({ slug: "c", url: "https://www.arbeitnow.com/jobs/companies/acme/c", remote: false }),
      job({ slug: "d", url: "https://www.arbeitnow.com/jobs/companies/acme/d", created_at: 1790000000 - 91 * 86400 }),
      job({ slug: "e", url: "https://www.arbeitnow.com/jobs/companies/acme/e", created_at: 1790000000 + 7 * 86400 }),
      job({ slug: "f", url: "https://www.arbeitnow.com/jobs/companies/acme/f", job_types: ["Freelance"] })];
    const got = await arbeitnowConnector(site({ [ENDPOINT]: [200, JSON.stringify(pageOf(data, 1, null, 6))] }), NOW);
    expect([got.seen, got.listings.map((l) => l.external_id)]).toEqual([6, ["ai-agent-123", "f"]]);
  });

  it("reads the pages in order, pinned to the endpoint, and keeps a job listed twice with the same content once", async () => {
    const two = "https://www.arbeitnow.nl/api/job-board-api?page=2";
    const fetcher = site({
      [ENDPOINT]: [200, JSON.stringify(pageOf([job(), job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b" })], 1, two))],
      [`${ENDPOINT}?page=2`]: [200, JSON.stringify(pageOf([job()], 2))],
    });
    const got = await scan(fetcher);
    expect([got.seen, got.listings.map((l) => l.external_id), fetcher.urls]).toEqual([3, ["ai-agent-123", "b"], [ENDPOINT, `${ENDPOINT}?page=2`]]);
  });

  it("fails the run when a listing changes during pagination, pagination is inconsistent; marks a scan cut short by the page cap truncated", async () => {
    const two = `${ENDPOINT}?page=2`;
    const changed = site({ [ENDPOINT]: [200, JSON.stringify(pageOf([job(), job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b" })], 1, two))], [two]: [200, JSON.stringify(pageOf([job({ title: "Other" })], 2))] });
    await expect(scan(changed)).rejects.toThrow(/changed during pagination/);
    const short = site({ [ENDPOINT]: [200, JSON.stringify(pageOf([job()], 1, two))] });
    await expect(scan(short)).rejects.toThrow(/inconsistent pagination/);
    // The real API misreports meta.from/to (page 2 of 2-per-page as from 2, to 2); distinct listings are still read.
    const misnumbered = site({
      [ENDPOINT]: [200, JSON.stringify(pageOf([job(), job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b" })], 1, two))],
      [two]: [200, JSON.stringify({ ...pageOf([job({ slug: "c", url: "https://www.arbeitnow.com/jobs/companies/acme/c" })], 2), meta: { current_page: 2, per_page: 2, from: 2, to: 2 } })],
    });
    expect((await scan(misnumbered)).listings.map((l) => l.external_id)).toEqual(["ai-agent-123", "b", "c"]);
    // Accepted trade-off (index.ts pageShapeOk): a page repeating an earlier listing unchanged is merged, not detected.
    const overlapping = site({
      [ENDPOINT]: [200, JSON.stringify(pageOf([job(), job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b" })], 1, two))],
      [two]: [200, JSON.stringify(pageOf([job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b" })], 2))],
    });
    expect(await scan(overlapping)).toMatchObject({ truncated: false, listings: [{ external_id: "ai-agent-123" }, { external_id: "b" }] });
    const endless: Record<string, [number, string]> = {};
    for (let n = 1; n <= MAX_PAGES + 1; n++) {
      const slugs = [`a${n}`, `b${n}`];
      endless[n === 1 ? ENDPOINT : `${ENDPOINT}?page=${n}`] = [200, JSON.stringify(pageOf(slugs.map((s) => job({ slug: s, url: `https://www.arbeitnow.com/jobs/companies/acme/${s}` })), n, `${ENDPOINT}?page=${n + 1}`))];
    }
    const f = site(endless);
    const capped = await scan(f);
    expect([capped.truncated, capped.seen, f.urls.length]).toEqual([true, 2 * MAX_PAGES, MAX_PAGES]);
    expect((await scan(site({ [ENDPOINT]: [200, JSON.stringify(pageOf([job()], 1, null, 1))] }))).truncated).toBe(false);
  });

  it("refuses a page that is not JSON, has no data list or lists too many", () => {
    for (const body of [enc("<html>"), enc(""), new Uint8Array([0x7b, 0xff, 0x7d]), enc({ data: {} }), enc({ ...pageOf([]), data: Array.from({ length: 10_001 }, () => ({})) })]) {
      expect(() => parsePage(body, 1)).toThrow(/arbeitnow/);
    }
  });

  it("sets aside and counts one listing without identity, keeping the others", async () => {
    const body = JSON.stringify(pageOf([job(), job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b", description: null })]));
    const p = parsePage(enc(body), 1);
    expect([p.count, p.rejected, p.listings.map((l) => l.external_id)]).toEqual([2, 1, ["ai-agent-123"]]);
    const got = await arbeitnowConnector(site({ [ENDPOINT]: [200, body] }), NOW);
    expect([got.seen, got.rejected, got.listings.map((l) => l.external_id)]).toEqual([2, 1, ["ai-agent-123"]]);
  });

  it("refuses a listing whose fields the source's rule reads change format instead of keeping nothing", () => {
    expect(() => normalize(job({ job_types: "Part Time" }))).toThrow(/job types/);
    expect(() => normalize(job({ created_at: "1790000000" }))).toThrow(/publication time/);
  });

  it("refuses a URL off the board, of another job, or not https; keeps the board's spelling without query", () => {
    for (const url of ["https://www.arbeitnow.ch.evil.test/jobs/companies/acme/ai-agent-123", "http://www.arbeitnow.com/jobs/companies/acme/ai-agent-123", "https://www.arbeitnow.com/jobs/companies/acme/other", "https://WWW.arbeitnow.com/jobs/companies/acme/ai-agent-123"]) {
      expect(() => normalize(job({ url }))).toThrow(/canonical URL/);
    }
    expect(normalize(job({ url: "https://www.arbeitnow.fr/jobs/companies/acme/ai-agent-123/?utm=x#y" })).url).toBe("https://www.arbeitnow.fr/jobs/companies/acme/ai-agent-123/");
    // The board's newer host (seen on the real API 2026-11-15); the id stays the slug.
    expect(normalize(job({ url: "https://www.arbeitnow.nl/jobs/companies/acme/ai-agent-123" }))).toMatchObject({ external_id: "ai-agent-123", url: "https://www.arbeitnow.nl/jobs/companies/acme/ai-agent-123" });
    expect(() => normalize(job({ url: "https://www.arbeitnow.de/jobs/companies/acme/ai-agent-123" }))).toThrow(/canonical URL/);
  });

  it("keeps unknown eligibility, hours and budget unknown; remote is no Taiwan eligibility; a bad location is unknown", () => {
    const l = normalize(job());
    expect([l.taiwan_eligible, l.weekly_hours, l.budget_min, l.deadline, l.location, l.description, l.published_at])
      .toEqual([null, null, null, null, "Remote", "Build an AI agent and API.\nSecond line", "2026-09-21T14:13:20.000Z"]);
    expect(normalize(job({ location: 5 })).location).toBeNull();
  });

  it("drops the promotional footer only at the end", () => {
    const footer = '<p>Find <a href="https://www.arbeitnow.com">Jobs in Germany</a> on Arbeitnow</a>';
    expect(descriptionText(`<p>x</p>${footer}\u001c`)).toBe("x");
    expect(descriptionText(`<p>x</p>${footer}<p>y</p>`)).toBe("x\nFind Jobs in Germany on Arbeitnow\ny");
  });

  it("settings: plain tier, at most 20 requests 3 s apart", () => {
    expect([ARBEITNOW_SETTINGS.maxTier, ARBEITNOW_SETTINGS.maxRequestsPerRun, ARBEITNOW_SETTINGS.minIntervalMs, ARBEITNOW_SETTINGS.disabled]).toEqual(["plain", 20, 3000, null]);
  });
});

describe("arbeitnow into intake (collectSource)", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...ARBEITNOW_SETTINGS, order: 0 };
  const pages = (...data: unknown[]) => site({ [ENDPOINT]: [200, JSON.stringify(pageOf(data, 1, null, data.length))] });
  const full = () => job({ slug: "b", url: "https://www.arbeitnow.com/jobs/companies/acme/b", job_types: ["Full Time"] });

  it("writes only listings the source's rule and screening keep", async () => {
    const run = await collectSource(db, settings, NOW, pages(job(), full()));
    expect([run.seen, run.externalIds]).toEqual([2, ["ai-agent-123"]]);
    expect(await listingBy(db, "arbeitnow", "b")).toBeNull();
  });

  it("screening drops a listing that matches no work category (old score > 0)", async () => {
    const other = job({ slug: "g", url: "https://www.arbeitnow.com/jobs/companies/acme/g", title: "Part time warehouse helper", description: "<p>Pack boxes.</p>", tags: [] });
    expect((await collectSource(db, settings, NOW, pages(job(), other))).externalIds).toEqual(["ai-agent-123"]);
  });

  it("writes the others when one listing lacks its identity, and nothing when most do", async () => {
    const run = await collectSource(db, settings, NOW, pages(job(), job({ slug: "c", url: "https://www.arbeitnow.com/jobs/companies/acme/c", title: "" })));
    expect([run.seen, run.rejected, run.externalIds]).toEqual([2, 1, ["ai-agent-123"]]);
    await db.execute(sql`truncate listings cascade`);
    await expect(collectSource(db, settings, NOW, pages(job(), job({ slug: "c", url: "https://www.arbeitnow.com/jobs/companies/acme/c", title: "" }),
      job({ slug: "d", url: "https://www.arbeitnow.com/jobs/companies/acme/d", title: "" })))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "arbeitnow", "ai-agent-123")).toBeNull();
  });

  it("a second run of the same page changes nothing", async () => {
    await collectSource(db, settings, NOW, pages(job()));
    expect((await collectSource(db, settings, NOW, pages(job()))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
  });
});
