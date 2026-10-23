import { attachDatabasePool } from "@vercel/functions";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A connection or an open transaction; functions taking it share the caller's transaction. */
export type Executor = Db | Tx;

let pool: Pool | undefined;

/**
 * Every Postgres URL goes through here (product and ops scripts). pg treats sslmode=require as
 * verify-full today but will adopt libpq's weaker semantics in its next major version, so the
 * certificate check is pinned explicitly instead of depending on the driver default.
 */
export function strictSslUrl(url: string): string {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (mode && ["prefer", "require", "verify-ca"].includes(mode)) u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

export function getDb(): Db {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: strictSslUrl(connectionString), max: 5 });
    attachDatabasePool(pool);
  }
  return drizzle(pool, { schema });
}

// Arbitrary constant naming the single product-writer lock.
const WRITER_LOCK = 0x46_41_57_31;

/**
 * One writer at a time, as the Python store's BEGIN IMMEDIATE guarantees: intake, feedback and
 * group-token checks read, compare and then write, and their correctness assumes no other writer
 * ran in between. Needed while those read-check-write paths exist; readers never take the lock.
 */
export function writeTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // Bounded like the Python writer (sqlite3 timeout=5): a stuck writer fails the others fast
    // instead of holding 27 parallel source steps until the 300 s function limit.
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local idle_in_transaction_session_timeout = '60s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(${WRITER_LOCK})`);
    return fn(tx);
  });
}

/** A consistent snapshot for multi-query reads (the Python read path opens a read-only BEGIN). */
export function readTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn, { isolationLevel: "repeatable read", accessMode: "read only" });
}
