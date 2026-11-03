import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestSource } from "@/modules/collection/public";
import { checkTableSet, copiedDigests, copiedDiscovery, createStatements, importCopy, type RebuildDerived } from "@/ops/import";
import { CopyError } from "@/ops/rows";
import { TABLES } from "@/ops/tables";
import { PyDateTime } from "@/platform/py/datetime";
import { checkLedger, rebuildNovelty, rebuildProjection } from "@/services/digest";
import { replayDigest } from "@/verify/replay";
import { encode } from "@/platform/py/json";
import { list, listPage } from "@/services/discovery";
import { db, intercepting, leased, MIGRATIONS, query, recording, resetSchema, sqliteWithSchema } from "./helpers/db";
import { migrateD1 } from "@/db/migrate";
import { fixture } from "./helpers/golden";
import { job } from "./helpers/jobs";

// Operations tooling on the local D1 stand-in (plan step 4e3): the one-time import of a production
// copy into D1, the VM snapshot, and the same-start digest replay.
const dir = mkdtempSync(path.join(os.tmpdir(), "fa-ops-"));
// What scripts/import-copy.ts passes.
const rebuild: RebuildDerived = async (target, lite, send) =>
  await rebuildNovelty(target, copiedDigests(lite)) + await rebuildProjection(target, copiedDiscovery(lite), send);

/** A synthetic production-shaped copy: every table has rows, with the awkward values production can hold. */
function seed(lite: DatabaseSync) {
  // Python's encode() output: float 1.0 keeps its ".0", which JSON.stringify could not write.
  // The envelope keys the discovery projection derives from (fingerprint, review_status) are always present in production.
  const item = (id: string) => `{"id": "${id}", "job": {"source": "guru", "external_id": "${id}", "title": "徵 AI agent 😀", "budget_max": 1.0}, "fingerprint": "f-${id}", "review_status": "draft"}`;
  const run = (sql: string, ...values: (string | number | bigint | null)[]) => lite.prepare(sql).run(...values);
  for (const id of ["o1", "o2", "O3"]) run("insert into opportunities values (?,?,?,?)", id, "guru", id, item(id));
  run("insert into proposal_revisions values ('o1',1,'舊提案\\n第二行','fp','2026-01-01 00:00:00')");
  run("insert into source_receipts values ('guru','r1','o1','2026-10-01 01:02:03')");
  run("insert into source_health values ('guru','ok','2026-10-23 01:00:00')");
  run("insert into digest_outbox values ('d1','2026-10-22','owner@example.invalid','{\"items\": []}','sent','c',null,null,'receipt')");
  run("insert into daily_runs values ('2026-10-22','owner@example.invalid','complete','s','f','{\"source_details\": {}}')");
  run("insert into opportunity_tracking values ('o1','{\"revision\": 2, \"feedback\": \"skipped\"}')");
  run("insert into tracking_events (opportunity_id, revision, state, created_at) values ('o1',1,'{}','t1'),('o1',2,'{}','t2')");
  run("insert into ai_draft_attempts values ('o1','fp',1,'2026-01-01','r','failed','a',null,'reason','legacy')");
  run("insert into discovery_settings values (1,3,'{\"max_weekly_hours\": null, \"min_fixed_twd\": 3000, \"categories\": [\"AI agent\"]}')");
  run("insert into mail_sync_state values ('tasker','r','{\"cursor\": \"c\"}')");
  run("insert into mail_ingestion values ('tasker','r','m1','rejected','parse',1,'t')");
  run("insert into mail_content_versions values ('o1','fp2','{\"title\": \"x\"}')");
  run("insert into manual_applications values ('a1','t','c',null,'2026-10-01','applied',null,'',1,'c','u',null,'q1','{}')");
  run("insert into manual_application_opportunities values ('a1','o1')");
  run("insert into manual_application_events values ('a1',1,'created','{}','c')");
  run("insert into clients values ('c1','Client','',1,'c','u',null,'q2','{}')");
  run("insert into client_contacts values ('k1','c1','Name','addr','',1,'c','u',null,'q3','{}')");
  run("insert into application_parties values ('a1','c1','k1','{}')");
  run("insert into proposal_templates values ('t1','T','body',1,'c','u',null,'q4','{}')");
  run("insert into proposal_drafts values ('p1','D',1,'{}','{}','null','c','u',null,'q5','{}')");
  run("insert into proposal_draft_revisions values ('p1',1,'b','{}','[]','{}','q5','{}','c')");
  run("insert into submission_intents values ('s1','p1',1,'{}','h',null,'cancelled',2,'c','u',null,null,null,null,'q6','{}')");
  run("insert into submission_events values ('s1',1,'cancelled','{}','c')");
  run("insert into application_proposals values ('a1','p1',1,'s1','{}')");
}

function copy(name: string, mutate?: (lite: DatabaseSync) => void) {
  const file = path.join(dir, name);
  const lite = sqliteWithSchema(file);
  seed(lite);
  mutate?.(lite);
  lite.close();
  return file;
}

const scenario = fixture<{ scenarios: Record<string, { tables: Record<string, unknown[][]> }> }>("golden.json").scenarios.digest_novelty_and_uncertain_delivery;
const pythonCopy = (name: string, tamper = false, tracking = true) => {
  const file = path.join(dir, name);
  const lite = sqliteWithSchema(file);
  const t = scenario.tables;
  const run = (sql: string, rows: unknown[][]) => { for (const r of rows) lite.prepare(sql).run(...(r as (string | number | null)[])); };
  run("insert into opportunities values (?,?,?,?)", t.opportunities);
  run("insert into source_receipts (source, receipt_id, opportunity_id) values (?,?,?)", t.source_receipts);
  run("insert into source_health (source, status) values (?,?)", t.source_health);
  if (tracking) {
    run("insert into opportunity_tracking values (?,?)", t.opportunity_tracking);
    run("insert into tracking_events values (?,?,?,?,?)", t.tracking_events);
  }
  run("insert into discovery_settings values (?,?,?)", t.discovery_settings);
  t.digest_outbox.forEach(([d, r, snapshot, status, receipt], n) => {
    // Production has one recipient; the other one's digest of that day cannot affect this one's.
    if (d === "2026-10-03" && r !== "owner@example.invalid") return;
    const text = tamper && d === "2026-10-03" && r === "owner@example.invalid" ? (snapshot as string).replace('"unseen_count": 2', '"unseen_count": 3') : snapshot;
    lite.prepare("insert into digest_outbox (id, local_date, recipient, snapshot, status, delivery_receipt) values (?,?,?,?,?,?)").run(`d${n}`, d as string, r as string, text as string, status as string, receipt as string | null);
  });
  lite.close();
  return file;
};

let base: string;
beforeAll(() => { base = copy("base.sqlite3"); });
beforeEach(resetSchema);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const triggers = async () => (await query<{ name: string }>("select name from sqlite_master where type = 'trigger' order by name")).map((r) => r.name);

describe("one-time import into D1", () => {
  it("lists every SQLite table exactly once", () => {
    const lite = sqliteWithSchema();
    const names = (lite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    expect(TABLES.map((t) => t.name).sort()).toEqual(names.sort());
  });

  it("loads a copy losslessly, gives the identical report when run again, and keeps the schema whole", async () => {
    const schema = await triggers();
    const first = await importCopy(base, db, rebuild);
    const second = await importCopy(base, db, rebuild);
    expect(first.ok).toBe(true);
    expect({ ...second, d1RowsWritten: 0 }).toEqual({ ...first, d1RowsWritten: 0 });
    expect(first.d1RowsWritten).toBeGreaterThan(0);
    expect(Object.values(first.tables).every((t) => t.source.rows > 0 && t.source.sha256 === t.target.sha256)).toBe(true);
    const [row] = await query("select item from opportunities where id='o1'");
    expect(row.item).toContain('"budget_max": 1.0'); // stored bytes, not re-serialized JSON
    expect(await triggers()).toEqual(schema);
    // The product writes on the imported tables, under the lease, as usual (the seed's settings are a stub).
    await leased("delete from discovery_settings");
    const listing = job({ source: "guru", external_id: "new" });
    await ingestSource(db, "guru", new PyDateTime(2026, 10, 27, 1, 0, 0, 0, 0n), [[listing, "r-new"]], () => true, "ok");
    expect(await query("select count(*) n from opportunities")).toEqual([{ n: 4 }]);
  });

  it("continues the tracking_events ids after the copied rows", async () => {
    await importCopy(base, db, rebuild);
    const [{ id }] = await query<{ id: number }>("select max(id) id from tracking_events");
    expect(id).toBe(2);
    await leased("insert into tracking_events (opportunity_id, revision, state, created_at) values ('o1', 3, '{}', 't3')");
    expect(await query("select max(id) id from tracking_events")).toEqual([{ id: 3 }]);
  });

  it("leaves the D1-only bookkeeping alone", async () => {
    await query("insert into write_attempts (attempt_id) values ('kept')");
    await importCopy(base, db, rebuild);
    expect(await query("select attempt_id from write_attempts")).toEqual([{ attempt_id: "kept" }]);
    expect(await query("select holder from writer_lease")).toEqual([{ holder: null }]);
  });

  it("rebuilds the notified ledger from the copied digests", async () => {
    // derived counts the ledger and the discovery projection (one row per record and per content version).
    const projected = async () => Number((await query("select (select count(*) from discovery_items) + (select count(*) from discovery_versions) as n"))[0].n);
    const report = await importCopy(base, db, rebuild);
    expect([report.derived, await projected()]).toEqual([4, 4]); // the base digest announced nothing
    const ledger = await importCopy(pythonCopy("import-ledger.sqlite3"), db, rebuild);
    const rows = ledger.derived - await projected();
    expect(rows).toBeGreaterThan(0);
    expect(await checkLedger(db, "2000-01-01")).toMatchObject({ rows, missing: 0, extra: 0, ok: true });
    // The imported projection serves the same list as the raw rows.
    const now = new PyDateTime(2026, 10, 26, 1, 0, 0, 0, 0n);
    expect(encode(await listPage(db, now, { offset: 0, limit: 1000 }))).toBe(encode(await list(db, now)));
  });

  it("finishes when run again after an interruption", async () => {
    let sent = 0;
    const flaky = intercepting(async (statements) => { if (statements[0]?.startsWith("insert into guard") && ++sent === 3) throw new Error("connection reset"); });
    await expect(importCopy(base, flaky.db, rebuild)).rejects.toThrow("connection reset");
    expect(await query("select holder from writer_lease")).toEqual([{ holder: null }]);
    const again = await importCopy(base, db, rebuild);
    expect(again.ok).toBe(true);
  });

  it("refuses values that do not match their column, naming only table and column, and copies text exactly", async () => {
    const bad = copy("bad.sqlite3", (lite) => {
      // SQLite keeps non-numeric text in an INTEGER column (a TEXT column would turn 42 into '42').
      lite.prepare("update clients set revision = 'one'").run();
    });
    await expect(importCopy(bad, db, rebuild)).rejects.toThrow(CopyError);
    await expect(importCopy(bad, db, rebuild)).rejects.toThrow(/^clients: .*revision \(1\)$/);
    const nul = copy("nul.sqlite3", (lite) => { lite.prepare("update proposal_templates set body = 'a' || char(0) || 'b'").run(); });
    expect((await importCopy(nul, db, rebuild)).ok).toBe(true);
  });

  it("refuses a copy whose table set differs", () => {
    const file = path.join(dir, "missing.sqlite3");
    const lite = sqliteWithSchema(file);
    lite.exec("drop table application_proposals");
    expect(() => checkTableSet(lite)).toThrow("missing application_proposals");
    lite.close();
  });

  it("waits for the writer lease and gives up when another holder keeps it", async () => {
    await query("insert into writer_lease (id, holder, token, expires_at) values (1, 'other', 1, unixepoch() + 600)");
    await expect(importCopy(base, db, rebuild, 200)).rejects.toThrow("writer lease not available in time");
  });

  it("recreates tables in their current shape from SQLite's catalog, with their indexes and triggers", async () => {
    const ddl = await createStatements(["digest_novelty", "tracking_events"]);
    expect(ddl.map((sql) => sql.split(/[\s(]/).slice(0, 3).join(" "))).toEqual([
      "CREATE TABLE `digest_novelty`", "CREATE TABLE `tracking_events`", "CREATE UNIQUE INDEX",
      "CREATE TRIGGER digest_novelty_immutable", "CREATE TRIGGER digest_novelty_retained",
    ]);
  });
});

describe("migrations on D1", () => {
  it("apply to a live database behind the writer lease, even when they alter a leased table", async () => {
    const folder = mkdtempSync(path.join(dir, "migrations-"));
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalFile = path.join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalFile, "utf8"));
    journal.entries.push({ idx: journal.entries.length, version: "6", when: journal.entries.at(-1).when + 1, tag: "9999_test_alter", breakpoints: true });
    writeFileSync(journalFile, JSON.stringify(journal));
    writeFileSync(path.join(folder, "9999_test_alter.sql"), "ALTER TABLE `clients` ADD `x` text;");
    const rec = recording();
    await migrateD1(rec.db, folder);
    expect((await query<{ name: string }>("pragma table_info(clients)")).map((c) => c.name)).toContain("x");
    expect(rec.batches.find((b) => b.some((s) => s.sql.startsWith("ALTER TABLE")))![0].sql).toMatch(/^insert into guard/);
    expect(await query("select holder from writer_lease")).toEqual([{ holder: null }]);
    // Applied once: a second run has nothing to send.
    const before = rec.batches.length;
    await migrateD1(rec.db, folder);
    expect(rec.batches.slice(before).some((b) => b.some((s) => s.sql.startsWith("ALTER TABLE")))).toBe(false);
  });
});

describe("snapshot", () => {
  const tsx = path.resolve(import.meta.dirname, "../node_modules/.bin/tsx");
  const script = path.resolve(import.meta.dirname, "../scripts/snapshot.ts");
  it("copies through the backup API and never overwrites an earlier copy", async () => {
    const { execFileSync } = await import("node:child_process");
    const target = path.join(dir, "snap.sqlite3");
    execFileSync(tsx, [script, "--source", base, "--target", target], { stdio: "pipe" });
    const report = await importCopy(target, db, rebuild);
    const original = await importCopy(base, db, rebuild);
    expect(report.tables).toEqual(original.tables);
    expect(() => execFileSync(tsx, [script, "--source", base, "--target", target], { stdio: "pipe" })).toThrow();
  });
});

// Plan step 10b: the same-start digest replay, on a Python-shaped copy built from the golden
// scenario's final tables (gen_golden.py ran create_digest on exactly these rows).
describe("digest replay", () => {
  it("rebuilds Python's digest byte for byte without touching D1", async () => {
    await importCopy(base, db, rebuild);
    const before = await query("select count(*) n from digest_outbox");
    // Only the scenario's last digest was built from its final rows; earlier days saw fewer jobs.
    const copy = pythonCopy("replay.sqlite3");
    const report = await replayDigest({ start: copy, python: copy }, "2026-10-03");
    expect([report.equal, report.firstDifference, report.python!.items]).toEqual([true, null, 2]);
    expect(await query("select count(*) n from digest_outbox")).toEqual(before);
  });

  it("reports a differing snapshot and a day without a Python digest", async () => {
    const tampered = pythonCopy("replay-tampered.sqlite3", true);
    const report = await replayDigest({ start: tampered, python: tampered }, "2026-10-03");
    expect(report.equal).toBe(false);
    expect(report.firstDifference).toBeGreaterThan(0);
    const none = pythonCopy("replay-none.sqlite3");
    expect((await replayDigest({ start: none, python: none }, "2026-11-01")).equal).toBeNull();
  });

  it("is inconclusive when Will changed a user table between the 08:30 copy and the after-run copy", async () => {
    const report = await replayDigest({ start: pythonCopy("replay-0830.sqlite3", false, false), python: pythonCopy("replay-1030.sqlite3") }, "2026-10-03");
    expect([report.equal, report.userChanges, report.python]).toEqual([null, ["opportunity_tracking", "tracking_events"], null]);
  });
});
