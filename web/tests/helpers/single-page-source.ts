import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import type { PageSourceSettings } from "@/modules/sources/types";
import { FetchError, type Fetcher, type Tier } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { freshPg } from "./pg";

// The cases every one-page source of plan step 8b shares (connector checklist §5): one plain request with
// the page limits, a bad entry between good ones set aside and counted, the page refused as a whole when
// its data is gone, and intake through collectSource (more than half set aside writes nothing, exactly
// half is written, a failed read writes nothing, a second run of the same page changes nothing).

export type OnePage<J> = {
  settings: Omit<PageSourceSettings, "order">;
  /** The page URL the connector reads. */
  index: string;
  /** A page holding these entries in the source's own format. */
  page: (jobs: J[]) => Uint8Array;
  /** A good entry; different `i` are different listings. */
  good: (i: number) => J;
  /** The good entry `i` with the title "Retitled" (the same listing). */
  retitled: (i: number) => J;
  /** The external_id the good entry `i` gets. */
  id: (i: number) => string;
  /** An entry whose identity is missing (set aside). */
  bad: () => J;
  /** The tier the source reads at (default plain; step 8c). */
  tier?: Tier;
  /** A page whose embedded data is not there (the format changed). */
  broken: Uint8Array;
};

export const pageFetcher = (url: string, body: Uint8Array | FetchError, tier: Tier = "plain"): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get(req) {
      if (urls.length >= 1) throw new FetchError("request_limit", "cap");
      urls.push(req.url);
      expect([req.maxBytes, req.timeoutMs, req.headers?.["User-Agent"]]).toEqual([2_000_000, 10_000, "side-income/0.1 personal-job-discovery"]);
      if (req.url !== url) throw new FetchError("http_status", "HTTP 404", 404);
      if (body instanceof FetchError) throw body;
      return { status: 200, body, tier };
    },
  };
};

const NOW = new Date("2026-11-17T00:00:00Z");

export function describeOnePageSource<J>(s: OnePage<J>): void {
  const tier = s.tier ?? "plain";
  const run = (body: Uint8Array | FetchError) => s.settings.connector(pageFetcher(s.index, body, tier), NOW);

  describe(`${s.settings.name} connector`, () => {
    it(`reads its one page with one ${tier} request and keeps every listing (no rule of its own)`, async () => {
      const f = pageFetcher(s.index, s.page([s.good(1), s.good(2)]), tier);
      const got = await s.settings.connector(f, NOW);
      expect([f.urls, got.seen, got.listings.map((l) => l.external_id), got.rejected]).toEqual([[s.index], 2, [s.id(1), s.id(2)], 0]);
      expect(got.listings.map(got.sourceKept)).toEqual([true, true]);
      expect([s.settings.maxTier, s.settings.maxRequestsPerRun, s.settings.completeRead, s.settings.disabled]).toEqual([tier, 1, false, null]);
    });

    it("sets aside one entry without its identity between good ones", async () => {
      const got = await run(s.page([s.good(1), s.bad(), s.good(2)]));
      expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([[s.id(1), s.id(2)], 1, 3]);
    });

    it("keeps the last of one listing shown twice", async () => {
      const got = await run(s.page([s.good(1), s.retitled(1)]));
      expect(got.listings.map((l) => [l.external_id, l.title])).toEqual([[s.id(1), "Retitled"]]);
    });

    it("fails the source on a page without its data, without entries, over 200 entries, a challenge or a failed read", async () => {
      await expect(run(s.broken)).rejects.toThrow(new RegExp(s.settings.name));
      await expect(run(s.page([]))).rejects.toThrow(/no job/);
      await expect(run(s.page(Array.from({ length: 201 }, (_, i) => s.good(i + 1))))).rejects.toThrow(/more than 200/);
      await expect(run(new TextEncoder().encode("<html><title>Just a moment...</title></html>"))).rejects.toThrow(/access challenge/);
      // DataDome's interstitial (Wellfound is known to use it) is a challenge, not a format change.
      await expect(run(new TextEncoder().encode('<html><script src="https://ct.captcha-delivery.com/c.js"></script></html>'))).rejects.toThrow(/access challenge/);
      // Akamai's behavioural challenge (Remote.co, step 8c), answered with 200.
      await expect(run(new TextEncoder().encode('<html><body><div id="sec-if-cpt-container" role="main"></div></body></html>'))).rejects.toThrow(/access challenge/);
      await expect(run(new FetchError("http_status", "HTTP 403", 403))).rejects.toThrow(/403/);
    });
  });

  describe(`${s.settings.name} into intake (collectSource)`, () => {
    let db: PgDb, close: () => Promise<void>;
    beforeAll(async () => ({ db, close } = await freshPg()));
    afterAll(async () => close());
    beforeEach(async () => db.execute(sql`truncate listings cascade`));
    const settings = { ...s.settings, order: 0 };
    const collect = (body: Uint8Array | FetchError) => collectSource(db, settings, NOW, pageFetcher(s.index, body, tier));
    const stored = async (i: number) => (await listingBy(db, s.settings.name, s.id(i)))?.sourceKept ?? null;

    it("writes every listing, kept (plan D9)", async () => {
      const got = await collect(s.page([s.good(1), s.good(2)]));
      expect([got.seen, [...got.externalIds].sort(), got.requests]).toEqual([2, [s.id(1), s.id(2)].sort(), 1]);
      expect([await stored(1), await stored(2)]).toEqual([true, true]);
    });

    it("writes the good ones when one is set aside; nothing when more than half are; exactly half is written", async () => {
      expect((await collect(s.page([s.good(1), s.bad(), s.good(2)]))).rejected).toBe(1);
      await db.execute(sql`truncate listings cascade`);
      await expect(collect(s.page([s.good(1), s.bad(), s.bad()]))).rejects.toThrow(/2 of 3 listings refused/);
      expect(await stored(1)).toBeNull();
      expect((await collect(s.page([s.good(1), s.bad()]))).externalIds).toEqual([s.id(1)]);
    });

    it("writes nothing when the source fails", async () => {
      await expect(collect(s.broken)).rejects.toThrow();
      expect(await stored(1)).toBeNull();
    });

    it("a second run of the same page adds no rows and changes nothing (D24)", async () => {
      const page = s.page([s.good(1), s.good(2)]);
      await collect(page);
      expect((await collect(page)).intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
    });
  });
}
