import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { fingerprint, intakeListings, listingBy, listingOf, listingOfRow, parseListingInput, versionCount } from "@/modules/listings/public";
import { freshPg } from "../../../tests/helpers/pg";

// Plan steps 3a, 3b2: the listing data model and intake core on Postgres (PGlite here, a real server in CI).

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const job = (externalId: string, extra: Record<string, unknown> = {}) => ({
  external_id: externalId, title: "Backend API contractor", description: "Build an LLM automation backend",
  url: `https://example.com/jobs/${externalId}`, kind: "contract", ...extra,
});


describe("fingerprint", () => {
  it("ignores key order and extra, sees content changes", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1, extra: { received_at: "x" } })).toBe(fingerprint({ a: 1, extra: {} }));
    // A field added to the contract later (null for every existing listing) changes no fingerprint.
    expect(fingerprint({ a: 1, added: null })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("is the same for a listing written with or without its defaulted fields (computed on the parsed contract)", async () => {
    await intakeListings(db, "jobicy", [job("1")], "page");
    expect(await intakeListings(db, "jobicy", [{ ...job("1"), company: null, deadline: null, extra: {} }], "page")).toMatchObject({ unchanged: 1 });
  });
});

describe("intake", () => {
  it("stores a listing the source's rule drops, marked, and re-reads the mark at each sighting (plan D9)", async () => {
    const t0 = new Date("2026-11-01T00:00:00Z"), t1 = new Date("2026-11-02T00:00:00Z");
    expect(await intakeListings(db, "jobicy", [job("1"), job("2")], "page", t0, { sourceKept: (id) => id === "1" })).toMatchObject({ inserted: 2 });
    expect([(await listingBy(db, "jobicy", "1"))?.sourceKept, (await listingBy(db, "jobicy", "2"))?.sourceKept]).toEqual([true, false]);
    // Same content, the rule now says otherwise (a date-dependent rule): the mark follows, updated_at does not.
    expect(await intakeListings(db, "jobicy", [job("1"), job("2")], "page", t1, { sourceKept: (id) => id === "2" })).toMatchObject({ unchanged: 2 });
    const [a, b] = [await listingBy(db, "jobicy", "1"), await listingBy(db, "jobicy", "2")];
    expect([a?.sourceKept, b?.sourceKept, a?.updatedAt, b?.updatedAt]).toEqual([false, true, t0, t0]);
  });

  it("writes last_seen_at at every sighting and updated_at only when the content changes", async () => {
    const t0 = new Date("2026-11-01T00:00:00Z"), t1 = new Date("2026-11-02T00:00:00Z"), t2 = new Date("2026-11-03T00:00:00Z");
    await intakeListings(db, "jobicy", [job("1")], "page", t0);
    await intakeListings(db, "jobicy", [job("1")], "page", t1);
    let r = await listingBy(db, "jobicy", "1");
    expect([r?.firstSeenAt, r?.updatedAt, r?.lastSeenAt]).toEqual([t0, t0, t1]);
    await intakeListings(db, "jobicy", [job("1", { title: "Changed" })], "page", t2);
    r = await listingBy(db, "jobicy", "1");
    expect([r?.firstSeenAt, r?.updatedAt, r?.lastSeenAt]).toEqual([t0, t2, t2]);
  });

  it("marks gone what a complete read no longer shows, only for complete reads, and clears it when seen again", async () => {
    const t0 = new Date("2026-11-01T00:00:00Z"), t1 = new Date("2026-11-02T00:00:00Z"), t2 = new Date("2026-11-03T00:00:00Z"), t3 = new Date("2026-11-04T00:00:00Z");
    await intakeListings(db, "jobicy", [job("1"), job("2")], "page", t0, { complete: true });
    await intakeListings(db, "arbeitnow", [job("9")], "page", t0, { complete: true });
    // Not complete (latest-N window, truncated, ...): what is missing is not taken as gone.
    await intakeListings(db, "jobicy", [job("1")], "page", t1);
    expect((await listingBy(db, "jobicy", "2"))?.goneAt).toBeNull();
    await intakeListings(db, "jobicy", [job("1")], "page", t2, { complete: true });
    // Another source's rows and rows already gone keep their gone_at.
    expect([(await listingBy(db, "jobicy", "1"))?.goneAt, (await listingBy(db, "jobicy", "2"))?.goneAt, (await listingBy(db, "arbeitnow", "9"))?.goneAt]).toEqual([null, t2, null]);
    await intakeListings(db, "jobicy", [job("1")], "page", t3, { complete: true });
    expect((await listingBy(db, "jobicy", "2"))?.goneAt).toEqual(t2);
    await intakeListings(db, "jobicy", [job("2")], "page", t3);
    expect((await listingBy(db, "jobicy", "2"))?.goneAt).toBeNull();
    // An empty read is never complete.
    await intakeListings(db, "jobicy", [], "page", t3, { complete: true });
    expect((await listingBy(db, "jobicy", "2"))?.goneAt).toBeNull();
  });

  it("inserts, then leaves the same content unchanged and keeps first_seen_at", async () => {
    expect(await intakeListings(db, "jobicy", [job("1"), job("2")], "page")).toMatchObject({ inserted: 2 });
    const first = await listingBy(db, "jobicy", "1");
    expect(first).toMatchObject({ source: "jobicy", externalId: "1", title: "Backend API contractor", taiwanEligible: null, categoryScore: 85 });
    expect(await intakeListings(db, "jobicy", [job("1", { extra: { received_at: "later" } })], "page")).toMatchObject({ unchanged: 1 });
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
    const mail = (title: string) => job("m1", { title });
    await intakeListings(db, "tasker", [mail("Newer content")], "mail", new Date("2026-11-10T00:00:00Z"));
    expect(await intakeListings(db, "tasker", [mail("Older content")], "mail", new Date("2026-11-11T00:00:00Z"))).toMatchObject({ versioned: 1 });
    const row = (await listingBy(db, "tasker", "m1"))!;
    expect(row.title).toBe("Newer content");
    expect(await versionCount(db, row.id)).toBe(2);
    // The same contradicting mail again adds nothing and is counted unchanged.
    expect(await intakeListings(db, "tasker", [mail("Older content")], "mail", new Date("2026-11-12T00:00:00Z"))).toMatchObject({ versioned: 0, unchanged: 1 });
    expect(await versionCount(db, row.id)).toBe(2);
    // The first content's version keeps when it was seen and the row's fingerprint.
    const versions = await db.execute(sql`select fingerprint, observed_at from listing_versions where listing_id = ${row.id} order by observed_at`) as unknown as { rows: { fingerprint: string; observed_at: Date | string }[] };
    expect(versions.rows[0].fingerprint).toBe(row.fingerprint);
    expect(new Date(versions.rows[0].observed_at)).toEqual(row.updatedAt);
  });

  it("refuses a batch naming one external_id twice, and writes nothing of a failing batch", async () => {
    await expect(intakeListings(db, "jobicy", [job("1"), job("1")], "page")).rejects.toThrow(/twice/);
    await expect(intakeListings(db, "jobicy", [job("2"), job("3", { title: "" })], "page")).rejects.toThrow(/title/);
    await expect(intakeListings(db, "jobicy", [job("2"), job("4", { deadline: "2026-12-01" })], "page")).rejects.toThrow(/deadline/);
    expect(await listingBy(db, "jobicy", "2")).toBeNull();
  });

  it("stores text Postgres refuses (NUL, lone surrogates) cleaned, and undefined keys do not change the fingerprint", async () => {
    await intakeListings(db, "jobicy", [job("1", { title: "a\u0000b", description: "x\ud800y", company: undefined })], "page");
    const row = (await listingBy(db, "jobicy", "1"))!;
    expect(row).toMatchObject({ title: "ab", description: "x\ufffdy" });
    expect(await intakeListings(db, "jobicy", [job("1", { title: "a\u0000b", description: "x\ud800y" })], "page")).toMatchObject({ unchanged: 1 });
    expect(fingerprint(row.raw as Record<string, unknown>)).toBe(row.fingerprint);
  });

  it("stores the deadline as kind, text and expiry, and reads a row back to the same typed listing", async () => {
    const deadlines = [{ kind: "date", date: "2026-12-01" }, { kind: "instant", at: "2026-12-01T18:00:00+08:00" }, { kind: "no_timezone", text: "2026-12-01 10:00" }, { kind: "invalid", text: "soon" }, null];
    await intakeListings(db, "jobicy", deadlines.map((deadline, i) => job(String(i), { deadline, published_at: "2026-11-01T00:00:00Z" })), "page");
    for (const [i, deadline] of deadlines.entries()) {
      const row = (await listingBy(db, "jobicy", String(i)))!;
      expect(listingOfRow(row)).toEqual(listingOf(parseListingInput(job(String(i), { deadline, published_at: "2026-11-01T00:00:00Z" }))));
    }
    expect(await listingBy(db, "jobicy", "0")).toMatchObject({ deadlineKind: "date", deadlineText: "2026-12-01", deadlineAt: new Date("2026-12-01T16:00:00Z") });
    expect(await listingBy(db, "jobicy", "3")).toMatchObject({ deadlineKind: "invalid", deadlineText: "soon", deadlineAt: null });
  });

  it("first_seen_at and updated_at both come from the observation time", async () => {
    const t = new Date("2026-11-01T00:00:00Z");
    await intakeListings(db, "jobicy", [job("1")], "page", t);
    expect(await listingBy(db, "jobicy", "1")).toMatchObject({ firstSeenAt: t, updatedAt: t });
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

  it("keys a listing by a database id and keeps (source, external_id) unique", async () => {
    await intakeListings(db, "jobicy", [job("1")], "page");
    await intakeListings(db, "remotive", [job("1")], "page");
    const [a, b] = [await listingBy(db, "jobicy", "1"), await listingBy(db, "remotive", "1")];
    expect(Number.isInteger(a!.id) && Number.isInteger(b!.id) && a!.id !== b!.id).toBe(true);
    await expect(db.execute(sql`insert into listings (source, external_id, fingerprint, raw, title, kind, category, category_score, hard_excluded, confirmed_base, source_kept)
      select source, external_id, fingerprint, raw, title, kind, category, category_score, hard_excluded, confirmed_base, source_kept from listings where id = ${a!.id}`)).rejects.toMatchObject({ cause: { code: "23505" } }); // unique_violation
  });

  it("feedback events are one per listing revision and states are closed", async () => {
    await intakeListings(db, "jobicy", [job("1")], "page");
    const id = (await listingBy(db, "jobicy", "1"))!.id;
    await db.execute(sql`insert into listing_feedback_events (listing_id, revision, state) values (${id}, 1, 'interested')`);
    await expect(db.execute(sql`insert into listing_feedback_events (listing_id, revision, state) values (${id}, 1, 'skipped')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into listing_feedback (listing_id, state, revision) values (${id}, 'applied', 1)`)).rejects.toThrow();
  });
});
