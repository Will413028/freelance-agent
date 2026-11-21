import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { DEVPOST_SETTINGS, devpostConnector, MAX_PAGES, normalize, pageUrl, scan } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Opportunity types plan step 5. fixtures/cases.json is the connector's ground truth: synthetic hackathons
// shaped on the fields measured in the plan's sources.md (no captured page).

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

const hackathon = (id: number, changes: Record<string, unknown> = {}) => ({
  id, title: `Example Hackathon ${id}`, url: `https://example-${id}.devpost.com/`, open_state: "open", organization_name: "Example Org",
  displayed_location: { icon: "globe", location: "Online" }, submission_period_dates: "Nov 03 - Dec 15, 2026", invite_only: false, winners_announced: false,
  prize_amount: "$<span data-currency-value>1,000</span>", ...changes,
});
/** The API's pages for these hackathons, 2 a page, with an empty page after the last. */
const api = (all: unknown[], total = all.length) => {
  const pages: Record<string, string> = {};
  for (let p = 1; (p - 1) * 2 <= all.length; p++) pages[pageUrl(p)] = JSON.stringify({ hackathons: all.slice((p - 1) * 2, p * 2), meta: { total_count: total, per_page: 2 } });
  return pages;
};

describe("devpost connector over its fixture", () => {
  it(`${cases.normalize.length} payloads give the expected contest, field or refusal`, () => {
    const wrong = (e: NormalizeCase["expect"], got: Record<string, unknown>) =>
      "error" in e ? !("error" in got)
      : "field" in e && "value" in e && Object.keys(e).length === 2 ? "error" in got || JSON.stringify(got[e.field as string]) !== JSON.stringify(e.value)
      : JSON.stringify(got) !== JSON.stringify(e);
    const bad = cases.normalize.map((c) => ({ c, got: run(c.payload) })).filter(({ c, got }) => wrong(c.expect, got)).map(({ c, got }) => ({ why: c.why, expect: c.expect, got }));
    expect(bad).toEqual([]);
  });
});

describe("devpost pages", () => {
  it("reads page after page until every open hackathon is read, each once", async () => {
    const f = serving(api([1, 2, 3, 4, 5].map((id) => hackathon(id))));
    const got = await devpostConnector(f);
    expect([f.urls, got.seen, got.listings.map((l) => l.external_id), got.truncated]).toEqual([[1, 2, 3].map(pageUrl), 5, ["1", "2", "3", "4", "5"], false]);
    expect(got.listings.every(got.sourceKept)).toBe(true);
  });

  it("keeps a hackathon that shifted onto a second page once, as last read, and says the read is not complete when one was missed", async () => {
    const pages = api([hackathon(1), hackathon(2), hackathon(2, { title: "Second reading" }), hackathon(4)], 5);
    const got = await scan(serving(pages));
    expect([got.listings.map((l) => l.title), got.truncated]).toEqual([["Example Hackathon 1", "Second reading", "Example Hackathon 4"], true]);
  });

  it("stops at the page cap its settings allow and marks the read truncated", async () => {
    const pages: Record<string, string> = {};
    for (let p = 1; p <= MAX_PAGES + 1; p++) pages[pageUrl(p)] = JSON.stringify({ hackathons: [hackathon(p)], meta: { total_count: 1000, per_page: 1 } });
    const f = serving(pages);
    const got = await scan(f);
    expect([f.urls.length, DEVPOST_SETTINGS.maxRequestsPerRun, got.listings.length, got.truncated]).toEqual([MAX_PAGES, MAX_PAGES, MAX_PAGES, true]);
  });

  it("sets aside one hackathon without its identity and keeps the others", async () => {
    const got = await scan(serving(api([hackathon(1), hackathon(2, { url: "https://example.com/" }), "x", hackathon(4)])));
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([["1", "4"], 2, 4]);
  });

  it("refuses a page that is not JSON, has no list or no total", async () => {
    for (const body of ["<html>", JSON.stringify({ items: [] }), JSON.stringify({ hackathons: [hackathon(1)] }), JSON.stringify({ hackathons: [hackathon(1)], meta: { total_count: "1" } })]) {
      await expect(scan(serving({ [pageUrl(1)]: body }))).rejects.toThrow(/devpost/);
    }
  });

  it("an empty list reads nothing and is not truncated", async () => {
    expect(await scan(serving(api([])))).toMatchObject({ seen: 0, listings: [], truncated: false });
  });
});

describe("devpost through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-11-21T02:00:00Z");

  it("stores contests, an unknown prize and deadline as null, and a second read inserts no rows", async () => {
    const pages = api([hackathon(1), hackathon(2, { prize_amount: undefined, submission_period_dates: undefined, invite_only: true }), hackathon(3)]);
    const first = await collectSource(db, "devpost", NOW, serving(pages));
    expect(first.intake).toEqual({ inserted: 3, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "devpost", "1")).toMatchObject({ opportunityType: "contest", budgetMax: 1000, currency: "USD", prizeText: "$1,000", deadlineText: "2026-12-15", hackathon: true, online: true });
    expect(await listingBy(db, "devpost", "2")).toMatchObject({ budgetMin: null, budgetMax: null, currency: null, prizeText: null, deadlineKind: null, deadlineAt: null, inviteOnly: true, sourceKept: true, hardExcluded: false });
    const second = await collectSource(db, "devpost", new Date(NOW.getTime() + 86_400_000), serving(pages));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 3, versioned: 0 });
  });

  it("marks a hackathon gone when a complete read no longer lists it, and not when the read was cut short", async () => {
    await collectSource(db, "devpost", NOW, serving(api([hackathon(1), hackathon(2), hackathon(3)])));
    await collectSource(db, "devpost", NOW, serving(api([hackathon(1), hackathon(2)], 3)));
    expect((await listingBy(db, "devpost", "3"))?.goneAt).toBeNull();
    await collectSource(db, "devpost", NOW, serving(api([hackathon(1), hackathon(2)])));
    expect((await listingBy(db, "devpost", "3"))?.goneAt).toEqual(NOW);
  });
});
