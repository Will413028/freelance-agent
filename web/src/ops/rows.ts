import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { D1Result } from "@/db/d1/client";
import type { TableSpec } from "./tables";

// Typed cells read from either side (a SQLite copy, D1), serialized the same way so fingerprints do
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

/** A table's columns as `pragma table_info` gives them, on a copy or on D1; only integer and text exist in this schema. */
export function columnsOf(table: string, info: { name: string; type: string }[]): Column[] {
  return info.map((c) => {
    const type = c.type.toLowerCase();
    if (type !== "integer" && type !== "text") throw new CopyError(`${table}.${c.name}: unsupported type ${c.type}`);
    return { name: c.name, type };
  });
}

export const sqliteColumns = (lite: DatabaseSync, table: string): Column[] =>
  columnsOf(table, lite.prepare(`pragma table_info("${table}")`).all() as { name: string; type: string }[]);

const orderBy = (spec: TableSpec) => spec.pk.map((k) => `"${k}"`).join(",");

/**
 * Rows in primary-key order. SQLite keeps any value in any column, so each one is checked against
 * its column's declared type: a value that does not match is refused rather than copied as is.
 */
export function readSqliteRows(lite: DatabaseSync, spec: TableSpec, columns: Column[]): Row[] {
  const names = columns.map((c) => `"${c.name}"`).join(",");
  const rows = lite.prepare(`select ${names} from "${spec.name}" order by ${orderBy(spec)}`).all() as Record<string, unknown>[];
  const bad = new Map<string, number>();
  const out = rows.map((r) => columns.map((col) => {
    const v = r[col.name];
    if (v === null) return null;
    if (col.type === "integer" && typeof v === "bigint") return { i: v.toString() };
    if (col.type === "text" && typeof v === "string") return { s: v };
    bad.set(col.name, (bad.get(col.name) ?? 0) + 1);
    return null;
  }));
  if (bad.size) {
    throw new CopyError(`${spec.name}: values that do not match their column type: ` + [...bad].map(([c, n]) => `${c} (${n})`).join(", "));
  }
  return out;
}

/** The query that reads a table back from D1 in the same order; integers as text, so values above 2^53 stay exact. */
export const d1RowsQuery = (spec: TableSpec, columns: Column[]) =>
  `select ${columns.map((c) => (c.type === "integer" ? `cast("${c.name}" as text)` : `"${c.name}"`)).join(",")} from "${spec.name}" order by ${orderBy(spec)}`;

export const d1Rows = (result: D1Result, columns: Column[]): Row[] =>
  result.rows.map((r) => r.map((v, n) => (v === null ? null : columns[n].type === "integer" ? { i: String(v) } : { s: String(v) })));

export function fingerprint(rows: Row[]): string {
  const h = createHash("sha256");
  for (const row of rows) h.update(rowText(row) + "\n");
  return h.digest("hex");
}
