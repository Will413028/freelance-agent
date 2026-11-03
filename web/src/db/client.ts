import { sql, type AnyColumn } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { D1Client, d1ErrorOf, httpTransport } from "./d1/client";
import { d1Drizzle, type D1Db } from "./d1/drizzle";
import * as schema from "./schema";
import type { Usage } from "./usage";

// The product database is Cloudflare D1 over its REST API (plan D19, D21, step 4e). There are no
// transactions: every query is one request and auto-commits, and a batch is one request that
// commits as a whole (spike 1f). drizzle's transaction() would send BEGIN, which D1 refuses.
export type Db = D1Db<typeof schema>;

const clients = new WeakMap<Db, D1Client>();

export function dbOver(client: D1Client): Db {
  const db = d1Drizzle(client, schema);
  clients.set(db, client);
  return db;
}

/** The client behind a Db, for its counters. */
export function clientOf(db: Db): D1Client {
  const client = clients.get(db);
  if (!client) throw new Error("not a Db made by dbOver");
  return client;
}

export function usageOf(db: Db): Usage {
  const c = clientOf(db).counters;
  return {
    d1_requests: c.requests, d1_rows_written: c.rowsWritten, lease_wait_ms: Math.round(c.leaseWaitMs), lease_timeouts: c.leaseTimeouts,
    lease_lost: c.leaseLost, d1_errors: { ...c.errors }, lost_steps: 0, read_retries: c.readRetries,
  };
}

/**
 * A client holds no connection, only request counters, so each caller (a workflow step, a page
 * request) gets its own and its counters cover only its own work.
 */
export function getDb(): Db {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID, databaseId = process.env.D1_DATABASE_ID, token = process.env.D1_API_TOKEN;
  if (!accountId || !databaseId || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and D1_API_TOKEN must be set");
  return dbOver(new D1Client(httpTransport({ accountId, databaseId, token })));
}

/** D1 binds at most 100 parameters per statement. */
export const MAX_PARAMS = 100;

/** `column IN (values)` with the whole list as one JSON parameter, so its length is not bounded by MAX_PARAMS (json_each works on D1, spike 1f (g)). */
export const inList = (column: AnyColumn, values: readonly string[]) => sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;

/** Rows split so that a multi-row INSERT of `paramsPerRow` columns stays within MAX_PARAMS. */
export function insertChunks<T>(rows: readonly T[], paramsPerRow: number): T[][] {
  const size = Math.floor(MAX_PARAMS / paramsPerRow);
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size));
  return out;
}

type Query = BatchItem<"sqlite">;

/** A query and how to turn its rows into the value a caller wants; run with others by readAll. */
export type Read<T> = { query: Query; decode: (rows: never) => T };

export const read = <Q extends Query, T>(query: Q, decode: (rows: Q["_"]["result"]) => T): Read<T> => ({ query, decode });

export type ReadValues<R extends readonly Read<unknown>[]> = { -readonly [K in keyof R]: R[K] extends Read<infer T> ? T : never };

const RETRY_DELAYS_MS = [200, 500];

/**
 * Runs fn again when its request may or may not have executed (lost response, timeout, server
 * error). Only for requests that are safe to repeat: reads, and writes whose second execution
 * changes nothing (conditional updates, upserts of the same values). Rate, overload and daily-limit
 * errors are not retried: the unit fails instead of waiting inside a step (plan step 4e).
 */
export async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (d1ErrorOf(e)?.kind !== "outcome_unknown" || attempt >= RETRY_DELAYS_MS.length) throw e;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Reads whose results are combined must come from one state of the database, as the Python read
 * path's BEGIN gave them: D1 executes a batch as one unit, so these go in one request.
 */
export async function readAll<const R extends readonly Read<unknown>[]>(db: Db, reads: R): Promise<ReadValues<R>> {
  if (reads.length === 0) return [] as ReadValues<R>;
  const results = await retrying(() => db.batch(reads.map((r) => r.query) as unknown as [Query, ...Query[]]));
  return reads.map((r, i) => (r.decode as (rows: unknown) => unknown)(results[i])) as ReadValues<R>;
}
