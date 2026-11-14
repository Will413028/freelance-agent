import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { drizzle as nodeDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema, type PgDb } from "@/db/pg/client";
import { migratePg, PG_MIGRATIONS } from "@/db/pg/migrate";

/**
 * A freshly migrated Postgres for one test file: in-process PGlite by default, a real server when
 * TEST_PG_URL is set (CI runs the Postgres tests both ways). A real server's public and drizzle
 * schemas are dropped first, so point TEST_PG_URL only at a throwaway database.
 */
export async function freshPg(): Promise<{ db: PgDb; close: () => Promise<void> }> {
  const url = process.env.TEST_PG_URL;
  if (url) {
    const pool = new Pool({ connectionString: url, max: 2 });
    const db = nodeDrizzle(pool, { schema });
    await db.execute(sql`drop schema if exists drizzle cascade; drop schema public cascade; create schema public`);
    await migratePg(db);
    return { db, close: () => pool.end() };
  }
  const client = new PGlite();
  const db = pgliteDrizzle(client, { schema });
  await pgliteMigrate(db, { migrationsFolder: PG_MIGRATIONS });
  return { db, close: () => client.close() };
}
