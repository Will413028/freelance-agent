import { DatabaseSync } from "node:sqlite";
import { clientOf, type Db } from "@/db/client";
import { DAILY_WRITE, withLease } from "@/db/unit";
import { checkTableSet } from "./import";
import { columnsOf, CopyError, d1Rows, d1RowsQuery, fingerprint, readSqliteRows, rowText, sqliteColumns, type Cell, type Column, type Row } from "./rows";
import { TABLES, type TableSpec } from "./tables";

// The write-back "D1 → SQLite" (plan step 12), the rollback inside D6's window: what TS wrote after
// the cutover goes back into a copy of the pre-cutover backup, which the Python system then runs on
// (step 13's rollback). Every TABLES row D1 holds and the copy lacks is inserted, every row that
// differs is updated in the columns that differ; derived and D1-only tables stay behind. TS never
// deletes a TABLES row, so a row only the copy holds is refused. SQLite's own triggers keep the
// immutable tables immutable: an update they refuse rolls the whole write-back back. The lease keeps
// product write units out while D1 is read, but not the single-statement writers (daily_runs,
// mail_sync_state, ...), so D1 is read again after the write and any change rolls it back too.
// Running it again changes nothing. Messages and reports name tables and columns only: values are personal data.

export type WriteBackTable = { inserted: number; updated: number; updatedColumns: Record<string, number>; rows: number; sqlite: string; d1: string };
/** Only a write-back that converged returns; any refusal or mismatch throws and writes nothing. */
export type WriteBackReport = { tables: Record<string, WriteBackTable> };

const key = (spec: TableSpec, columns: Column[], row: Row) => rowText(spec.pk.map((k) => row[columns.findIndex((c) => c.name === k)]));
const value = (cell: Cell) => (cell === null ? null : "i" in cell ? BigInt(cell.i) : cell.s);
const same = (a: Cell, b: Cell) => (a === null || b === null ? a === b : "i" in a ? "i" in b && a.i === b.i : "s" in b && a.s === b.s);

/**
 * Every TABLES row of D1, read under the writer lease so no product write unit lands in between: the
 * columns in one request, the rows in as few leased requests as the batch limit allows.
 */
export async function readD1Tables(db: Db, waitMs = DAILY_WRITE.waitMs): Promise<Map<string, { columns: Column[]; rows: Row[] }>> {
  const infos = await clientOf(db).batch(TABLES.map((spec) => ({ sql: `pragma table_info("${spec.name}")`, params: [] })));
  const columns = TABLES.map((spec, n) => columnsOf(spec.name, infos[n].rows.map((r) => ({
    name: String(r[infos[n].columns.indexOf("name")]), type: String(r[infos[n].columns.indexOf("type")]),
  }))));
  return withLease(db, waitMs, async (send) => {
    const results = await send(TABLES.map((spec, n) => ({ sql: d1RowsQuery(spec, columns[n]), params: [] })));
    return new Map(TABLES.map((spec, n) => {
      const rows = d1Rows(results[n], columns[n]);
      // d1Rows trusts the cast; check integers here so a bad value is named, not a BigInt SyntaxError.
      const bad = columns[n].filter((c, i) => c.type === "integer" && rows.some((row) => { const v = row[i]; return v !== null && "i" in v && !/^-?[0-9]+$/.test(v.i); }));
      if (bad.length) throw new CopyError(`${spec.name}: D1 holds non-integer values in ${bad.map((c) => c.name).join(", ")}`);
      return [spec.name, { columns: columns[n], rows }];
    }));
  });
}

/** Writes D1's TABLES rows back into the SQLite file at `sqlitePath` (a copy, never the live database). */
export async function writeBack(db: Db, sqlitePath: string, waitMs = DAILY_WRITE.waitMs): Promise<WriteBackReport> {
  const d1 = await readD1Tables(db, waitMs);
  const lite = new DatabaseSync(sqlitePath, { readBigInts: true });
  try {
    lite.exec("pragma foreign_keys = on");
    checkTableSet(lite);
    for (const spec of TABLES) {
      const shape = (cs: Column[]) => cs.map((c) => `${c.name}:${c.type}`).join();
      if (shape(sqliteColumns(lite, spec.name)) !== shape(d1.get(spec.name)!.columns)) throw new CopyError(`${spec.name}: columns differ between the copy and D1`);
    }
    checkRecipients(lite, d1.get("daily_runs")!);
    lite.exec("begin immediate");
    try {
      const tables: Record<string, WriteBackTable> = {};
      for (const spec of TABLES) tables[spec.name] = writeTable(lite, spec, d1.get(spec.name)!);
      const integrity = lite.prepare("pragma integrity_check").all() as { integrity_check: string }[];
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new CopyError("the copy fails integrity_check after the write-back");
      const orphans = lite.prepare("pragma foreign_key_check").all() as { table: string }[];
      if (orphans.length) throw new CopyError(`foreign keys broken after the write-back in: ${[...new Set(orphans.map((o) => o.table))].join(", ")}`);
      if (!Object.values(tables).every((t) => t.sqlite === t.d1)) throw new CopyError(`the copy still differs from D1 in: ${Object.entries(tables).filter(([, t]) => t.sqlite !== t.d1).map(([n]) => n).join(", ")}`);
      // A single-statement writer (a daily run, mail intake) may have written D1 since it was read.
      const again = await readD1Tables(db, waitMs);
      const moved = TABLES.filter((spec) => fingerprint(again.get(spec.name)!.rows) !== tables[spec.name].d1).map((spec) => spec.name);
      if (moved.length) throw new CopyError(`D1 changed while writing back (${moved.join(", ")}): stop every writer and run it again`);
      lite.exec("commit");
      return { tables };
    } catch (e) {
      lite.exec("rollback");
      throw e;
    }
  } finally {
    lite.close();
  }
}

/**
 * Python decides whether a day ran by (local_date, recipient): a run TS wrote under a recipient the
 * backup never had would not stop Python from running that day again after the rollback.
 */
function checkRecipients(lite: DatabaseSync, runs: { columns: Column[]; rows: Row[] }) {
  const known = new Set((lite.prepare("select distinct recipient from daily_runs").all() as { recipient: string }[]).map((r) => r.recipient));
  if (!known.size) return;
  const at = runs.columns.findIndex((c) => c.name === "recipient");
  const unknown = runs.rows.filter((row) => { const c = row[at]; return !(c !== null && "s" in c && known.has(c.s)); }).length;
  if (unknown) throw new CopyError(`daily_runs: ${unknown} rows on D1 use a recipient the copy never had (DIGEST_RECIPIENT differs from Python's)`);
}

function writeTable(lite: DatabaseSync, spec: TableSpec, d1: { columns: Column[]; rows: Row[] }): WriteBackTable {
  const { columns } = d1;
  const before = new Map(readSqliteRows(lite, spec, columns).map((row) => [key(spec, columns, row), row]));
  const inD1 = new Set(d1.rows.map((row) => key(spec, columns, row)));
  const removed = [...before.keys()].filter((k) => !inD1.has(k)).length;
  if (removed) throw new CopyError(`${spec.name}: ${removed} rows of the copy are missing on D1, and TS deletes none; refusing to write back`);
  const names = columns.map((c) => `"${c.name}"`).join(",");
  const insert = lite.prepare(`insert into "${spec.name}" (${names}) values (${columns.map(() => "?").join(",")})`);
  const where = spec.pk.map((k) => `"${k}" = ?`).join(" and ");
  const pkValues = (row: Row) => spec.pk.map((k) => value(row[columns.findIndex((c) => c.name === k)]));
  let inserted = 0, updated = 0;
  const updatedColumns: Record<string, number> = {};
  for (const row of d1.rows) {
    const old = before.get(key(spec, columns, row));
    if (!old) {
      insert.run(...row.map(value));
      inserted++;
      continue;
    }
    const changed = columns.map((c, n) => (same(old[n], row[n]) ? -1 : n)).filter((n) => n >= 0);
    if (!changed.length) continue;
    try {
      lite.prepare(`update "${spec.name}" set ${changed.map((n) => `"${columns[n].name}" = ?`).join(", ")} where ${where}`)
        .run(...changed.map((n) => value(row[n])), ...pkValues(old));
    } catch (e) {
      // A trigger (immutable identity, snapshot or revision) refused it; the message names no values.
      throw new CopyError(`${spec.name}: SQLite refused an update of ${changed.map((n) => columns[n].name).join(", ")}: ${e instanceof Error ? e.message : String(e)}`);
    }
    updated++;
    for (const n of changed) updatedColumns[columns[n].name] = (updatedColumns[columns[n].name] ?? 0) + 1;
  }
  const after = readSqliteRows(lite, spec, columns);
  return { inserted, updated, updatedColumns, rows: after.length, sqlite: fingerprint(after), d1: fingerprint(d1.rows) };
}
