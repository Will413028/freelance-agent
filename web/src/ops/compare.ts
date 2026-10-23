import type { Pool } from "pg";
import { openSqlite, pgColumns, readPgRows, readSqliteRows, rowText, type Column, type Row } from "./rows";
import { TABLES, type TableSpec } from "./tables";

// Shadow comparator v1 (plan step 4d). Inputs: the 08:30 copy both systems start from, the copy
// taken after the Python run, and the shadow database after the TS run. Only what each side changed
// after the common start is compared.
//
// Classes:
// - timing: a source row only one side has; the two runs fetched at different times (acceptable,
//   reviewed in bulk).
// - user_action: production-only writes by Will (UI/API); the shadow never replays them (acceptable).
// - logic: anything else — both changed a row differently, or a row only one side produced where
//   fetch time cannot explain it (unacceptable until explained).

export type DiffClass = "timing" | "user_action" | "logic";
export type Diff = { table: string; key: string; class: DiffClass; kind: "only_python" | "only_ts" | "different" | "deleted" };
export type CompareReport = {
  labels: { start: string; python: string; ts: string };
  counts: Record<DiffClass, number>;
  tables: Record<string, { python: number; ts: number; agree: number }>;
  diffs: Diff[];
};

type Side = Map<string, string>; // match key → non-volatile content

function index(spec: TableSpec, columns: Column[], rows: Row[]): Side {
  const keyAt = spec.match.map((k) => columns.findIndex((c) => c.name === k));
  const keep = columns.map((c, n) => (spec.volatile.includes(c.name) ? -1 : n)).filter((n) => n >= 0);
  return new Map(rows.map((row) => [rowText(keyAt.map((n) => row[n])), rowText(keep.map((n) => row[n]))]));
}

/** Rows a side added or changed since start; deletions are reported separately. */
function increment(start: Side, side: Side) {
  const changed = new Map<string, string>(), deleted: string[] = [];
  for (const [k, v] of side) if (start.get(k) !== v) changed.set(k, v);
  for (const k of start.keys()) if (!side.has(k)) deleted.push(k);
  return { changed, deleted };
}

function classify(spec: TableSpec, kind: Diff["kind"]): DiffClass {
  if (spec.owner === "user") return kind === "only_python" ? "user_action" : "logic";
  if (spec.owner === "source" && (kind === "only_python" || kind === "only_ts")) return "timing";
  return "logic";
}

export async function compareShadow(paths: { start: string; python: string }, ts: Pool, labels: CompareReport["labels"]): Promise<CompareReport> {
  const start = openSqlite(paths.start), python = openSqlite(paths.python);
  const report: CompareReport = { labels, counts: { timing: 0, user_action: 0, logic: 0 }, tables: {}, diffs: [] };
  try {
    for (const spec of TABLES) {
      const columns = await pgColumns(ts, spec.name);
      const base = index(spec, columns, readSqliteRows(start, spec, columns));
      const py = increment(base, index(spec, columns, readSqliteRows(python, spec, columns)));
      const tsInc = increment(base, index(spec, columns, await readPgRows(ts, spec, columns)));
      const add = (key: string, kind: Diff["kind"]) => {
        const diff: Diff = { table: spec.name, key, kind, class: kind === "deleted" ? "logic" : classify(spec, kind) };
        report.diffs.push(diff);
        report.counts[diff.class]++;
      };
      let agree = 0;
      for (const [k, v] of py.changed) {
        if (!tsInc.changed.has(k)) add(k, "only_python");
        else if (tsInc.changed.get(k) === v) agree++;
        else add(k, "different");
      }
      for (const k of tsInc.changed.keys()) if (!py.changed.has(k)) add(k, "only_ts");
      for (const k of new Set([...py.deleted, ...tsInc.deleted])) add(k, "deleted");
      report.tables[spec.name] = { python: py.changed.size, ts: tsInc.changed.size, agree };
    }
  } finally {
    start.close();
    python.close();
  }
  return report;
}

/** Human summary; keys may hold listing ids, never row contents. */
export function summarize(r: CompareReport): string {
  const lines = [
    `start copy: ${r.labels.start}`, `python copy: ${r.labels.python}`, `ts shadow: ${r.labels.ts}`,
    `logic ${r.counts.logic} · timing ${r.counts.timing} · user_action ${r.counts.user_action}`,
  ];
  for (const [table, t] of Object.entries(r.tables)) if (t.python || t.ts) lines.push(`${table}: python ${t.python}, ts ${t.ts}, agree ${t.agree}`);
  return lines.join("\n");
}
