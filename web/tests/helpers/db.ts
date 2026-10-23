import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "@/db/schema";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required (a disposable Postgres database)");

export const pool = new Pool({ connectionString: url });
export const db = drizzle(pool, { schema });

const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");

/** Drops everything and replays the versioned migrations: the suite owns this database. */
export async function resetSchema() {
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public");
  await migrate(db, { migrationsFolder });
}

// The Python writer's schema stays the source of truth until it is deleted in plan step 14.
export const SQLITE_SCHEMA_PATH = path.resolve(import.meta.dirname, "../../../backend/src/freelance/platform/schema/001_sqlite.sql");

export function sqliteWithSchema(file = ":memory:") {
  const lite = new DatabaseSync(file);
  lite.exec(readFileSync(SQLITE_SCHEMA_PATH, "utf8"));
  return lite;
}
