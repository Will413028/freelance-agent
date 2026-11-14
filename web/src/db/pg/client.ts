import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export { schema };

/** A Postgres database: node-postgres in the running system, PGlite in tests. */
export type PgDb = PgDatabase<PgQueryResultHKT, typeof schema>;

let shared: PgDb | undefined;

/** One pool per process, built from DATABASE_URL on first use. */
export function getPgDb(): PgDb {
  if (shared) return shared;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  return (shared = drizzle(new Pool({ connectionString: url, max: 5 }), { schema }));
}
