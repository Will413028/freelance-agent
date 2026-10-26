import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { clientOf, type Db } from "./client";

// The only way migrations reach D1 (plan step 4e3; drizzle-kit only generates them): every pending
// migration and its journal row in one batch, so a failure leaves nothing half applied. drizzle-kit's
// own `migrate` (d1-http) sends statement by statement and leaves a half schema on failure (4e2a).

export const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

export async function migrateD1(db: Db, migrationsFolder = MIGRATIONS) {
  await migrate(db, async (queries) => { await clientOf(db).batch(queries.map((sql) => ({ sql, params: [] }))); }, { migrationsFolder });
}

/** Every statement of the migrations, in order, as the import tool replays them for the tables it recreates. */
export const migrationStatements = (migrationsFolder = MIGRATIONS): string[] =>
  readMigrationFiles({ migrationsFolder }).flatMap((m) => m.sql).map((s) => s.trim()).filter(Boolean);
