// The product schema, the writer lease and the one-time import on a real D1 database (plan steps
// 4e2a–4e3 pending checks, 4e4 CI). Destructive: it drops every table of the database first, so it
// runs only when D1_DESTRUCTIVE_TEST names the same database id as D1_DATABASE_ID. Asserts its own
// row-write budget (the account's free quota is 100,000 rows a day, shared with the shadow).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dbOver, inList, readAll, read, usageOf } from "@/db/client";
import { D1Client, httpTransport, type D1Transport } from "@/db/d1/client";
import { GUARD_SQL } from "@/db/d1/guard";
import { localTransport } from "@/db/d1/local";
import { migrateD1 } from "@/db/migrate";
import { opportunities } from "@/db/schema";
import { DAILY_WRITE, writeUnit } from "@/db/unit";
import { ingestSource } from "@/modules/collection/public";
import { copiedDigests, importCopy } from "@/ops/import";
import { PyDateTime } from "@/platform/py/datetime";
import { rebuildNovelty } from "@/services/digest";
import { track } from "@/services/discovery";
import { sqliteWithSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

const env = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, databaseId: process.env.D1_DATABASE_ID, token: process.env.D1_API_TOKEN };
const enabled = Boolean(env.accountId && env.databaseId && env.token) && process.env.D1_DESTRUCTIVE_TEST === env.databaseId;
const ROW_BUDGET = 2_000;

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

  it("starts from an empty database and applies the migrations in one request", async () => {
    const tables = (await rows("select name from sqlite_master where type = 'table' and name not like '\\_cf\\_%' escape '\\' and name <> 'sqlite_sequence'")).map((r) => String(r[0]));
    // Children before parents is not known here; foreign keys off for the wipe of a test database only.
    await raw.batch([{ sql: "pragma defer_foreign_keys = on", params: [] }, ...tables.map((t) => ({ sql: `drop table if exists "${t}"`, params: [] }))]);
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

  it("imports a copy and reports it equal", async () => {
    const file = path.join(dir, "copy.sqlite3");
    const lite = sqliteWithSchema(file);
    const item = (id: string) => `{"id": "${id}", "job": {"source": "guru", "external_id": "${id}", "budget_max": 1.0}}`;
    for (const id of ["o1", "o2"]) lite.prepare("insert into opportunities values (?,?,?,?)").run(id, "guru", id, item(id));
    lite.prepare("insert into source_receipts values ('guru','r1','o1','2026-10-01 01:02:03')").run();
    lite.prepare("insert into tracking_events (opportunity_id, revision, state, created_at) values ('o1',1,'{}','t1')").run();
    lite.prepare("insert into digest_outbox values ('d1','2026-10-22','owner@example.invalid','{\"items\": []}','sent','c',null,null,'receipt')").run();
    lite.close();
    const report = await importCopy(file, db, (target, copy) => rebuildNovelty(target, copiedDigests(copy)));
    expect(report.ok).toBe(true);
    expect(report.tables.opportunities.target.rows).toBe(2);
    expect(await rows("select item from opportunities where id = 'o1'")).toEqual([[item("o1")]]);
  });

  it("stays within its row-write budget", () => {
    const used = usageOf(db).d1_rows_written + raw.counters.rowsWritten;
    console.log(`real D1 rows written by this file: ${used}`);
    expect(used).toBeLessThanOrEqual(ROW_BUDGET);
  });
});
