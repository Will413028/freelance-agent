import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export { schema };

/** A Postgres database: node-postgres in the running system, PGlite in tests. */
export type PgDb = PgDatabase<PgQueryResultHKT, typeof schema>;

let shared: { url: string; db: PgDb } | undefined;

/** One pool per process, built from DATABASE_URL on first use. */
export function getPgDb(): PgDb {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  if (shared?.url !== url) shared = { url, db: drizzle(new Pool({ connectionString: url, max: 5 }), { schema }) };
  return shared.db;
}
