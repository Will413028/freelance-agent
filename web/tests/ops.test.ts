import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareShadow } from "@/ops/compare";
import { converge } from "@/ops/converge";
import { CopyError } from "@/ops/rows";
import { TABLES } from "@/ops/tables";
import { pool, sqliteWithSchema } from "./helpers/db";

const migrations = path.resolve(import.meta.dirname, "../drizzle");
const dir = mkdtempSync(path.join(os.tmpdir(), "fa-ops-"));
const labels = { start: "start", python: "python", ts: "ts" };

/** A synthetic production-shaped copy: every table has rows, with the awkward values production can hold. */
function seed(lite: DatabaseSync) {
  // Python's encode() output: float 1.0 keeps its ".0", which JSON.stringify could not write.
  const item = (id: string) => `{"id": "${id}", "job": {"source": "guru", "external_id": "${id}", "title": "徵 AI agent 😀", "budget_max": 1.0}}`;
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
  run("insert into discovery_settings values (1,3,'{\"max_weekly_hours\": null}')");
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

let base: string;
beforeAll(() => { base = copy("base.sqlite3"); });
afterAll(async () => { await pool.end(); rmSync(dir, { recursive: true, force: true }); });

describe("convergence script v1", () => {
  it("lists every SQLite table exactly once", () => {
    const lite = sqliteWithSchema();
    const names = (lite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    expect(TABLES.map((t) => t.name).sort()).toEqual(names.sort());
  });

  it("loads a copy losslessly and gives the identical report when run twice", async () => {
    const first = await converge(base, pool, migrations);
    const second = await converge(base, pool, migrations);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(Object.values(first.tables).every((t) => t.source.rows > 0 && t.source.sha256 === t.target.sha256)).toBe(true);
    const { rows } = await pool.query("select item from opportunities where id='o1'");
    expect(rows[0].item).toContain('"budget_max": 1.0'); // stored bytes, not re-serialized JSON
  });

  it("continues the tracking_events id sequence after the copied rows", async () => {
    await converge(base, pool, migrations);
    const { rows } = await pool.query("insert into tracking_events (opportunity_id, revision, state, created_at) values ('o1', 3, '{}', 't3') returning id");
    expect(rows[0].id).toBe(3);
  });

  it("refuses values that would change on copy, naming only table and column", async () => {
    const bad = copy("bad.sqlite3", (lite) => {
      // SQLite keeps non-numeric text in an INTEGER column (a TEXT column would turn 42 into '42').
      lite.prepare("update clients set revision = 'one'").run();
      lite.prepare("update proposal_templates set body = 'a' || char(0) || 'b'").run();
    });
    await expect(converge(bad, pool, migrations)).rejects.toThrow(CopyError);
    await expect(converge(bad, pool, migrations)).rejects.toThrow(/^clients: .*revision \(1\)$/);
  });
});

describe("shadow comparator v1", () => {
  it("reports no differences when both sides equal the start copy", async () => {
    await converge(base, pool, migrations);
    const report = await compareShadow({ start: base, python: base }, pool, labels);
    expect(report.counts).toEqual({ timing: 0, user_action: 0, logic: 0 });
    expect(report.diffs).toEqual([]);
  });

  it("ignores volatile columns and generated ids", async () => {
    await converge(base, pool, migrations);
    const python = copy("python-volatile.sqlite3", (lite) => {
      lite.prepare("update source_health set checked_at = '2026-10-23 09:00:00'").run();
      lite.prepare("insert into tracking_events (opportunity_id, revision, state, created_at) values ('o2', 1, '{}', 't')").run();
    });
    await pool.query("update source_health set checked_at = '2026-10-23 09:30:00'");
    await pool.query("insert into tracking_events (id, opportunity_id, revision, state, created_at) overriding system value values (99, 'o2', 1, '{}', 't')");
    const report = await compareShadow({ start: base, python }, pool, labels);
    expect(report.diffs.filter((d) => d.class === "logic")).toEqual([]);
    expect(report.tables.tracking_events).toEqual({ python: 1, ts: 1, agree: 1 });
  });

  it("classifies fetch-time, production-only and logic differences", async () => {
    await converge(base, pool, migrations);
    const python = copy("python-run.sqlite3", (lite) => {
      lite.prepare("insert into opportunities values ('o4','guru','o4','{}')").run();
      lite.prepare("insert into opportunity_tracking values ('o2','{\"revision\": 1}')").run();
      lite.prepare("update opportunities set item = '{\"python\": 1}' where id = 'o2'").run();
    });
    await pool.query("insert into opportunities values ('o5','guru','o5','{}')");
    await pool.query("update opportunities set item = '{\"ts\": 1}' where id = 'o2'");
    await pool.query("insert into clients values ('c2','x','',1,'c','u',null,'q9','{}')");
    const report = await compareShadow({ start: base, python }, pool, labels);
    const by = (cls: string) => report.diffs.filter((d) => d.class === cls).map((d) => `${d.table}:${d.kind}`).sort();
    expect(by("timing")).toEqual(["opportunities:only_python", "opportunities:only_ts"]);
    expect(by("user_action")).toEqual(["opportunity_tracking:only_python"]);
    expect(by("logic")).toEqual(["clients:only_ts", "opportunities:different"]);
  });

  it("reports rows a side deleted as logic", async () => {
    await converge(base, pool, migrations);
    const python = path.join(dir, "python-deleted.sqlite3");
    copyFileSync(base, python);
    await pool.query("delete from mail_ingestion");
    const report = await compareShadow({ start: base, python }, pool, labels);
    expect(report.diffs).toEqual([expect.objectContaining({ table: "mail_ingestion", kind: "deleted", class: "logic" })]);
  });
});

describe("snapshot", () => {
  const tsx = path.resolve(import.meta.dirname, "../node_modules/.bin/tsx");
  const script = path.resolve(import.meta.dirname, "../scripts/snapshot.ts");
  it("copies through the backup API and never overwrites an earlier copy", async () => {
    const { execFileSync } = await import("node:child_process");
    const target = path.join(dir, "snap.sqlite3");
    execFileSync(tsx, [script, "--source", base, "--target", target], { stdio: "pipe" });
    const report = await converge(target, pool, migrations);
    const original = await converge(base, pool, migrations);
    expect(report.tables).toEqual(original.tables);
    expect(() => execFileSync(tsx, [script, "--source", base, "--target", target], { stdio: "pipe" })).toThrow();
  });
});
