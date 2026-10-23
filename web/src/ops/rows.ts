import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type { TableSpec } from "./tables";

// Typed cells read from either side, serialized the same way so fingerprints and comparisons do
// not depend on the driver. Error messages name tables and columns only: copied values are personal data.

export type Cell = null | { i: string } | { s: string };
export type Column = { name: string; type: "integer" | "text" };
export type Row = Cell[];

export class CopyError extends Error {}

export const cellText = (c: Cell) => (c === null ? "null" : "i" in c ? "i:" + c.i : "s:" + JSON.stringify(c.s));
export const rowText = (row: Row) => "[" + row.map(cellText).join(",") + "]";

export function openSqlite(path: string) {
  return new DatabaseSync(path, { readOnly: true, readBigInts: true });
}

export function sqliteTables(lite: DatabaseSync): string[] {
  return (lite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as { name: string }[])
    .map((r) => r.name);
}

export function sqliteColumns(lite: DatabaseSync, table: string): string[] {
  return (lite.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
}

/** Rows in primary-key order, each value checked against the Postgres column type. */
export function readSqliteRows(lite: DatabaseSync, spec: TableSpec, columns: Column[]): Row[] {
  const names = columns.map((c) => `"${c.name}"`).join(",");
  const rows = lite.prepare(`select ${names} from "${spec.name}" order by ${spec.pk.map((k) => `"${k}"`).join(",")}`).all() as Record<string, unknown>[];
  const bad = new Map<string, number>();
  const out = rows.map((r) => columns.map((col) => {
    const v = r[col.name];
    if (v === null) return null;
    if (col.type === "integer" && typeof v === "bigint" && v >= -2147483648n && v <= 2147483647n) return { i: v.toString() };
    if (col.type === "text" && typeof v === "string" && !v.includes("\u0000")) return { s: v };
    bad.set(col.name, (bad.get(col.name) ?? 0) + 1);
    return null;
  }));
  if (bad.size) {
    throw new CopyError(`${spec.name}: values that cannot be copied without changing them: ` +
      [...bad].map(([c, n]) => `${c} (${n})`).join(", "));
  }
  return out;
}

type Queryable = Pool | PoolClient;

export async function pgColumns(db: Queryable, table: string): Promise<Column[]> {
  const { rows } = await db.query(
    "select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",
    [table],
  );
  return rows.map((r) => {
    if (r.data_type !== "integer" && r.data_type !== "text") throw new CopyError(`${table}.${r.column_name}: unsupported type ${r.data_type}`);
    return { name: r.column_name, type: r.data_type };
  });
}

export async function readPgRows(db: Queryable, spec: TableSpec, columns: Column[]): Promise<Row[]> {
  const { rows } = await db.query({
    text: `select ${columns.map((c) => `"${c.name}"`).join(",")} from "${spec.name}" order by ${spec.pk.map((k) => `"${k}"`).join(",")}`,
    rowMode: "array",
  });
  return (rows as unknown[][]).map((r) => r.map((v, n) => (v === null ? null : columns[n].type === "integer" ? { i: String(v) } : { s: String(v) })));
}

export function fingerprint(rows: Row[]): string {
  const h = createHash("sha256");
  for (const row of rows) h.update(rowText(row) + "\n");
  return h.digest("hex");
}
