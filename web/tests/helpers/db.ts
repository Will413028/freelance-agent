import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql, type SQL } from "drizzle-orm";
import { dbOver } from "@/db/client";
import { D1Client, D1Error, type D1Param, type D1Transport } from "@/db/d1/client";
import { localTransport } from "@/db/d1/local";
import { DAILY_WRITE, writeUnit } from "@/db/unit";
import { migrateD1, MIGRATIONS } from "@/db/migrate";

// The suite runs on the local D1 stand-in (plan step 4e): it refuses what D1 refuses (transaction
// statements, over 100 parameters, over 100 KB of SQL) and keeps a batch atomic, so code that passes
// here sends D1 only what D1 accepts. Every reset starts a new in-memory database.

let current: ReturnType<typeof localTransport> | undefined;
const transport: D1Transport = { batch: (statements) => current!.batch(statements) };

/** Counts every request the tests send, like the product client does in a run. */
export const client = new D1Client(transport);
export const db = dbOver(client);

export { MIGRATIONS };

/** Applies the versioned migrations in one batch, as on D1 (src/db/migrate.ts). */
export const applyMigrations = (target = db) => migrateD1(target);

/**
 * A view of the test database whose next batch matching `lost` executes and commits, but whose
 * response is lost (D1Error outcome_unknown), as after a timeout or a dropped connection.
 */
export function losingResponse(lost: (sql: string[]) => boolean) {
  let armed = true;
  const over = new D1Client({
    async batch(statements) {
      const results = await current!.batch(statements);
      if (armed && lost(statements.map((s) => s.sql))) {
        armed = false;
        throw new D1Error("outcome_unknown", "unknown", "response lost after commit");
      }
      return results;
    },
  });
  return { db: dbOver(over), client: over, fired: () => !armed };
}

/** A view of the test database that runs `before` ahead of every batch it sends, e.g. to interleave another writer. */
export function intercepting(before: (sql: string[]) => Promise<void>) {
  const over = new D1Client({ batch: async (statements) => { await before(statements.map((s) => s.sql)); return current!.batch(statements); } });
  return { db: dbOver(over), client: over };
}

/** A view of the test database that records every batch it sends. */
export function recording() {
  const batches: { sql: string; params: unknown[] }[][] = [];
  const over = new D1Client({ batch: (statements) => { batches.push(statements); return current!.batch(statements); } });
  return { db: dbOver(over), client: over, batches };
}

/** A fresh, empty database with the current schema. */
export async function resetSchema() {
  current?.close();
  current = localTransport(":memory:");
  await applyMigrations();
}

/** Raw SQL through the stand-in, one statement per request; rows come back as objects. */
export async function query<T = Record<string, any>>(sql: string, params: D1Param[] = []): Promise<T[]> {
  const [result] = await client.batch([{ sql, params }]);
  return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])) as T);
}

/** Raw SQL with ?/?N placeholders as a drizzle SQL with bound parameters. */
function bound(text: string, params: D1Param[]): SQL {
  const chunks: SQL[] = [];
  let last = 0, next = 0;
  for (const m of text.matchAll(/\?(\d+)?/g)) {
    chunks.push(sql.raw(text.slice(last, m.index)));
    chunks.push(sql`${params[m[1] ? Number(m[1]) - 1 : next++]}`);
    last = m.index + m[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks);
}

/**
 * A raw write to a leased table (fixtures, trigger tests): the client refuses it without the writer
 * lease guard, so it runs as a unit like any product write.
 */
export async function leased(text: string, params: D1Param[] = []) {
  await writeUnit(db, DAILY_WRITE, [], (_, writes) => writes.statement(db.run(bound(text, params))));
}

/** Raw SQL with rows as arrays, in column order. */
export async function queryArrays(sql: string, params: D1Param[] = []): Promise<unknown[][]> {
  return (await client.batch([{ sql, params }]))[0].rows;
}

/** Statements whose trigger or table definition a test removes and later restores, from the migration SQL. */
export function migrationStatement(pattern: RegExp): string {
  for (const file of ["0000_schema.sql", "0001_triggers.sql"]) {
    const found = readFileSync(path.join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint").find((s) => pattern.test(s));
    if (found) return found.trim();
  }
  throw new Error(`no migration statement matches ${pattern}`);
}

// The Python writer's schema stays the source of truth until it is deleted in plan step 14.
export const SQLITE_SCHEMA_PATH = path.resolve(import.meta.dirname, "../../../backend/src/freelance/platform/schema/001_sqlite.sql");

export function sqliteWithSchema(file = ":memory:") {
  const lite = new DatabaseSync(file);
  lite.exec(readFileSync(SQLITE_SCHEMA_PATH, "utf8"));
  return lite;
}
