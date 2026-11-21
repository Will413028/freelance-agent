import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { mlcontestsConnector, MLCONTESTS_SETTINGS, normalize, PAGE_URL, parsePage, scan } from ".";
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

/** HTML-escapes an attribute value the way the page does. */
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const page = (list: unknown) => `<!doctype html><html><body><div id="x" data-competitions="${escape(JSON.stringify(list))}"></div></body></html>`;
const serving = (body: string): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get({ url }) {
      urls.push(url);
      if (url !== PAGE_URL) throw new FetchError("network", "unknown url");
      return { status: 200, body: new TextEncoder().encode(body), tier: "plain" };
    },
  };
};

const competition = (slug: string, deadline: string, changes: Record<string, unknown> = {}) => ({
  name: `Example ${slug}`, url: `https://www.kaggle.com/competitions/${slug}?ref=mlcontests`, platform: "Kaggle", sponsor: null, deadline,
  "registration-deadline": null, prize: "$1,000", "additional-prizes": null, tags: [], ...changes,
});
const id = (slug: string) => `https://www.kaggle.com/competitions/${slug}`;
// 2026-11-22 10:00 in Taipei.
const NOW = new Date("2026-11-22T02:00:00Z");

describe("mlcontests connector over its fixture", () => {
  it(`${cases.normalize.length} payloads give the expected contest, field or refusal`, () => {
    const wrong = (e: NormalizeCase["expect"], got: Record<string, unknown>) =>
      "error" in e ? !("error" in got)
      : "field" in e && "value" in e && Object.keys(e).length === 2 ? "error" in got || JSON.stringify(got[e.field as string]) !== JSON.stringify(e.value)
      : JSON.stringify(got) !== JSON.stringify(e);
    const bad = cases.normalize.map((c) => ({ c, got: run(c.payload) })).filter(({ c, got }) => wrong(c.expect, got)).map(({ c, got }) => ({ why: c.why, expect: c.expect, got }));
    expect(bad).toEqual([]);
  });
});

describe("mlcontests page", () => {
  it("reads the open competitions of the one page: deadline today or later in Taipei", async () => {
    const f = serving(page([competition("past", "21 Nov 2026"), competition("today", "22 Nov 2026"), competition("later", "5 Jan 2027")]));
    const got = await mlcontestsConnector(f, NOW);
    expect([f.urls, got.seen, got.listings.map((l) => l.external_id), got.truncated, got.rejected]).toEqual([[PAGE_URL], 3, [id("today"), id("later")], false, 0]);
    expect(got.listings.every(got.sourceKept)).toBe(true);
    expect(MLCONTESTS_SETTINGS.maxRequestsPerRun).toBe(1);
  });

  it("a deadline day is today in Taipei while it is still yesterday in UTC", () => {
    // 2026-11-21 17:00 UTC is 2026-11-22 01:00 in Taipei: a 21 Nov deadline has passed.
    const got = scan([competition("a", "21 Nov 2026"), competition("b", "22 Nov 2026")], new Date("2026-11-21T17:00:00Z"));
    expect(got.listings.map((l) => l.external_id)).toEqual([id("b")]);
  });

  it("sets aside a competition whose deadline it cannot read, and keeps the others", () => {
    const got = scan([competition("a", "11 Dec 2026 Jan 2027"), competition("b", "5 Jan 2027"), competition("c", "5 Jan 2027", { url: "ftp://x" })], NOW);
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([[id("b")], 2, 3]);
  });

  it("leaves out uncounted an unreadable deadline whose months have all ended, so the read stays complete", () => {
    const got = scan([competition("a", "11 May 2026 Apr 2026"), competition("b", "5 Jan 2027")], NOW);
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined, got.truncated]).toEqual([[id("b")], 0, 1, false]);
    // The current month is not over: still set aside.
    expect(scan([competition("a", "1 Oct 2026 Nov 2026")], NOW)).toMatchObject({ rejected: 1, examined: 1 });
  });

  it("two open entries with the same URL are kept once, as last read, and the read is not complete", () => {
    const got = scan([competition("a", "5 Jan 2027"), competition("a", "6 Jan 2027", { url: `${id("a")}?utm_source=mlcontest` })], NOW);
    expect([got.listings.map((l) => l.deadline), got.truncated]).toEqual([[{ kind: "date", date: "2027-01-06" }], true]);
  });

  it("refuses a page without the list, or whose list is not a JSON array", () => {
    for (const body of ["<html></html>", '<div data-competitions="x"></div>', `<div data-competitions="${escape("{}")}"></div>`, page([]) + page([])]) {
      expect(() => parsePage(new TextEncoder().encode(body))).toThrow(/mlcontests/);
    }
  });

  it("reads numeric character references in the attribute", () => {
    const body = `<div data-competitions="[{&#34;name&#34;:&#x22;A &amp; B&#x22;}]"></div>`;
    expect(parsePage(new TextEncoder().encode(body))).toEqual([{ name: "A & B" }]);
  });
});

describe("mlcontests through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));

  it("stores contests, an unknown prize as null, and a second read inserts no rows though the tracking parameter changed", async () => {
    const list = [competition("a", "5 Jan 2027"), competition("b", "6 Jan 2027", { prize: null })];
    const first = await collectSource(db, "mlcontests", NOW, serving(page(list)));
    expect(first.intake).toEqual({ inserted: 2, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "mlcontests", id("a"))).toMatchObject({ opportunityType: "contest", budgetMax: 1000, currency: "USD", deadlineKind: "date", deadlineText: "2027-01-05", online: null });
    expect(await listingBy(db, "mlcontests", id("b"))).toMatchObject({ budgetMax: null, currency: null, prizeText: null, inviteOnly: null, hardExcluded: false });
    const again = list.map((c) => ({ ...c, url: c.url.replace("?ref=mlcontests", "?ref=mlc") }));
    const second = await collectSource(db, "mlcontests", new Date(NOW.getTime() + 3_600_000), serving(page(again)));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });

  it("marks a competition gone once its deadline passed, with a past entry of unreadable deadline on the page", async () => {
    const list = [competition("a", "5 Jan 2027"), competition("b", "22 Nov 2026"), competition("old", "11 May 2026 Apr 2026")];
    await collectSource(db, "mlcontests", NOW, serving(page(list)));
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    await collectSource(db, "mlcontests", tomorrow, serving(page(list)));
    expect([(await listingBy(db, "mlcontests", id("a")))?.goneAt, (await listingBy(db, "mlcontests", id("b")))?.goneAt]).toEqual([null, tomorrow]);
  });
});
