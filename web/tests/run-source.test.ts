import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { runSource } from "@/modules/collection/run-source";
import { listSourceHealth } from "@/modules/collection/source-health";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required (a disposable Postgres database)");
const pool = new Pool({ connectionString: url });
const db = drizzle(pool, { schema });

beforeAll(async () => {
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public");
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(async () => { await pool.query("delete from source_health"); });
afterAll(async () => { await pool.end(); });

describe("runSource", () => {
  it("records ok when the source succeeds", async () => {
    expect(await runSource(db, "s1", async () => {})).toBe("ok");
    expect(await listSourceHealth(db)).toMatchObject([{ source: "s1", status: "ok" }]);
  });

  it("leaves failed when the source throws, even on its first run", async () => {
    expect(await runSource(db, "s1", async () => { throw new Error("boom"); })).toBe("failed");
    expect(await listSourceHealth(db)).toMatchObject([{ source: "s1", status: "failed" }]);
  });

  it("is marked failed while running, so an interrupted run never keeps a stale ok", async () => {
    await runSource(db, "s1", async () => {});
    let during: unknown;
    await runSource(db, "s1", async () => { during = await listSourceHealth(db); });
    expect(during).toMatchObject([{ source: "s1", status: "failed" }]);
  });

  it("rejects statuses outside the SQLite check constraint", async () => {
    await expect(pool.query("insert into source_health (source, status) values ('x', 'bogus')")).rejects.toThrow();
  });

  it("stores checked_at in SQLite CURRENT_TIMESTAMP text format", async () => {
    await runSource(db, "s1", async () => {});
    const [row] = await listSourceHealth(db);
    expect(row.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
