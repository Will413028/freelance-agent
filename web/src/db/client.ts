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

export function getDb(): Db {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString, max: 5 });
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
    await tx.execute(sql`select pg_advisory_xact_lock(${WRITER_LOCK})`);
    return fn(tx);
  });
}

/** A consistent snapshot for multi-query reads (the Python read path opens a read-only BEGIN). */
export function readTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn, { isolationLevel: "repeatable read", accessMode: "read only" });
}
