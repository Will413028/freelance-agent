// The product schema, the writer lease and the one-time import on a real D1 database (plan steps
// 4e2a–4e3 pending checks, 4e4 CI). Destructive: it drops every table of the database first, so it
// runs only when D1_DESTRUCTIVE_TEST names the same database id as D1_DATABASE_ID. Asserts its own
// row-write budget (the account's free quota is 100,000 rows a day, shared with the shadow).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOver, inList, readAll, read, usageOf } from "@/db/client";
import { D1Client, httpTransport, type D1Transport } from "@/db/d1/client";
import { GUARD_SQL } from "@/db/d1/guard";
import { localTransport } from "@/db/d1/local";
import { migrateD1 } from "@/db/migrate";
import { opportunities } from "@/db/schema";
import { DAILY_WRITE, writeUnit } from "@/db/unit";
import { ingestSource } from "@/modules/collection/public";
import { copiedDigests, copiedDiscovery, importCopy } from "@/ops/import";
import { PyDateTime } from "@/platform/py/datetime";
import { rebuildNovelty, rebuildProjection } from "@/services/digest";
import { replaceSettings, track } from "@/services/discovery";
import { readSettings } from "@/modules/discovery/public";
import { PyDict } from "@/platform/py/value";
import { sqliteWithSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

const env = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, databaseId: process.env.D1_DATABASE_ID, token: process.env.D1_API_TOKEN };
const enabled = Boolean(env.accountId && env.databaseId && env.token) && process.env.D1_DESTRUCTIVE_TEST === env.databaseId;
const ROW_BUDGET = 2_000;
// The id check above cannot catch a wrong id given twice (CI sets both from one secret), and the
// shadow and later the production database live in the same account: wipe only a database whose
// name says it is disposable. beforeAll, so a refusal runs none of the writing tests either.
const DISPOSABLE = /^freelance-agent-[a-z0-9-]*-(check|test)$/;

async function databaseName(): Promise<string> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.accountId}/d1/database/${env.databaseId}`, {
    headers: { authorization: `Bearer ${env.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { success?: boolean; result?: { name?: unknown } };
  if (!response.ok || body.success !== true || typeof body.result?.name !== "string") throw new Error(`cannot read the database name (HTTP ${response.status})`);
  return body.result.name;
}

describe.skipIf(!enabled)("real D1: product schema, writer lease, import", () => {
  const http = httpTransport({ accountId: env.accountId!, databaseId: env.databaseId!, token: env.token! });
  // One transport, several clients: a hook can interleave another writer before a batch goes out.
  let before: (sql: string[]) => Promise<void> = async () => {};
  const hooked: D1Transport = { batch: async (statements) => { await before(statements.map((s) => s.sql)); return http.batch(statements); } };
  const db = dbOver(new D1Client(hooked));
  const raw = new D1Client(http);
  const rows = async (sql: string, params: (string | number)[] = []) => (await raw.batch([{ sql, params }]))[0].rows;
  const now = new PyDateTime(2026, 10, 27, 1, 0, 0, 0, 0n);
  const dir = mkdtempSync(path.join(os.tmpdir(), "fa-d1-real-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeAll(async () => {
    const name = await databaseName();
    if (!DISPOSABLE.test(name)) throw new Error(`refusing to wipe database "${name}": not named as disposable (${DISPOSABLE})`);
  });

  it("starts from an empty database and applies the migrations in one request", async () => {
    const tables = (await rows("select name from sqlite_master where type = 'table' and name not like '\\_cf\\_%' escape '\\' and name <> 'sqlite_sequence'")).map((r) => String(r[0]));
    // Children before parents is not known here; foreign keys off for the wipe of a test database only.
    // Straight to the transport: the client's DDL guard refuses DROP TABLE on lease-guarded tables
    // without the lease, which would make every run after the first fail on a non-empty database.
    await http.batch([{ sql: "pragma defer_foreign_keys = on", params: [] }, ...tables.map((t) => ({ sql: `drop table if exists "${t}"`, params: [] }))]);
    await migrateD1(db);
    const stand = localTransport(":memory:");
    await migrateD1(dbOver(new D1Client(stand)));
    const catalog = "select type, name, tbl_name, sql from sqlite_master where name not like '\\_cf\\_%' escape '\\' and name <> 'sqlite_sequence' order by type, name";
    const local = (await stand.batch([{ sql: catalog, params: [] }]))[0].rows;
    stand.close();
    // Same objects, same SQL text: tables (named CHECKs, unixepoch() defaults), indexes, triggers.
    expect(await rows(catalog)).toEqual(local);
  });

  it("takes, refuses and fences the writer lease as the stand-in does", async () => {
    await ingestSource(db, "tasker", now, [[job({ source: "tasker", external_id: "c1", title: "Old" }), "r1"]], () => true, "ok");
    // A second unit waits while the first holds the lease, then gives up.
    let held!: () => void, done!: () => void;
    const holding = new Promise<void>((r) => (held = r)), finish = new Promise<void>((r) => (done = r));
    before = async (sql) => { if (sql[0] === GUARD_SQL) { held(); await finish; } };
    const first = ingestSource(db, "tasker", now, [[job({ source: "tasker", external_id: "c2" }), "r2"]], () => true, null);
    await holding;
    before = async () => {};
    const other = dbOver(new D1Client(http));
    await expect(writeUnit(other, { waitMs: 1_500 }, [], () => null)).rejects.toThrow("writer lease not available in time");
    done();
    await first;
    // A holder whose lease expired and was taken is fenced off; its unit reads again and keeps both changes.
    const key = (await rows("select id from opportunities where external_id = 'c1'"))[0][0] as string;
    let interfered = 0;
    before = async (sql) => {
      if (sql[0] !== GUARD_SQL || interfered++ > 0) return;
      await raw.batch([{ sql: "update writer_lease set expires_at = 0", params: [] }]);
      await track(other, key, 0n, { feedback: "interested" }, now);
    };
    await ingestSource(db, "tasker", now, [[job({ source: "tasker", external_id: "c1", title: "New" }), "r3"]], () => true, "ok");
    before = async () => {};
    expect(interfered).toBe(2);
    const [item] = await rows("select json_extract(item, '$.job.title') from opportunities where id = ?", [key]);
    expect(item).toEqual(["New"]);
    expect(await rows("select count(*) from tracking_events where opportunity_id = ?", [key])).toEqual([[1]]);
    expect(await rows("select holder from writer_lease")).toEqual([[null]]);
  });

  it("looks up 250 keys through one json_each parameter", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `k${i}`);
    const [found] = await readAll(db, [read(db.select({ id: opportunities.id }).from(opportunities).where(inList(opportunities.id, keys)), (r) => r)]);
    expect(found).toEqual([]);
  });

  it("rewrites the projection's settings columns through one json_each parameter (plan step 10e1)", async () => {
    // A parameter of the size the bulk statements use (90 KB) on ids that do not exist: D1 accepts it and writes nothing.
    const ids = JSON.stringify(Array.from({ length: 2_000 }, (_, i) => [`missing-${i}-${"x".repeat(24)}`, 0, 700]));
    expect(ids.length).toBeGreaterThan(80_000);
    // Straight to the transport: the client would refuse a write to a leased table without the guard.
    const [none] = await http.batch([{ sql: "update discovery_items set excluded = json_extract(j.value, '$[1]') from json_each(?) as j " +
      "where discovery_items.opportunity_id = json_extract(j.value, '$[0]')", params: [ids] }]);
    expect(none.changes).toBe(0);
    // The real unit on the records the lease test left (their projection rows came with them).
    const current = await readSettings(db);
    await replaceSettings(db, current.revision, new PyDict(current.settings).update({ max_weekly_hours: 5n }));
    expect(await rows("select count(*), min(settings_revision) from discovery_items")).toEqual([[2, Number(current.revision) + 1]]);
  });

  it("imports a copy and reports it equal", async () => {
    const file = path.join(dir, "copy.sqlite3");
    const lite = sqliteWithSchema(file);
    const item = (id: string) => `{"id": "${id}", "job": {"source": "guru", "external_id": "${id}", "budget_max": 1.0}, "fingerprint": "f-${id}", "review_status": "draft"}`;
    for (const id of ["o1", "o2"]) lite.prepare("insert into opportunities values (?,?,?,?)").run(id, "guru", id, item(id));
    lite.prepare("insert into source_receipts values ('guru','r1','o1','2026-10-01 01:02:03')").run();
    lite.prepare("insert into tracking_events (opportunity_id, revision, state, created_at) values ('o1',1,'{}','t1')").run();
    lite.prepare("insert into digest_outbox values ('d1','2026-10-22','owner@example.invalid','{\"items\": []}','sent','c',null,null,'receipt')").run();
    lite.close();
    const report = await importCopy(file, db, async (target, copy, send) =>
      await rebuildNovelty(target, copiedDigests(copy)) + await rebuildProjection(target, copiedDiscovery(copy), send));
    expect(report.ok).toBe(true);
    expect(report.tables.opportunities.target.rows).toBe(2);
    expect(await rows("select item from opportunities where id = 'o1'")).toEqual([[item("o1")]]);
    expect(await rows("select opportunity_id from discovery_items order by 1")).toEqual([["o1"], ["o2"]]);
  });

  it("stays within its row-write budget", () => {
    const used = usageOf(db).d1_rows_written + raw.counters.rowsWritten;
    console.log(`real D1 rows written by this file: ${used}`);
    expect(used).toBeLessThanOrEqual(ROW_BUDGET);
  });
});
