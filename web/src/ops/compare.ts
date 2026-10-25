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
//
// Scope: while TS runs only some sources (plan steps 6–10), rows of a table with a source column
// count only for the sources TS runs, and run tables without one (daily_runs, digest_outbox) are
// left out until TS owns them. What is left out is still counted in outOfScope, never dropped silently.
// The scope is read from the TS run itself (ranSources), not from the comparator's own build, so a
// Vercel deploy that changes the fan-out needs no new comparator image.

export type DiffClass = "timing" | "user_action" | "logic";
export type Diff = { table: string; key: string; class: DiffClass; kind: "only_python" | "only_ts" | "different" | "deleted" };
export type CompareReport = {
  labels: { start: string; python: string; ts: string };
  /** Sources compared; null compares every row. */
  scope: string[] | null;
  counts: Record<DiffClass, number>;
  tables: Record<string, { python: number; ts: number; agree: number }>;
  /** Rows either side added, changed or deleted that the scope leaves out, per table. */
  outOfScope: Record<string, number>;
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

/** Splits rows into those the scope compares and those it leaves out. */
function scoped(spec: TableSpec, columns: Column[], scope: Set<string> | null) {
  const at = columns.findIndex((c) => c.name === "source");
  if (!scope) return (_row: Row) => true;
  if (at < 0) return () => spec.owner !== "run";
  return (row: Row) => {
    const cell = row[at];
    return cell !== null && "s" in cell && scope.has(cell.s);
  };
}

/**
 * The sources the day's TS run fanned out to: the keys of its finished daily_runs result
 * (finishDailySources writes one per source, failed ones included). Fails closed when the day has
 * no single finished run, e.g. Hobby cron fired late and the run is still going at compare time.
 */
export async function ranSources(ts: Pool, localDate: string): Promise<string[]> {
  const { rows } = await ts.query<{ status: string; result: string | null }>("select status, result from daily_runs where local_date = $1", [localDate]);
  if (rows.length !== 1) throw new Error(`daily_runs ${localDate}: expected one TS run, found ${rows.length}`);
  const [{ status, result }] = rows;
  if (status !== "complete" && status !== "failed") throw new Error(`daily_runs ${localDate}: TS run is ${status}, not finished`);
  const details = result === null ? undefined : JSON.parse(result).source_details;
  const sources = details && typeof details === "object" && !Array.isArray(details) ? Object.keys(details) : [];
  if (!sources.length) throw new Error(`daily_runs ${localDate}: TS run recorded no sources`);
  return sources;
}

export async function compareShadow(paths: { start: string; python: string }, ts: Pool, labels: CompareReport["labels"], scope: string[] | null = null): Promise<CompareReport> {
  const start = openSqlite(paths.start), python = openSqlite(paths.python);
  const inScope = scope && new Set(scope);
  const report: CompareReport = { labels, scope, counts: { timing: 0, user_action: 0, logic: 0 }, tables: {}, outOfScope: {}, diffs: [] };
  try {
    for (const spec of TABLES) {
      const columns = await pgColumns(ts, spec.name);
      const keep = scoped(spec, columns, inScope);
      const sides = [readSqliteRows(start, spec, columns), readSqliteRows(python, spec, columns), await readPgRows(ts, spec, columns)];
      const part = (want: boolean) => sides.map((rows) => index(spec, columns, rows.filter((r) => keep(r) === want)));
      const [base, pyAll, tsAll] = part(true);
      const py = increment(base, pyAll), tsInc = increment(base, tsAll);
      const [outBase, outPy, outTs] = part(false);
      const left = [increment(outBase, outPy), increment(outBase, outTs)].reduce((n, x) => n + x.changed.size + x.deleted.length, 0);
      if (left) report.outOfScope[spec.name] = left;
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
    `scope: ${r.scope ? r.scope.join(", ") : "all sources"}`,
    `logic ${r.counts.logic} · timing ${r.counts.timing} · user_action ${r.counts.user_action}`,
  ];
  for (const [table, t] of Object.entries(r.tables)) if (t.python || t.ts) lines.push(`${table}: python ${t.python}, ts ${t.ts}, agree ${t.agree}`);
  for (const [table, n] of Object.entries(r.outOfScope)) lines.push(`${table}: ${n} out of scope`);
  return lines.join("\n");
}
