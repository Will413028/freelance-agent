import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingFeedback } from "@/db/pg/schema";
import { intakeListings, listingBy, pruneListings, RETENTION_DAYS } from "@/modules/listings/public";
import { freshPg } from "../../../tests/helpers/pg";

// Plan step 5a2-3: retention by days since the last sighting, never a listing with feedback.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const job = (id: string) => ({ external_id: id, title: "Backend API contractor", url: `https://example.com/jobs/${id}`, kind: "contract" });
const day = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 86_400_000);

describe("pruneListings", () => {
  it("deletes what no read showed for more than the retention days, keeps the rest, and reruns as a no-op", async () => {
    await intakeListings(db, "jobicy", [job("old"), job("kept")], "page", day(0));
    await intakeListings(db, "jobicy", [job("kept")], "page", day(20));
    // Exactly at the edge: still kept (strictly older than the cutoff goes).
    expect(await pruneListings(db, day(30), 30)).toBe(0);
    expect(await pruneListings(db, day(31), 30)).toBe(1);
    expect(await listingBy(db, "jobicy", "old")).toBeNull();
    expect(await listingBy(db, "jobicy", "kept")).not.toBeNull();
    expect(await pruneListings(db, day(31), 30)).toBe(0);
  });

  it("counts from last_seen_at, not first_seen_at or updated_at: a listing seen daily with the same content stays", async () => {
    for (let d = 0; d <= 60; d += 10) await intakeListings(db, "jobicy", [job("daily")], "page", day(d));
    expect(await pruneListings(db, day(61), 30)).toBe(0);
  });

  it("keeps a listing with any feedback, also neutral, however long unseen", async () => {
    await intakeListings(db, "jobicy", [job("saved"), job("reset"), job("none")], "page", day(0));
    for (const [id, state] of [["saved", "interested"], ["reset", "neutral"]] as const) {
      const row = await listingBy(db, "jobicy", id);
      await db.insert(listingFeedback).values({ listingId: row!.id, state, revision: 1 });
    }
    expect(await pruneListings(db, day(365), 30)).toBe(1);
    expect(await listingBy(db, "jobicy", "none")).toBeNull();
    expect(await listingBy(db, "jobicy", "saved")).not.toBeNull();
    expect(await listingBy(db, "jobicy", "reset")).not.toBeNull();
  });

  it("refuses a retention below one whole day and defaults to RETENTION_DAYS", async () => {
    await expect(pruneListings(db, day(0), 0)).rejects.toThrow(RangeError);
    await expect(pruneListings(db, day(0), 1.5)).rejects.toThrow(RangeError);
    await intakeListings(db, "jobicy", [job("x")], "page", day(0));
    expect(await pruneListings(db, day(RETENTION_DAYS))).toBe(0);
    expect(await pruneListings(db, day(RETENTION_DAYS + 1))).toBe(1);
  });
});

// Needs two connections: PGlite has one, so this runs only on a real server (CI sets TEST_PG_URL; the pool has max 2).
describe.skipIf(!process.env.TEST_PG_URL)("pruneListings under a concurrent save", () => {
  it("skips a listing whose row a feedback write holds locked", async () => {
    await intakeListings(db, "jobicy", [job("busy"), job("idle")], "page", day(0));
    const busy = await listingBy(db, "jobicy", "busy");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`select id from listings where id = ${busy!.id} for update`);
      locked();
      await held;
    });
    await isLocked;
    expect(await pruneListings(db, day(31), 30)).toBe(1);
    release();
    await writer;
    expect(await listingBy(db, "jobicy", "busy")).not.toBeNull();
  });
});
