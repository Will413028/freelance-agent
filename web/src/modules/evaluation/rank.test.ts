import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { intakeListings, listingBy, listingOf, parseListingInput } from "@/modules/listings/public";
import { freshPg } from "../../../tests/helpers/pg";
import { recommend, rankFactsOf } from "./evaluate";
import { DEFAULT_SETTINGS, rankedPage, readRankables, readSettings } from "./list";
import { byRank, excluded, rank, type RankFacts, type Settings } from "./rank";

// Plan step 3b: ranking over the stored facts (versions, candidates, saved bonus, order, views) and
// defect B1 (step-3-design.md).

const now = new Date("2026-11-15T01:00:00Z");
const job = (externalId: string, extra: Record<string, unknown> = {}) => ({
  external_id: externalId, title: "AI agent workflow", description: "Build an agent with tool calling",
  url: `https://example.com/jobs/${externalId}`, kind: "contract", taiwan_eligible: true, timezone_compatible: true, weekly_hours: 10,
  complete: true, published_at: "2026-11-14T12:00:00Z", ...extra,
});
const typed = (extra: Record<string, unknown> = {}) => listingOf(parseListingInput(job("1", extra)));
const date = (d: string) => ({ deadline: { kind: "date", date: d } });
const facts = (fingerprint: string, extra: Record<string, unknown> = {}): RankFacts => rankFactsOf(fingerprint, typed(extra));

describe("B1: a date-only deadline expires at the Asia/Taipei day boundary", () => {
  it("excludes deadline D at D+1 00:30 Taipei (UTC D 16:30), which the old UTC boundary did not", () => {
    const f = facts("a", date("2026-12-01"));
    expect(excluded(f, DEFAULT_SETTINGS, new Date("2026-12-01T15:59:59Z"))).toBe(false);
    expect(excluded(f, DEFAULT_SETTINGS, new Date("2026-12-01T16:30:00Z"))).toBe(true);
  });
});

describe("rank", () => {
  const base = { id: 1, feedback: "neutral" as const, versions: [] };

  it("scores category × 0.7, 2.5 per confirmed condition and freshness, in tenths", () => {
    // AI agent 95 × 7 + 25 × (3 confirmed + hours within 30) + published within two days.
    expect(rank({ ...base, listing: facts("a") }, DEFAULT_SETTINGS, now).scoreTenths).toBe(665 + 100 + 100);
    expect(rank({ ...base, listing: facts("a", { published_at: "2026-11-10T01:00:00Z" }) }, DEFAULT_SETTINGS, now).scoreTenths).toBe(665 + 100 + 60);
    expect(rank({ ...base, listing: facts("a", { published_at: "2026-11-20T01:00:00Z" }) }, DEFAULT_SETTINGS, now).scoreTenths).toBe(665 + 100);
  });

  it("adds 10 points when saved, capped at 100, and a skipped listing is no candidate", () => {
    const strong = { ...base, listing: facts("a"), feedback: "interested" as const };
    expect(rank(strong, DEFAULT_SETTINGS, now)).toMatchObject({ scoreTenths: 965, candidate: true });
    const s: Settings = { ...DEFAULT_SETTINGS };
    const capped = rankFactsOf("a", typed());
    expect(rank({ ...strong, listing: { ...capped, categoryScore: 140 } }, s, now).scoreTenths).toBe(1000);
    expect(rank({ ...base, listing: facts("a"), feedback: "skipped" }, DEFAULT_SETTINGS, now).candidate).toBe(false);
  });

  it("takes the best still-possible version, and a listing excluded but with a possible version is a candidate", () => {
    const listing = facts("a", { weekly_hours: 50 }); // over the 30 hour limit: excluded
    const weaker = facts("b", { taiwan_eligible: null });
    const stronger = facts("c");
    const r = rank({ ...base, listing, versions: [listing, weaker, stronger] }, DEFAULT_SETTINGS, now);
    expect(r).toMatchObject({ candidate: true, basis: "c", scoreTenths: rank({ ...base, listing: stronger }, DEFAULT_SETTINGS, now).scoreTenths });
    const expiredStronger = facts("d", date("2026-11-01"));
    expect(rank({ ...base, listing, versions: [listing, weaker, expiredStronger] }, DEFAULT_SETTINGS, now).basis).toBe("b");
    const leftOut = facts("e"); // AI agent, outside a settings choice of 後端／API only
    expect(rank({ ...base, listing: weaker, versions: [weaker, leftOut] }, { ...DEFAULT_SETTINGS, categories: ["後端／API"] }, now)).toMatchObject({ candidate: false, basis: "b" });
  });

  it("scores an all-excluded listing by its own content and leaves it out of the candidates", () => {
    const listing = facts("a", { weekly_hours: 50 }), other = facts("b", { kind: "full_time" });
    expect(rank({ ...base, listing, versions: [listing, other] }, DEFAULT_SETTINGS, now)).toMatchObject({ candidate: false, basis: "a" });
  });

  it("orders candidates first, then the higher score, then the id", () => {
    const items = [
      { id: 10, candidate: true, scoreTenths: 500, basis: "" }, { id: 9, candidate: true, scoreTenths: 500, basis: "" },
      { id: 2, candidate: false, scoreTenths: 900, basis: "" }, { id: 4, candidate: true, scoreTenths: 700, basis: "" },
    ];
    // Numeric id order (10 after 9), not text order.
    expect([...items].sort(byRank).map((i) => i.id)).toEqual([4, 9, 10, 2]);
  });

  it("matches recommend's score and basis for a listing with versions", () => {
    const contents = [{ fingerprint: "a", listing: typed({ weekly_hours: 50 }) }, { fingerprint: "b", listing: typed({ taiwan_eligible: null }) }, { fingerprint: "c", listing: typed() }];
    const r = recommend(contents[0], contents, "interested", DEFAULT_SETTINGS, now);
    const ranked = rank({ id: 1, feedback: "interested", listing: rankFactsOf("a", contents[0].listing), versions: contents.map((c) => rankFactsOf(c.fingerprint, c.listing)) }, DEFAULT_SETTINGS, now);
    expect({ score: r.score * 10, basis: r.basis }).toEqual({ score: ranked.scoreTenths, basis: ranked.basis });
    expect(r.reasons.at(-1)).toBe("通知內容有差異；依可能符合的一份排序，需核對原文");
  });

  it("never reaches the 100-point cap with the current categories, so comparing before or after it picks the same content", () => {
    // AI agent 95 × 0.7 + 4 confirmed × 2.5 + recent 10 + saved 10 = 96.5 points.
    const top = rank({ id: 1, feedback: "interested", listing: facts("a"), versions: [] }, { ...DEFAULT_SETTINGS, maxWeeklyHours: null }, now);
    expect(top.scoreTenths).toBe(965);
  });

  it("counts a fixed TWD budget as complete against the settings floor", () => {
    const fixed = { fingerprint: "a", listing: typed({ kind: "fixed", currency: "TWD", budget_min: 5000, budget_max: 20000, ...date("2099-01-01") }) };
    expect(recommend(fixed, [], "neutral", DEFAULT_SETTINGS, now).completeness).toBe(100);
    expect(recommend(fixed, [], "neutral", { ...DEFAULT_SETTINGS, minFixedTwd: 10000 }, now).completeness).toBe(83);
  });
});

describe("ranked read on Postgres", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => {
    await db.execute(sql`truncate listings cascade`);
    await db.execute(sql`delete from settings`);
  });

  it("reads the defaults at revision 0 and a saved row with its revision", async () => {
    expect(await readSettings(db)).toEqual({ revision: 0, settings: DEFAULT_SETTINGS });
    await db.execute(sql`insert into settings (id, revision, max_weekly_hours, min_fixed_twd, categories) values (1, 2, null, 5000, array['後端／API'])`);
    expect(await readSettings(db)).toEqual({ revision: 2, settings: { maxWeeklyHours: null, minFixedTwd: 5000, categories: ["後端／API"] } });
  });

  it("ranks listings with their versions and feedback, and pages each view", async () => {
    await intakeListings(db, "jobicy", [job("1"), job("2", { taiwan_eligible: null }), job("3", { weekly_hours: 50 })], "page", now);
    await intakeListings(db, "tasker", [job("m", { weekly_hours: 50 })], "mail", now);
    await intakeListings(db, "tasker", [job("m")], "mail", now);
    const [one, two, mail] = await Promise.all([listingBy(db, "jobicy", "1"), listingBy(db, "jobicy", "2"), listingBy(db, "tasker", "m")]);
    await db.execute(sql`insert into listing_feedback (listing_id, state, revision) values (${two!.id}, 'interested', 1), (${one!.id}, 'skipped', 1)`);
    const rankables = await readRankables(db);
    expect(rankables.find((r) => r.id === mail!.id)!.versions).toHaveLength(2);

    const all = await rankedPage(db, DEFAULT_SETTINGS, now, "all", 0);
    expect(all.total).toBe(4);
    expect(all.items.map((i) => i.candidate)).toEqual([true, true, false, false]);
    expect((await rankedPage(db, DEFAULT_SETTINGS, now, "candidates", 0)).items.map((i) => i.id).sort()).toEqual([two!.id, mail!.id].sort());
    expect((await rankedPage(db, DEFAULT_SETTINGS, now, "saved", 0)).items.map((i) => i.id)).toEqual([two!.id]);
    expect((await rankedPage(db, DEFAULT_SETTINGS, now, "skipped", 0)).items.map((i) => i.id)).toEqual([one!.id]);
    expect((await rankedPage(db, DEFAULT_SETTINGS, now, "all", 1)).items).toEqual([]);
    await expect(rankedPage(db, DEFAULT_SETTINGS, now, "all", -1)).rejects.toThrow(RangeError);
    await expect(rankedPage(db, DEFAULT_SETTINGS, now, "all", 1.5)).rejects.toThrow(RangeError);
    // A settings change reranks at read: lifting the hour limit makes listing 3 a candidate, with nothing rewritten.
    const lifted = await rankedPage(db, { ...DEFAULT_SETTINGS, maxWeeklyHours: null }, now, "candidates", 0);
    expect(lifted.total).toBe(3);
  });
});
