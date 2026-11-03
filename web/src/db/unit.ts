import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { clientOf, insertChunks, MAX_PARAMS, retrying, type Db, type Read, type ReadValues } from "./client";
import { d1ErrorOf, type D1Result, type D1Statement } from "./d1/client";
import { GUARD_SQL } from "./d1/guard";
import { writeAttempts, writerLease } from "./schema";

// Units of work that read, decide and write (plan step 4e, D20-B). D1 has no interactive
// transactions, so a unit is: one request that takes the writer lease and does every read the unit
// decides on → computation in memory, where later reads see the unit's own unsent writes (the views
// the modules build over `Writes`) → one write batch (more only past the request limits) that starts
// with a guard on the lease's holder and token. Another writer can only get in after the lease
// expired, and then the token has changed, so the guard aborts the stale batch and the unit runs again
// from its reads. Correctness rests on D1 checking the guard atomically inside the batch, not on clocks.

/** Seconds a lease lasts; every write batch renews it (D1's clock, unixepoch()). */
const LEASE_SECONDS = 30;
/**
 * How long a unit waits for the lease, and the error it fails with when it gives up (D20-B): a
 * daily-run unit waits out a crashed holder's lease (30 s) and then fails its source; a page request
 * waits 5 s and answers 409.
 */
export type WritePolicy = { waitMs: number; busy?: (reason: BusyReason) => Error; split?: boolean };
export type BusyReason = "lease_wait" | "lease_lost";
export const DAILY_WRITE: WritePolicy = { waitMs: 35_000 };
/** A source's intake: past one request it writes in batches, each with whole records and their receipts. */
export const INTAKE_WRITE: WritePolicy = { waitMs: 35_000, split: true };
export const UI_WAIT_MS = 5_000;
/** Retries after the lease was lost between the reads and the write (D20 common basis 5). */
const RETRY_DELAYS_MS = [200, 500, 1000];
/** write_attempts rows are kept this long (D20 common basis 6), pruned by the batches that add them. */
const ATTEMPT_RETENTION_SECONDS = 7 * 86_400;
// Request limits for one write batch, bookkeeping included, inside what was measured to work: 75
// statements (spikes.md §1f (a), the projection recompute) and 56 statements in 10.1 MB ("1f 補充");
// no failing size was found. Only intake may go past them, in several guarded batches (D20 common
// basis 1: rerunning a source is idempotent); any other unit that large fails before writing.
const MAX_STATEMENTS = 75;
const MAX_BYTES = 4_000_000;
/** Guard, renew, prune, attempt record and release around a batch's own statements. */
const BOOKKEEPING = 5;
/** Statements a withLease request carries besides its guard and renewal. */
export const MAX_LEASED_STATEMENTS = MAX_STATEMENTS - 2;

/** The unit could not get or keep the lease within its limits; nothing of its current attempt was written. */
export class WriterBusy extends Error {
  constructor(readonly reason: BusyReason) {
    super(reason === "lease_wait" ? "writer lease not available in time" : "writer lease lost on every attempt");
    this.name = "WriterBusy";
  }
}

/**
 * The reason to record when a step failed on storage rather than at its source, or null: D1's error
 * kind, or the lease given up on. The revocation triggers of D20 and D21 (any 429, any lease
 * timeout) are read from these reasons in daily_runs.result.
 */
export function storageFailure(e: unknown): string | null {
  if (e instanceof WriterBusy) return `storage_${e.reason}`;
  const d1 = d1ErrorOf(e);
  return d1 ? `storage_${d1.kind}` : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);

const acquire = (db: Db, holder: string) =>
  db.insert(writerLease).values({ id: 1, holder, token: 1, expiresAt: sql`unixepoch() + ${sql.raw(String(LEASE_SECONDS))}` })
    .onConflictDoUpdate({
      target: writerLease.id,
      set: { holder: sql`excluded.holder`, token: sql`${writerLease.token} + 1`, expiresAt: sql`excluded.expires_at` },
      // Free, expired, or already ours: a holder may take its own lease again (after a lost response).
      setWhere: sql`${writerLease.holder} is null or ${writerLease.expiresAt} < unixepoch() or ${writerLease.holder} = excluded.holder`,
    })
    .returning({ token: writerLease.token });

// Each lease statement exists once, as text with (holder, token) parameters: sent raw by withLease and
// bound into drizzle for units. The client requires GUARD_SQL's exact text before any leased write.
const RENEW_SQL = `update writer_lease set expires_at = unixepoch() + ${LEASE_SECONDS} where id = 1 and holder = ? and token = ?`;
const RELEASE_SQL = "update writer_lease set holder = null where id = 1 and holder = ? and token = ?";
const leaseStatement = (db: Db, text: string, holder: string, token: number) => {
  const [head, mid, tail] = text.split("?");
  return db.run(sql.join([sql.raw(head), sql`${holder}`, sql.raw(mid), sql`${token}`, sql.raw(tail)]));
};
const guard = (db: Db, holder: string, token: number) => leaseStatement(db, GUARD_SQL, holder, token);
const renew = (db: Db, holder: string, token: number) => leaseStatement(db, RENEW_SQL, holder, token);
const release = (db: Db, holder: string, token: number) => leaseStatement(db, RELEASE_SQL, holder, token);
const recordAttempt = (db: Db, id: string) => db.insert(writeAttempts).values({ attemptId: id });
const pruneAttempts = (db: Db) => db.run(sql`delete from write_attempts where at < unixepoch() - ${sql.raw(String(ATTEMPT_RETENTION_SECONDS))}`);
const attemptSeen = (db: Db, id: string) => db.select({ id: writeAttempts.attemptId }).from(writeAttempts).where(sql`${writeAttempts.attemptId} = ${id}`);

/**
 * How a pending row meets an existing one: a plain INSERT that fails when the row exists ("insert",
 * for rows the unit read as absent), an upsert replacing the listed columns ("update", for rows it
 * read as present; one multi-row statement where UPDATE would need one per row), or INSERT … DO
 * NOTHING ("nothing", where the first writer keeps the row, as Python's INSERT OR IGNORE).
 */
export type OnConflict = { kind: "insert" } | { kind: "update"; target: SQLiteColumn | SQLiteColumn[]; set: SQLiteColumn[] } | { kind: "nothing" };

type Row = Record<string, unknown>;
type Pending = { table: SQLiteTable; on: OnConflict; rows: Map<string, { group: string | null; row: Row }> };

/**
 * The rows a unit will write, collected while it computes. One row per key and table: a later put
 * replaces an earlier one, except under DO NOTHING, where the first stays (as the database would).
 * `group` keeps rows together when intake needs several batches (an opportunity id: its record,
 * receipts and tracking travel together); null rows go in the last batch.
 */
export class Writes {
  private readonly pending = new Map<string, Pending>();
  private readonly tail: BatchItem<"sqlite">[] = [];

  put(table: SQLiteTable, on: OnConflict, key: string, row: Row, group: string | null) {
    const name = getTableConfig(table).name;
    for (const other of this.pending.values()) {
      if (other.table === table && other.on.kind !== on.kind && other.rows.has(key)) throw new Error(`${name}: row ${key} put as ${other.on.kind} and ${on.kind}`);
    }
    let p = this.pending.get(`${name}:${on.kind}`);
    if (!p) this.pending.set(`${name}:${on.kind}`, (p = { table, on, rows: new Map() }));
    if (p.rows.has(key) && on.kind === "nothing") return;
    p.rows.set(key, { group, row });
  }

  /**
   * A raw statement for the last batch, under the same guard: test fixtures, and set-based writes the
   * row API cannot express within one request (the projection's settings columns, UPDATE … FROM
   * json_each, plan step 10e1). Never split: a unit whose raw statements overflow a request fails.
   */
  statement(query: BatchItem<"sqlite">) {
    this.tail.push(query);
  }

  get empty() {
    return this.tail.length === 0 && [...this.pending.values()].every((p) => p.rows.size === 0);
  }

  /** The write batches' statements, without guard and bookkeeping, parents before the tables that reference them. */
  batches(db: Db): BatchItem<"sqlite">[][] {
    // Stable sort: tables of equal depth keep the order their first row was put in.
    const tables = [...this.pending.values()].filter((p) => p.rows.size > 0).sort((a, b) => depth(a.table) - depth(b.table));
    const groups = new Map<string | null, Map<Pending, Row[]>>();
    for (const p of tables) {
      for (const { group, row } of p.rows.values()) {
        if (!groups.has(group)) groups.set(group, new Map());
        const rows = groups.get(group)!;
        if (!rows.has(p)) rows.set(p, []);
        rows.get(p)!.push(row);
      }
    }
    const tailRows = groups.get(null);
    groups.delete(null);
    const chunks: Map<Pending, Row[]>[] = [];
    let current = new Map<Pending, Row[]>(), bytes = 0;
    const fits = (add: Map<Pending, Row[]>, addBytes: number, extra: number) => {
      let statements = extra + BOOKKEEPING;
      for (const p of tables) {
        const n = (current.get(p)?.length ?? 0) + (add.get(p)?.length ?? 0);
        if (n > 0) statements += Math.ceil(n / rowsPerStatement(p));
      }
      return statements <= MAX_STATEMENTS && bytes + addBytes <= MAX_BYTES;
    };
    const take = (add: Map<Pending, Row[]>, addBytes: number) => {
      for (const [p, rows] of add) current.set(p, [...(current.get(p) ?? []), ...rows]);
      bytes += addBytes;
    };
    for (const rows of groups.values()) {
      const size = [...rows.values()].flat().reduce((n, row) => n + rowBytes(row), 0);
      if (current.size > 0 && !fits(rows, size, 0)) {
        chunks.push(current);
        current = new Map();
        bytes = 0;
      }
      take(rows, size);
    }
    const last = tailRows ?? new Map<Pending, Row[]>();
    const lastSize = [...last.values()].flat().reduce((n, row) => n + rowBytes(row), 0);
    if (current.size > 0 && !fits(last, lastSize, this.tail.length)) {
      chunks.push(current);
      current = new Map();
      bytes = 0;
    }
    take(last, lastSize);
    chunks.push(current);
    const out = chunks.map((chunk) => tables.filter((p) => chunk.has(p)).flatMap((p) => statements(db, p, chunk.get(p)!)));
    out[out.length - 1].push(...this.tail);
    // Only raw statements can still overflow (they are never split): refuse rather than send a request past the limits.
    for (const b of out) if (b.length + BOOKKEEPING > MAX_STATEMENTS) throw new Error(`a write batch of ${b.length} statements exceeds one request`);
    return out.filter((b) => b.length > 0);
  }
}

const depths = new Map<SQLiteTable, number>();
/** 0 for a table that references no other table, else one more than the deepest table it references. */
function depth(table: SQLiteTable): number {
  const known = depths.get(table);
  if (known !== undefined) return known;
  const refs = getTableConfig(table).foreignKeys.map((fk) => fk.reference().foreignTable).filter((t) => t !== table);
  const d = refs.length === 0 ? 0 : 1 + Math.max(...refs.map(depth));
  depths.set(table, d);
  return d;
}

/** drizzle binds every value of a row except SQL expressions, and every row of a table is put with the same columns. */
const boundValues = (p: Pending) => Math.max(1, Object.values(p.rows.values().next().value!.row).filter((v) => !is(v, SQL)).length);
const rowsPerStatement = (p: Pending) => Math.max(1, Math.floor(MAX_PARAMS / boundValues(p)));
const rowBytes = (row: Row) => Object.values(row).reduce<number>((n, v) => n + (typeof v === "string" ? Buffer.byteLength(v) : 8), 16);

function statements(db: Db, p: Pending, rows: Row[]): BatchItem<"sqlite">[] {
  const columns = getTableColumns(p.table) as Record<string, SQLiteColumn>;
  const keyOf = (c: SQLiteColumn) => Object.keys(columns).find((k) => columns[k] === c)!;
  return insertChunks(rows, boundValues(p)).map((chunk) => {
    const insert = db.insert(p.table).values(chunk as never);
    if (p.on.kind === "nothing") return insert.onConflictDoNothing();
    if (p.on.kind === "update") {
      const set = Object.fromEntries(p.on.set.map((c) => [keyOf(c), sql.raw(`excluded."${c.name}"`)]));
      return insert.onConflictDoUpdate({ target: p.on.target, set: set as Record<string, SQL> });
    }
    return insert;
  });
}

const isGuardFailure = (e: unknown) => d1ErrorOf(e)?.kind === "constraint" && /guard failed/.test(d1ErrorOf(e)!.message);

type Attempt<T> = { done: true; value: T } | { done: false };

/** Polls the acquire alone until the lease is free (or ours), at most waitMs; the wait counts into leaseWaitMs. */
async function waitForLease(db: Db, holder: string, waitMs: number): Promise<number> {
  let waited = 0;
  for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
    const token = (await retrying(() => acquire(db, holder)))[0]?.token;
    if (token !== undefined) return token;
    if (waited >= waitMs) throw new WriterBusy("lease_wait");
    const ms = Math.min(jitter(pause), waitMs - waited + 1);
    await sleep(ms);
    waited += ms;
    clientOf(db).counters.leaseWaitMs += ms;
  }
}

/**
 * The lease held across several requests, for operations tooling that writes more than a unit can
 * (the one-time import, migrations of a live database): `send` packs the statements it is given
 * into requests within D1's limits, each behind the guard and renewing the lease, and the lease is
 * released at the end, also on failure. It does not settle lost responses or rerun anything: a
 * request that failed, was lost or met a lost lease fails the whole operation, which must therefore
 * be safe to run again from the start.
 */
export async function withLease<T>(db: Db, waitMs: number, fn: (send: (statements: D1Statement[]) => Promise<D1Result[]>) => Promise<T>): Promise<T> {
  const holder = crypto.randomUUID();
  const token = await waitForLease(db, holder, waitMs);
  const client = clientOf(db);
  const lease = [{ sql: GUARD_SQL, params: [holder, token] }, { sql: RENEW_SQL, params: [holder, token] }];
  try {
    return await fn(async (statements) => {
      const results: D1Result[] = [];
      for (const request of pack(statements, MAX_LEASED_STATEMENTS)) {
        try {
          results.push(...(await client.batch([...lease, ...request])).slice(lease.length));
        } catch (e) {
          throw isGuardFailure(e) ? new WriterBusy("lease_lost") : e;
        }
      }
      return results;
    });
  } finally {
    await client.batch([{ sql: RELEASE_SQL, params: [holder, token] }]).then(() => undefined, () => undefined);
  }
}

/** Consecutive statements grouped into requests of at most `limit` statements and MAX_BYTES. */
function pack(statements: D1Statement[], limit: number): D1Statement[][] {
  const out: D1Statement[][] = [];
  let current: D1Statement[] = [], bytes = 0;
  for (const s of statements) {
    const size = Buffer.byteLength(s.sql) + s.params.reduce<number>((n, p) => n + (typeof p === "string" ? Buffer.byteLength(p) : 8), 0);
    if (current.length && (current.length >= limit || bytes + size > MAX_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(s);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

/** What `run` may compute: never a promise, so a unit cannot wait on the network or read outside its reads while it holds the lease. */
type Computed<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Runs one unit under the writer lease: `reads` go in the request that takes the lease, `run`
 * computes from their values, synchronously, and puts its writes, and the writes commit in guarded
 * batches. `run` runs again from fresh reads when the lease was lost before the write (at most 3
 * times), so it must not keep state between calls. An error thrown by `run` releases the lease and
 * reaches the caller unchanged. Lease waits count into the client's `leaseWaitMs`
 * (daily_runs.result lease_wait_ms); giving up on the lease is logged with its reason.
 */
export async function writeUnit<const R extends readonly Read<unknown>[], T>(db: Db, policy: WritePolicy, reads: R,
  run: (values: ReadValues<R>, writes: Writes) => Computed<T>): Promise<T> {
  const holder = crypto.randomUUID();
  const busy = (reason: BusyReason) => {
    const counters = clientOf(db).counters;
    if (reason === "lease_wait") counters.leaseTimeouts++;
    else counters.leaseLost++;
    console.warn(`write unit gave up on the writer lease: ${reason}`);
    return policy.busy?.(reason) ?? new WriterBusy(reason);
  };
  for (let attempt = 0; ; attempt++) {
    let outcome: Attempt<T>;
    try {
      outcome = await once(db, holder, policy, reads, run);
    } catch (e) {
      throw e instanceof WriterBusy ? busy(e.reason) : e;
    }
    if (outcome.done) return outcome.value;
    if (attempt >= RETRY_DELAYS_MS.length) throw busy("lease_lost");
    await sleep(jitter(RETRY_DELAYS_MS[attempt]));
  }
}

async function once<const R extends readonly Read<unknown>[], T>(db: Db, holder: string, policy: WritePolicy, reads: R,
  run: (values: ReadValues<R>, writes: Writes) => Computed<T>): Promise<Attempt<T>> {
  const waitMs = policy.waitMs;
  // Take the lease and read in one request. When another unit holds it, poll with the acquire alone
  // (the reads can be large) and read in the next request once the lease is ours.
  const readQueries = reads.map((r) => r.query);
  const [first, ...firstReads] = await retrying(() => db.batch([acquire(db, holder), ...readQueries] as never)) as unknown as [{ token: number }[], ...unknown[]];
  let token: number | undefined = first[0]?.token, results: unknown[] = firstReads;
  if (token === undefined) {
    // Read without the lease: worthless, the unit reads again once it holds the lease.
    results = [];
    token = await waitForLease(db, holder, waitMs);
  }
  const held = token;
  const writes = new Writes();
  let value: T, batches: BatchItem<"sqlite">[][];
  try {
    if (results.length < readQueries.length) results = await retrying(() => db.batch(readQueries as never)) as unknown as unknown[];
    value = run(reads.map((r, i) => (r.decode as (rows: unknown) => unknown)(results[i])) as ReadValues<R>, writes) as T;
    if (value instanceof Promise) {
      value.catch(() => undefined);
      throw new Error("a write unit computes synchronously");
    }
    batches = writes.empty ? [] : writes.batches(db);
    if (batches.length > 1 && !policy.split) throw new Error(`write unit needs ${batches.length} requests; only intake may split its writes`);
  } catch (e) {
    await release(db, holder, held).then(() => undefined, () => undefined);
    throw e;
  }
  if (batches.length === 0) {
    await retrying(() => release(db, holder, held));
    return { done: true, value };
  }
  for (let i = 0; i < batches.length; i++) {
    const last = i === batches.length - 1;
    for (let resend = 0; ; resend++) {
      const attemptId = crypto.randomUUID();
      const batch = [guard(db, holder, token), renew(db, holder, token), ...(i === 0 ? [pruneAttempts(db)] : []), ...batches[i],
        recordAttempt(db, attemptId), ...(last ? [release(db, holder, token)] : [])];
      try {
        await db.batch(batch as never);
        break;
      } catch (e) {
        if (isGuardFailure(e)) return { done: false };
        if (d1ErrorOf(e)?.kind !== "outcome_unknown" || resend >= 2) {
          await release(db, holder, token).then(() => undefined, () => undefined);
          throw e;
        }
      }
      // The response was lost: the batch may or may not have committed, and a request still in flight
      // could commit later. Taking the lease again changes the token, so the old batch can no longer
      // pass its guard; only then does write_attempts answer for good (D20 common basis 6).
      const [again, seen] = await retrying(() => db.batch([acquire(db, holder), attemptSeen(db, attemptId)])) as unknown as [{ token: number }[], unknown[]];
      const next = again[0]?.token;
      const committed = seen.length > 0;
      if (next === undefined) {
        // Another unit holds the lease now: done if this was the last batch and it committed, else start over.
        return committed && last ? { done: true, value } : { done: false };
      }
      const intervened = next !== token + 1;
      token = next;
      if (committed && last) {
        await retrying(() => release(db, holder, token!));
        return { done: true, value };
      }
      // Someone held the lease in between: what this unit read may be stale, so it reads again.
      if (intervened) return { done: false };
      if (committed) break;
    }
  }
  return { done: true, value };
}
