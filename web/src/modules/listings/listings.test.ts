import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { fingerprint, intakeListings, listingBy, listingId, versionCount } from "@/modules/listings/public";
import fixtures from "./id.fixtures.json";
import { freshPg } from "../../../tests/helpers/pg";

// Plan step 3a: the listing data model and intake core on Postgres (PGlite here, a real server in CI).

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const job = (externalId: string, extra: Record<string, unknown> = {}) => ({
  source: "jobicy", external_id: externalId, title: "Backend API contractor", description: "Build an LLM automation backend",
  url: `https://example.com/jobs/${externalId}`, kind: "contract", ...extra,
});

describe("listing id", () => {
  it("reproduces every id the old system computed for the synthetic pairs", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(20);
    for (const c of fixtures.cases) expect(listingId(c.source, c.external_id), `${c.source}/${c.external_id}`).toBe(c.id);
  });

  it("refuses empty parts and lone surrogates", () => {
    expect(() => listingId("", "1")).toThrow();
    expect(() => listingId("jobicy", "\ud800x")).toThrow();
  });
});

describe("fingerprint", () => {
  it("ignores key order and observation fields, sees content changes", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1, received_at: "x", receipt_id: "r" })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("intake", () => {
  it("inserts, then leaves the same content unchanged and keeps first_seen_at", async () => {
    expect(await intakeListings(db, "jobicy", [job("1"), job("2")], "page")).toMatchObject({ inserted: 2 });
    const first = await listingBy(db, "jobicy", "1");
    expect(first).toMatchObject({ id: listingId("jobicy", "1"), title: "Backend API contractor", taiwanEligible: null, categoryScore: 85 });
    expect(await intakeListings(db, "jobicy", [job("1", { received_at: "later" })], "page")).toMatchObject({ unchanged: 1 });
    expect((await listingBy(db, "jobicy", "1"))!.firstSeenAt).toEqual(first!.firstSeenAt);
  });

  it("a page source overwrites new content, also back to content it had before (plan D6)", async () => {
    await intakeListings(db, "jobicy", [job("1", { title: "A" })], "page");
    expect(await intakeListings(db, "jobicy", [job("1", { title: "B" })], "page")).toMatchObject({ updated: 1 });
    expect(await intakeListings(db, "jobicy", [job("1", { title: "A" })], "page")).toMatchObject({ updated: 1 });
    const row = (await listingBy(db, "jobicy", "1"))!;
    expect(row.title).toBe("A");
    expect(await versionCount(db, row.id)).toBe(0);
  });

  it("a mail listing keeps its first content; a later older mail adds a version, not an overwrite", async () => {
    const mail = (title: string, receivedAt: string) => ({ ...job("m1", { title, received_at: receivedAt }), source: "tasker" });
    await intakeListings(db, "tasker", [mail("Newer content", "2026-11-10T00:00:00Z")], "mail");
    expect(await intakeListings(db, "tasker", [mail("Older content", "2026-11-01T00:00:00Z")], "mail")).toMatchObject({ versioned: 1 });
    const row = (await listingBy(db, "tasker", "m1"))!;
    expect(row.title).toBe("Newer content");
    expect(await versionCount(db, row.id)).toBe(2);
    // The same contradicting mail again adds nothing.
    await intakeListings(db, "tasker", [mail("Older content", "2026-11-02T00:00:00Z")], "mail");
    expect(await versionCount(db, row.id)).toBe(2);
  });

  it("refuses a batch naming one external_id twice, and writes nothing of a failing batch", async () => {
    await expect(intakeListings(db, "jobicy", [job("1"), job("1")], "page")).rejects.toThrow(/twice/);
    await expect(intakeListings(db, "jobicy", [job("2"), job("3", { title: "" })], "page")).rejects.toThrow(/title/);
    expect(await listingBy(db, "jobicy", "2")).toBeNull();
  });

  it("the database allows one row per (source, external_id)", async () => {
    await intakeListings(db, "jobicy", [job("1")], "page");
    await expect(db.execute(sql`insert into listings (id, source, external_id, fingerprint, raw, title, category, category_score, hard_excluded, confirmed_base)
      values ('other-id', 'jobicy', '1', 'f', '{}', 't', '其他', 0, true, 0)`)).rejects.toThrow();
  });
});

describe("schema constraints", () => {
  it("settings is one row with valid ranges and categories", async () => {
    await db.execute(sql`insert into settings (id, revision, max_weekly_hours, min_fixed_twd, categories) values (1, 1, 30, 3000, array['AI agent'])`);
    await expect(db.execute(sql`insert into settings (id, revision, max_weekly_hours, min_fixed_twd, categories) values (2, 1, 30, 3000, array['AI agent'])`)).rejects.toThrow();
    await expect(db.execute(sql`update settings set max_weekly_hours = 169`)).rejects.toThrow();
    await expect(db.execute(sql`update settings set categories = array['其他']`)).rejects.toThrow();
    await expect(db.execute(sql`update settings set categories = array[]::text[]`)).rejects.toThrow();
    await db.execute(sql`delete from settings`);
  });

  it("feedback events are one per listing revision and states are closed", async () => {
    await intakeListings(db, "jobicy", [job("1")], "page");
    const id = listingId("jobicy", "1");
    await db.execute(sql`insert into listing_feedback_events (listing_id, revision, state) values (${id}, 1, 'interested')`);
    await expect(db.execute(sql`insert into listing_feedback_events (listing_id, revision, state) values (${id}, 1, 'skipped')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into listing_feedback (listing_id, state, revision) values (${id}, 'applied', 1)`)).rejects.toThrow();
  });
});
