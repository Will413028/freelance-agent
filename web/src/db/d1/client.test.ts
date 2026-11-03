import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { D1Client, D1Error, httpTransport, type D1Transport } from "./client";
import { d1Drizzle } from "./drizzle";
import { localTransport } from "./local";

type Reply = { status: number; body: unknown } | Error;

function fakeFetch(replies: Reply[], seen: unknown[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
}

const ok = (...results: { columns?: string[]; rows?: unknown[][]; changes?: number; rows_written?: number }[]) => ({
  status: 200,
  body: { success: true, errors: [], result: results.map((r) => ({ success: true, results: { columns: r.columns ?? [], rows: r.rows ?? [] }, meta: { changes: r.changes ?? 0, rows_written: r.rows_written ?? 0, rows_read: 1 } })) },
});
const failed = (status: number, code: number, message: string) => ({ status, body: { success: false, errors: [{ code, message }], result: [] } });
const http = (replies: Reply[], seen?: unknown[]) =>
  new D1Client(httpTransport({ accountId: "acc", databaseId: "db", token: "t", fetch: fakeFetch(replies, seen), timeoutMs: 1000 }));

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof D1Error) return `${e.kind}:${e.committed}`;
    throw e;
  }
  return "resolved";
}

describe("D1 HTTP client", () => {
  it("sends one batch to /raw and returns columns, rows and counts", async () => {
    const seen: unknown[] = [];
    const client = http([ok({ columns: ["a"], rows: [[1]], rows_written: 0 }, { changes: 1, rows_written: 3 })], seen);
    const results = await client.batch([{ sql: "select 1 a", params: [] }, { sql: "insert into t values (?)", params: [1] }]);
    expect(results.map((r) => [r.columns, r.rows, r.changes])).toEqual([[["a"], [[1]], 0], [[], [], 1]]);
    expect(seen).toEqual([{ batch: [{ sql: "select 1 a", params: [] }, { sql: "insert into t values (?)", params: [1] }] }]);
    expect(client.counters).toEqual({ requests: 1, rowsWritten: 3, errors: {}, leaseWaitMs: 0, leaseTimeouts: 0, leaseLost: 0, rowsRead: 2, readRetries: 0 });
  });

  it("classifies failures by whether the batch may have committed", async () => {
    const cases: [Reply, string][] = [
      [failed(429, 10000, "rate limited"), "rate_limited:false"],
      [failed(400, 7500, "UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)"), "constraint:false"],
      [failed(400, 7500, "To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements."), "rejected:false"],
      [failed(400, 7500, "D1 DB exceeded its daily row write limit"), "daily_limit:false"],
      [failed(503, 7500, "D1 DB is overloaded. Requests queued for too long."), "overloaded:false"],
      [failed(500, 7500, "Internal error"), "outcome_unknown:unknown"],
      [new TypeError("fetch failed"), "outcome_unknown:unknown"],
    ];
    for (const [reply, want] of cases) expect(await kindOf(http([reply]).batch([{ sql: "insert into t values (1)", params: [] }]))).toBe(want);
  });

  it("encodes bigint as text and booleans as 0/1, and refuses other values", async () => {
    const seen: unknown[] = [];
    await http([ok({})], seen).batch([{ sql: "insert into t values (?, ?, ?, ?)", params: [9007199254740993n, true, false, null] }]);
    expect(seen).toEqual([{ batch: [{ sql: "insert into t values (?, ?, ?, ?)", params: ["9007199254740993", 1, 0, null] }] }]);
    await expect(http([ok({})]).batch([{ sql: "x", params: [undefined as never] }])).rejects.toThrow(/unsupported parameter/);
  });

  it("fails closed on integers that JSON cannot carry exactly", async () => {
    // D1 returns 9007199254740993 as a JSON number; JSON.parse makes it 9007199254740992.
    const client = http([ok({ columns: ["n"], rows: [[9007199254740993]] })]);
    expect(await kindOf(client.batch([{ sql: "select n from t", params: [] }]))).toBe("unsafe_integer:false");
  });
});

describe("local D1 stand-in", () => {
  const local = () => new D1Client(localTransport(":memory:"));

  it("rejects transaction statements, too many parameters and oversized SQL like D1", async () => {
    const client = local();
    for (const sql of ["BEGIN", "begin transaction", " SAVEPOINT a", "COMMIT", "rollback", "release a", "END"]) {
      expect(await kindOf(client.batch([{ sql, params: [] }]))).toBe("rejected:false");
    }
    expect(await kindOf(client.batch([{ sql: `select ${Array(101).fill("?").join(",")}`, params: Array(101).fill(1) }]))).toBe("rejected:false");
    expect(await kindOf(client.batch([{ sql: `select '${"x".repeat(100_000)}'`, params: [] }]))).toBe("rejected:false");
    expect((await client.batch([{ sql: `select ${Array(100).fill("?").join(",")}`, params: Array(100).fill(1) }]))[0].rows[0]).toHaveLength(100);
  });

  it("runs a batch atomically: a constraint failure leaves nothing behind", async () => {
    const client = local();
    await client.batch([{ sql: "create table t (id integer primary key, v text unique)", params: [] }]);
    expect(await kindOf(client.batch([
      { sql: "insert into t values (1, 'a')", params: [] },
      { sql: "insert into t values (2, 'a')", params: [] },
    ]))).toBe("constraint:false");
    expect((await client.batch([{ sql: "select count(*) from t", params: [] }]))[0].rows).toEqual([[0]]);
  });

  it("round-trips integers above 2^53 only as text, as D1 does", async () => {
    const client = local();
    await client.batch([{ sql: "create table t (n integer)", params: [] }, { sql: "insert into t values (?)", params: [9007199254740993n] }]);
    expect((await client.batch([{ sql: "select cast(n as text) from t", params: [] }]))[0].rows).toEqual([["9007199254740993"]]);
    expect(await kindOf(client.batch([{ sql: "select n from t", params: [] }]))).toBe("unsafe_integer:false");
  });

  it("drives drizzle queries and batches through the same client", async () => {
    const client = local();
    const t = sqliteTable("t", { id: integer("id").primaryKey(), v: text("v").notNull() });
    await client.batch([{ sql: "create table t (id integer primary key, v text not null)", params: [] }]);
    const db = d1Drizzle(client, { t });
    await db.batch([db.insert(t).values({ id: 1, v: "a" }), db.insert(t).values({ id: 2, v: "b" })]);
    expect(await db.select().from(t).orderBy(t.id)).toEqual([{ id: 1, v: "a" }, { id: 2, v: "b" }]);
    expect(await db.select().from(t).where(eq(t.id, 2)).get()).toEqual({ id: 2, v: "b" });
    expect(await db.select().from(t).where(eq(t.id, 3)).get()).toBeUndefined();
    const [updated] = await db.batch([db.update(t).set({ v: "c" }).where(eq(t.id, 1)).returning()]);
    expect(updated).toEqual([{ id: 1, v: "c" }]);
    await expect(db.transaction(async () => undefined)).rejects.toThrow();
    expect(client.counters.requests).toBeGreaterThan(0);
  });

  it("is a transport like the HTTP one", () => {
    const transport: D1Transport = localTransport(":memory:");
    expect(typeof transport.batch).toBe("function");
  });
});
