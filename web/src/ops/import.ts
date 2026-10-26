import type { DatabaseSync } from "node:sqlite";
import { clientOf, type Db } from "@/db/client";
import type { D1Statement } from "@/db/d1/client";
import { migrateD1, migrationStatements } from "@/db/migrate";
import { DAILY_WRITE, withLease } from "@/db/unit";
import { columnsOf, CopyError, d1Rows, d1RowsQuery, fingerprint, openSqlite, readSqliteRows, sqliteColumns, sqliteTables, type Column, type Row } from "./rows";
import { DERIVED_TABLES, TABLES } from "./tables";

// The one-time import "SQLite copy → D1" (plan step 4e3), for loading the D1 shadow (step 4e4) and
// the production database (step 13). Under the writer lease it drops the product tables, recreates
// them from the migrations, loads the copy unchanged and rebuilds the derived tables; the D1-only
// bookkeeping (writer_lease, write_attempts, guard) and the migration journal stay. Nothing about a
// load is kept between runs, so an interrupted import is simply run again; the report compares every
// table with the copy, and only an ok report releases the database for use.

export type TableReport = { rows: number; sha256: string };
export type ImportReport = {
  ok: boolean;
  tables: Record<string, { source: TableReport; target: TableReport }>;
  derived: number;
  /** D1's own count of the rows the import wrote (the account's daily free quota is 100,000). */
  d1RowsWritten: number;
};

/**
 * Rebuilds DERIVED_TABLES from the loaded copy; the caller supplies it because the derivation is
 * product code (ops reads tables, not modules). Returns how many rows it wrote.
 */
export type RebuildDerived = (db: Db, lite: DatabaseSync) => Promise<number>;

const PARAMS = 100; // bound parameters per statement on D1
const STATEMENTS = 60; // statements per leased request, under the 75 measured in spike 1f (a)
const BYTES = 4_000_000;

const quoted = (name: string) => `"${name}"`;

/** The migration statements that (re)create one of these tables, its indexes or its triggers; anything else is refused. */
export function recreateStatements(tables: readonly string[], statements = migrationStatements()): string[] {
  const wanted = new Set(tables);
  const out: string[] = [];
  for (const raw of statements) {
    const sql = raw.replace(/^(\s*--[^\n]*\n)+/, "").trim();
    const target = /^CREATE TABLE [`"]?(\w+)/i.exec(sql)?.[1] ?? /^ALTER TABLE [`"]?(\w+)/i.exec(sql)?.[1]
      ?? /^CREATE (?:UNIQUE )?INDEX .*? ON [`"]?(\w+)/i.exec(sql)?.[1] ?? /^CREATE TRIGGER [\s\S]*? ON [`"]?(\w+)/i.exec(sql)?.[1];
    if (target === undefined) throw new CopyError(`migration statement the import cannot place: ${sql.slice(0, 40)}`);
    if (wanted.has(target)) out.push(sql);
  }
  return out;
}

/** Groups statements into requests within D1's limits. */
function requests(statements: D1Statement[]): D1Statement[][] {
  const out: D1Statement[][] = [];
  let current: D1Statement[] = [], bytes = 0;
  for (const s of statements) {
    const size = s.sql.length + s.params.reduce<number>((n, p) => n + (typeof p === "string" ? Buffer.byteLength(p) : 8), 0);
    if (current.length && (current.length >= STATEMENTS || bytes + size > BYTES)) {
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

/** Multi-row INSERTs of a table's rows, each within D1's 100 bound parameters. */
function inserts(table: string, columns: Column[], rows: Row[]): D1Statement[] {
  const per = Math.max(1, Math.floor(PARAMS / columns.length));
  const names = columns.map((c) => quoted(c.name)).join(",");
  const tuple = "(" + columns.map(() => "?").join(",") + ")";
  const out: D1Statement[] = [];
  for (let at = 0; at < rows.length; at += per) {
    const chunk = rows.slice(at, at + per);
    // Integers travel as text and land as integers through the column's INTEGER affinity (spike 1f (e)).
    out.push({ sql: `insert into ${quoted(table)} (${names}) values ${chunk.map(() => tuple).join(",")}`,
      params: chunk.flat().map((cell) => (cell === null ? null : "i" in cell ? cell.i : cell.s)) });
  }
  return out;
}

async function d1Columns(db: Db, table: string): Promise<Column[]> {
  const [info] = await clientOf(db).batch([{ sql: `pragma table_info(${quoted(table)})`, params: [] }]);
  return columnsOf(table, info.rows.map((r) => ({ name: String(r[info.columns.indexOf("name")]), type: String(r[info.columns.indexOf("type")]) })));
}

/**
 * Loads every row of the copy into the (empty) product tables, in load order, under the caller's
 * lease, and returns what was read. `keep` drops rows (the digest replay leaves out the day it rebuilds).
 */
export async function loadCopy(db: Db, lite: DatabaseSync, send: (statements: D1Statement[]) => Promise<unknown>,
  keep: (table: string, columns: Column[], row: Row) => boolean = () => true): Promise<Map<string, Row[]>> {
  const source = new Map<string, Row[]>();
  const statements: D1Statement[] = [];
  for (const spec of TABLES) {
    const columns = await d1Columns(db, spec.name);
    if (sqliteColumns(lite, spec.name).map((c) => `${c.name}:${c.type}`).join() !== columns.map((c) => `${c.name}:${c.type}`).join()) {
      throw new CopyError(`${spec.name}: columns differ between the copy and D1`);
    }
    const rows = readSqliteRows(lite, spec, columns).filter((row) => keep(spec.name, columns, row));
    source.set(spec.name, rows);
    statements.push(...inserts(spec.name, columns, rows));
  }
  for (const request of requests(statements)) await send(request);
  return source;
}

/** The digest rows of a copy, for rebuilding the ledger without reading the snapshots back; `skipDay` is left out. */
export function copiedDigests(lite: DatabaseSync, skipDay?: string): { id: string; snapshot: string }[] {
  return lite.prepare("select id, snapshot from digest_outbox where local_date is not ? order by id").all(skipDay ?? null) as { id: string; snapshot: string }[];
}

export function checkTableSet(lite: DatabaseSync) {
  const present = sqliteTables(lite), expected = TABLES.map((t) => t.name).sort();
  if (present.join() !== expected.join()) {
    throw new CopyError(`table set differs from the import list: missing ${expected.filter((t) => !present.includes(t)).join(" ") || "-"}, ` +
      `unexpected ${present.filter((t) => !expected.includes(t)).join(" ") || "-"}`);
  }
}

/** Drops and recreates the product and derived tables, children first, under the caller's lease. */
export async function recreateTables(send: (statements: D1Statement[]) => Promise<unknown>) {
  const names = [...TABLES.map((t) => t.name), ...DERIVED_TABLES];
  // DROP TABLE writes no rows on D1 and fires no triggers ("1f 補充"); reverse load order keeps foreign keys satisfied.
  for (const request of requests([...names].reverse().map((n) => ({ sql: `drop table if exists ${quoted(n)}`, params: [] })))) await send(request);
  for (const request of requests(recreateStatements(names).map((sql) => ({ sql, params: [] })))) await send(request);
}

export async function importCopy(sqlitePath: string, db: Db, rebuild: RebuildDerived, waitMs = DAILY_WRITE.waitMs): Promise<ImportReport> {
  const lite = openSqlite(sqlitePath);
  const before = clientOf(db).counters.rowsWritten;
  try {
    checkTableSet(lite);
    await migrateD1(db);
    const source = await withLease(db, waitMs, async (send) => {
      await recreateTables(send);
      return loadCopy(db, lite, send);
    });
    // digest_novelty is written outside the lease (a single-statement table, plan step 4e category 1).
    const derived = await rebuild(db, lite);
    const { ok, tables } = await report(source, db);
    return { ok, tables, derived, d1RowsWritten: clientOf(db).counters.rowsWritten - before };
  } finally {
    lite.close();
  }
}

/** Per-table counts and content fingerprints of what was read from the copy and what D1 now holds. */
async function report(source: Map<string, Row[]>, db: Db): Promise<Pick<ImportReport, "ok" | "tables">> {
  const tables: ImportReport["tables"] = {};
  let ok = true;
  for (const spec of TABLES) {
    const columns = await d1Columns(db, spec.name);
    const rows = source.get(spec.name) ?? [];
    const [result] = await clientOf(db).batch([{ sql: d1RowsQuery(spec, columns), params: [] }]);
    const target = d1Rows(result, columns);
    tables[spec.name] = { source: { rows: rows.length, sha256: fingerprint(rows) }, target: { rows: target.length, sha256: fingerprint(target) } };
    ok &&= tables[spec.name].source.sha256 === tables[spec.name].target.sha256;
  }
  return { ok, tables };
}
