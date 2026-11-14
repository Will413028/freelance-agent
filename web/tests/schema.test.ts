import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, migrationStatement, query, resetSchema, leased } from "./helpers/db";

type Col = { name: string; type: string; notnull: number; pk: number };
type Named = { name: string; sql: string };

beforeAll(resetSchema);

// Structure drift (schema.ts against the migrations) is `pnpm db:check`, run in CI; the tests here
// cover what drizzle does not model: collation, and below the immutability triggers of 0001_triggers.sql by their behaviour.
describe("schema", () => {
  // db:check compares schema.ts with drizzle's snapshot, never with the SQL files. This closes the
  // gap: the database the migrations build has exactly the tables and columns schema.ts declares,
  // so a hand-written migration cannot drop or alter a table (the historical ones have no other test).
  it("builds from the migrations exactly the tables and columns schema.ts declares", async () => {
    const declared = (Object.values(schema) as unknown[]).filter((t): t is SQLiteTable => is(t, SQLiteTable)).map((t) => getTableConfig(t));
    const own = "name not like 'sqlite_%' and name not like '\\_cf\\_%' escape '\\' and name <> '__drizzle_migrations'";
    const built = await query<{ name: string }>(`select name from sqlite_master where type='table' and ${own} order by name`);
    expect(built.map((t) => t.name)).toEqual(declared.map((t) => t.name).sort());
    expect(declared.length).toBeGreaterThanOrEqual(30);
    for (const table of declared) {
      const have = (await query<Col>(`pragma table_info(${table.name})`)).map((c) => ({ name: c.name, type: c.type.toLowerCase(), notnull: c.notnull === 1 || c.pk > 0 }));
      const want = table.columns.map((c) => ({ name: c.name, type: c.getSQLType().toLowerCase(), notnull: c.notNull || c.primary || table.primaryKeys.some((k) => k.columns.includes(c)) }));
      const byName = (x: { name: string }, y: { name: string }) => (x.name < y.name ? -1 : 1);
      expect({ table: table.name, cols: have.sort(byName) }).toEqual({ table: table.name, cols: want.sort(byName) });
    }
  });

  it("compares and orders text like SQLite BINARY: no column declares another collation", async () => {
    const declared = await query<Named>("select name, sql from sqlite_master where sql like '%collate%'");
    expect(declared).toEqual([]);
  });
});

// Migration 0005 rebuilds daily_runs with the day alone as its key: the rows it already holds stay.
describe("migration 0005: daily_runs keyed by the day", () => {
  it("keeps every existing run and its result, and then refuses a second row for a day", () => {
    const lite = new DatabaseSync(":memory:");
    lite.exec(migrationStatement(/CREATE TABLE `daily_runs`/));
    const insert = lite.prepare("insert into daily_runs values (?,?,?,?,?,?)");
    insert.run("2026-11-05", "owner@example.invalid", "failed", "s1", "f1", '{"status": "source_failed"}');
    insert.run("2026-11-06", "owner@example.invalid", "running", "s2", null, null);
    for (const sql of readFileSync(path.join(MIGRATIONS, "0005_daily_runs_key.sql"), "utf8").split("--> statement-breakpoint")) lite.exec(sql);
    expect(lite.prepare("select * from daily_runs order by local_date").all().map((r) => ({ ...r }))).toEqual([
      { local_date: "2026-11-05", status: "failed", started_at: "s1", finished_at: "f1", result: '{"status": "source_failed"}' },
      { local_date: "2026-11-06", status: "running", started_at: "s2", finished_at: null, result: null },
    ]);
    expect(() => lite.exec("insert into daily_runs (local_date, status, started_at) values ('2026-11-06', 'running', 's3')")).toThrow(/UNIQUE|PRIMARY/i);
    expect(() => lite.exec("insert into daily_runs (local_date, status, started_at) values ('2026-11-07', 'done', 's')")).toThrow(/CHECK/i);
  });
});

async function seedDraft() {
  await leased(`insert into proposal_drafts values ('d1','t',1,'{}','{}','null','c','u',null,'r1','{}')`);
  await leased(`insert into proposal_draft_revisions values ('d1',1,'body','{}','[]','{}','r1','{}','c')`);
}
async function seedIntent(status = "prepared") {
  await seedDraft();
  await leased(`insert into submission_intents values ('s1','d1',1,'{}','h',null,?1,1,'c','u',null,null,null,null,'q1','{}')`, [status]);
  await leased(`insert into submission_events values ('s1',1,'prepared','{}','c')`);
}

describe("immutability triggers", () => {
  beforeEach(resetSchema);

  // SQLite has no TRUNCATE; DELETE without WHERE is the only way to empty a table and fires the triggers.
  it("rejects UPDATE and DELETE of proposal draft revisions", async () => {
    await seedDraft();
    await expect(leased("update proposal_draft_revisions set body='x'")).rejects.toThrow("Proposal versions are immutable");
    await expect(leased("delete from proposal_draft_revisions")).rejects.toThrow("Proposal versions must be retained");
  });

  it("rejects UPDATE and DELETE of submission events", async () => {
    await seedIntent();
    await expect(leased("update submission_events set evidence='x'")).rejects.toThrow("Submission events are immutable");
    await expect(leased("delete from submission_events")).rejects.toThrow("Submission events must be retained");
  });

  it("keeps submission identity immutable and allows only safe transitions", async () => {
    await seedIntent();
    await expect(leased("update submission_intents set snapshot='{\"x\":1}'")).rejects.toThrow("immutable");
    await expect(leased("update submission_intents set approval_hash=null, request_payload='{ }'")).rejects.toThrow("immutable");
    await expect(leased("update submission_intents set status='attempted'")).rejects.toThrow("Unsafe submission transition");
    await leased("update submission_intents set status='approved', revision=2");
    await leased("update submission_intents set status='attempted', revision=3");
    await expect(leased("update submission_intents set status='cancelled'")).rejects.toThrow("Unsafe submission transition");
    await leased("update submission_intents set status='unknown', revision=4");
    await expect(leased("update submission_intents set status='accepted'")).rejects.toThrow("Unsafe submission transition");
  });

  it("keeps digest snapshots immutable and allows only pending→attempted→sent|unknown", async () => {
    await leased("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await expect(leased("update digest_outbox set snapshot='{ }'")).rejects.toThrow("Digest identity and snapshot are immutable");
    await expect(leased("update digest_outbox set status='sent', delivery_receipt='x'")).rejects.toThrow("Unsafe digest state transition");
    await leased("update digest_outbox set status='attempted'");
    await expect(leased("update digest_outbox set status='sent'")).rejects.toThrow("digest_outbox_sent_receipt");
    await leased("update digest_outbox set status='sent', delivery_receipt='receipt'");
    await expect(leased("update digest_outbox set status='attempted'")).rejects.toThrow("Unsafe digest state transition");
  });

  it("still allows mutable columns to change", async () => {
    await leased("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await leased("update digest_outbox set attempted_at='t'");
    await seedIntent();
    await leased("update submission_intents set reconciliation='{}'");
  });
});
