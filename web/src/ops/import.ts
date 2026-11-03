import type { DatabaseSync } from "node:sqlite";
import { clientOf, dbOver, insertChunks, MAX_PARAMS, type Db } from "@/db/client";
import { D1Client, type D1Statement } from "@/db/d1/client";
import { localTransport } from "@/db/d1/local";
import { migrateD1 } from "@/db/migrate";
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
 * product code (ops reads tables, not modules). Leased tables (the discovery projection) are written
 * through `send`, under the import's lease. Returns how many rows it wrote.
 */
export type RebuildDerived = (db: Db, lite: DatabaseSync, send: (statements: D1Statement[]) => Promise<unknown>) => Promise<number>;

const quoted = (name: string) => `"${name}"`;

/**
 * The DDL that creates these tables, their indexes and triggers in their current shape: read from
 * SQLite's own catalog (sqlite_master) of an empty stand-in built from the same migrations that were
 * just applied to the target, rather than replaying migration history. Automatic indexes have no SQL
 * and come with their table.
 */
export async function createStatements(tables: readonly string[], migrationsFolder?: string): Promise<string[]> {
  const stand = localTransport(":memory:");
  try {
    await migrateD1(dbOver(new D1Client(stand)), migrationsFolder);
    const [catalog] = await stand.batch([{ sql: `select sql from sqlite_master where sql is not null and tbl_name in (${tables.map(() => "?").join(",")}) ` +
      "order by case type when 'table' then 0 when 'index' then 1 else 2 end, rowid", params: [...tables] }]);
    return catalog.rows.map((r) => String(r[0]));
  } finally {
    stand.close();
  }
}

/** Multi-row INSERTs of a table's rows, each within D1's bound parameters. */
function inserts(table: string, columns: Column[], rows: Row[]): D1Statement[] {
  const names = columns.map((c) => quoted(c.name)).join(",");
  const tuple = "(" + columns.map(() => "?").join(",") + ")";
  // Integers travel as text and land as integers through the column's INTEGER affinity (spike 1f (e)).
  return insertChunks(rows, Math.min(columns.length, MAX_PARAMS)).map((chunk) => ({
    sql: `insert into ${quoted(table)} (${names}) values ${chunk.map(() => tuple).join(",")}`,
    params: chunk.flat().map((cell) => (cell === null ? null : "i" in cell ? cell.i : cell.s)),
  }));
}

async function d1Columns(db: Db, table: string): Promise<Column[]> {
  const [info] = await clientOf(db).batch([{ sql: `pragma table_info(${quoted(table)})`, params: [] }]);
  return columnsOf(table, info.rows.map((r) => ({ name: String(r[info.columns.indexOf("name")]), type: String(r[info.columns.indexOf("type")]) })));
}

/**
 * Loads every row of the copy into the (empty) product tables, in load order, under the caller's
 * lease, and returns what was read.
 */
export async function loadCopy(db: Db, lite: DatabaseSync, send: (statements: D1Statement[]) => Promise<unknown>): Promise<Map<string, Row[]>> {
  const source = new Map<string, Row[]>();
  const statements: D1Statement[] = [];
  for (const spec of TABLES) {
    const columns = await d1Columns(db, spec.name);
    if (sqliteColumns(lite, spec.name).map((c) => `${c.name}:${c.type}`).join() !== columns.map((c) => `${c.name}:${c.type}`).join()) {
      throw new CopyError(`${spec.name}: columns differ between the copy and D1`);
    }
    const rows = readSqliteRows(lite, spec, columns);
    source.set(spec.name, rows);
    statements.push(...inserts(spec.name, columns, rows));
  }
  await send(statements);
  return source;
}


/** What the discovery projection derives from in a copy (plan step 10e1): record envelopes, content versions, the settings row. */
export type CopiedDiscovery = {
  items: string[];
  versions: { opportunityId: string; fingerprint: string; job: string }[];
  settings: { revision: number; settings: string } | null;
};

export function copiedDiscovery(lite: DatabaseSync): CopiedDiscovery {
  const items = (lite.prepare("select item from opportunities order by id").all() as { item: string }[]).map((r) => r.item);
  const versions = lite.prepare("select opportunity_id as opportunityId, fingerprint, job from mail_content_versions order by opportunity_id, fingerprint")
    .all() as CopiedDiscovery["versions"];
  const [settings] = lite.prepare("select revision, settings from discovery_settings where id = 1").all() as { revision: number; settings: string }[];
  return { items, versions, settings: settings ?? null };
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
  const create = await createStatements(names);
  // DROP TABLE writes no rows on D1 and fires no triggers ("1f 補充"); reverse load order keeps foreign keys satisfied.
  await send([...names].reverse().map((n) => ({ sql: `drop table if exists ${quoted(n)}`, params: [] })));
  await send(create.map((sql) => ({ sql, params: [] })));
}

export async function importCopy(sqlitePath: string, db: Db, rebuild: RebuildDerived, waitMs = DAILY_WRITE.waitMs): Promise<ImportReport> {
  const lite = openSqlite(sqlitePath);
  const before = clientOf(db).counters.rowsWritten;
  try {
    checkTableSet(lite);
    await migrateD1(db);
    // The lease keeps product write units out until the report is in. It does not stop the single-
    // statement writers (daily claim, mail records): a reload runs with the cron off or
    // outside 09:00–09:59 Asia/Taipei (plan step 4e3).
    return await withLease(db, waitMs, async (send) => {
      await recreateTables(send);
      const source = await loadCopy(db, lite, send);
      const derived = await rebuild(db, lite, send);
      const { ok, tables } = await report(source, db);
      return { ok, tables, derived, d1RowsWritten: clientOf(db).counters.rowsWritten - before };
    });
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
