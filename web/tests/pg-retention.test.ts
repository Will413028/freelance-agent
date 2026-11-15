import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { intakeListings, listingBy, pruneListings } from "@/modules/listings/public";
import { freshPg } from "./helpers/pg";

// Plan step 5a2-3: retention against a concurrent feedback write. It runs only on a real server (CI reruns the whole suite with TEST_PG_URL).

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const job = (id: string) => ({ external_id: id, title: "Backend API contractor", url: `https://example.com/jobs/${id}`, kind: "contract" });
const day = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 86_400_000);

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
