import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { MAX_PAGES, normalize, pageUrl, PER_PAGE, scan, ZINDI_SETTINGS, zindiConnector } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Opportunity types plan step 6a. fixtures/cases.json is the connector's ground truth: synthetic
// competitions shaped on the fields measured in the plan's sources.md (no captured page).

type NormalizeCase = { payload: unknown; expect: Record<string, unknown> | { error: true } | { field: string; value: unknown }; why: string };
const cases: { normalize: NormalizeCase[] } = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

const run = (payload: unknown): Record<string, unknown> => {
  try {
    return normalize(payload);
  } catch (e) {
    return { error: true, message: (e as Error).message };
  }
};

/** A Fetcher over {url: body}; an unknown URL fails as the network does. */
const serving = (pages: Record<string, string>): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get({ url }) {
      urls.push(url);
      if (!Object.hasOwn(pages, url)) throw new FetchError("network", "unknown url");
      return { status: 200, body: new TextEncoder().encode(pages[url]), tier: "plain" };
    },
  };
};

const competition = (id: string, changes: Record<string, unknown> = {}) => ({
  id, title: `Example ${id}`, organization: null, end_time: "2026-12-13T04:59:00.000Z", entries_close_at: null, reward: "$1 000 USD", reward_type: "prize",
  kind: "competition", open: true, secret_code_required: false, is_access_restricted: false, ...changes,
});
const closed = (id: string) => competition(id, { open: false });
/** The API's pages over this list (open ones first), PER_PAGE a page. */
const api = (all: unknown[], openCount = all.filter((c) => (c as { open: boolean }).open).length) => {
  const pages: Record<string, string> = {};
  for (let p = 0; p <= Math.ceil(all.length / PER_PAGE); p++) pages[pageUrl(p)] = JSON.stringify({ data: all.slice(p * PER_PAGE, (p + 1) * PER_PAGE), meta: { open_count: openCount, per_page: PER_PAGE } });
  return pages;
};
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

describe("zindi connector over its fixture", () => {
  it(`${cases.normalize.length} payloads give the expected contest, field or refusal`, () => {
    const wrong = (e: NormalizeCase["expect"], got: Record<string, unknown>) =>
      "error" in e ? !("error" in got)
      : "field" in e && "value" in e && Object.keys(e).length === 2 ? "error" in got || JSON.stringify(got[e.field as string]) !== JSON.stringify(e.value)
      : JSON.stringify(got) !== JSON.stringify(e);
    const bad = cases.normalize.map((c) => ({ c, got: run(c.payload) })).filter(({ c, got }) => wrong(c.expect, got)).map(({ c, got }) => ({ why: c.why, expect: c.expect, got }));
    expect(bad).toEqual([]);
  });
});

describe("zindi pages", () => {
  it("reads the open competitions and stops at the first closed one", async () => {
    const f = serving(api([...ids("open", 3).map((id) => competition(id)), ...ids("closed", 60).map(closed)]));
    const got = await zindiConnector(f);
    expect([f.urls, got.seen, got.listings.map((l) => l.external_id), got.truncated]).toEqual([[pageUrl(0)], 3, ids("open", 3), false]);
    expect(got.listings.every(got.sourceKept)).toBe(true);
  });

  it("reads on to the next page while a page is all open", async () => {
    const f = serving(api([...ids("open", PER_PAGE + 2).map((id) => competition(id)), closed("c")]));
    const got = await scan(f);
    expect([f.urls, got.listings.length, got.truncated]).toEqual([[pageUrl(0), pageUrl(1)], PER_PAGE + 2, false]);
  });

  it("a short page of open ones is the end of the list", async () => {
    const f = serving(api(ids("open", 2).map((id) => competition(id))));
    expect([(await scan(f)).truncated, f.urls]).toEqual([false, [pageUrl(0)]]);
  });

  it("a read with fewer open competitions than the list counts is not complete", async () => {
    expect((await scan(serving(api([competition("a"), closed("b")], 2)))).truncated).toBe(true);
  });

  it("an open competition after a closed one means the order changed: not complete", async () => {
    expect((await scan(serving(api([competition("a"), closed("b"), competition("c")], 1)))).truncated).toBe(true);
  });

  it("a competition shown twice is kept once, as last read, and the read is not complete", async () => {
    const got = await scan(serving(api([competition("a"), competition("a", { title: "Second reading" }), closed("b")], 2)));
    expect([got.listings.map((l) => l.title), got.truncated]).toEqual([["Second reading"], true]);
  });

  it("stops at the page cap and marks the read truncated", async () => {
    const f = serving(api(ids("open", PER_PAGE * (MAX_PAGES + 1)).map((id) => competition(id)), 10_000));
    const got = await scan(f);
    expect([f.urls.length, ZINDI_SETTINGS.maxRequestsPerRun, got.truncated]).toEqual([MAX_PAGES, MAX_PAGES, true]);
  });

  it("sets aside one competition without its identity and keeps the others", async () => {
    const got = await scan(serving(api([competition("a"), competition("../x"), competition("c"), closed("d")])));
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([["a", "c"], 1, 3]);
  });

  it("refuses a page that is not JSON, has no list or no open count", async () => {
    for (const body of ["<html>", JSON.stringify({ items: [] }), JSON.stringify({ data: [] }), JSON.stringify({ data: [], meta: { open_count: "1" } })]) {
      await expect(scan(serving({ [pageUrl(0)]: body }))).rejects.toThrow(/zindi/);
    }
  });

  it("an empty list reads nothing and is not truncated", async () => {
    expect(await scan(serving(api([])))).toMatchObject({ seen: 0, listings: [], truncated: false });
  });
});

describe("zindi through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-11-22T02:00:00Z");

  it("stores contests, an unknown prize and deadline as null, and a second read inserts no rows", async () => {
    const pages = api([competition("a"), competition("b", { reward: "3000 Points", reward_type: "points", end_time: null, secret_code_required: true }), closed("c")]);
    const first = await collectSource(db, "zindi", NOW, serving(pages));
    expect(first.intake).toEqual({ inserted: 2, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "zindi", "a")).toMatchObject({ opportunityType: "contest", budgetMax: 1000, currency: "USD", deadlineKind: "instant", hackathon: false, online: null });
    expect(await listingBy(db, "zindi", "b")).toMatchObject({ budgetMax: null, currency: null, prizeText: "3000 Points", deadlineKind: null, deadlineAt: null, inviteOnly: true, hardExcluded: false });
    const second = await collectSource(db, "zindi", new Date(NOW.getTime() + 86_400_000), serving(pages));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });

  it("marks a competition gone when a complete read no longer lists it as open, and not when the read was cut short", async () => {
    await collectSource(db, "zindi", NOW, serving(api([competition("a"), competition("b")])));
    await collectSource(db, "zindi", NOW, serving(api([competition("a"), closed("b")], 2)));
    expect((await listingBy(db, "zindi", "b"))?.goneAt).toBeNull();
    await collectSource(db, "zindi", NOW, serving(api([competition("a"), closed("b")])));
    expect((await listingBy(db, "zindi", "b"))?.goneAt).toEqual(NOW);
  });
});
