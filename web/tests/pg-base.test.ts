import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { health } from "@/app/_lib/health";
import { freshPg } from "./helpers/pg";

// The Postgres base (plan steps 2 and 3a): migrations, run constraints and healthz, on PGlite here and a real server in CI.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());

describe("postgres base", () => {
  it("migrations create the step 3 tables", async () => {
    // node-postgres and PGlite both return { rows }.
    const { rows } = (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`)) as unknown as { rows: { table_name: string }[] };
    expect(rows.map((r) => r.table_name)).toEqual([
      "listing_feedback", "listing_feedback_events", "listing_versions", "listings", "mail_cursors", "mail_messages", "run_sources", "runs", "settings",
    ]);
  });

  it("runs refuses a status outside running, succeeded, failed", async () => {
    await expect(db.execute(sql`insert into runs (local_date, status) values ('2026-11-17', 'done')`)).rejects.toThrow();
  });

  it("runs allows one row per day", async () => {
    await db.execute(sql`insert into runs (local_date, status) values ('2026-11-16', 'running')`);
    await expect(db.execute(sql`insert into runs (local_date, status) values ('2026-11-16', 'running')`)).rejects.toThrow();
  });

  it("healthz is 200 when Postgres answers and 503 when it does not", async () => {
    expect((await health(() => db)).status).toBe(200);
    const broken = { execute: () => Promise.reject(new Error("connection refused")) } as unknown as PgDb;
    const res = await health(() => broken);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});
