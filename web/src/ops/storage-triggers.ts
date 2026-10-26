import { asc, gte } from "drizzle-orm";
import { readAll, read, type Db } from "@/db/client";
import { dailyRuns } from "@/db/schema";
import { loadsDict } from "@/platform/py/json";
import { PyDict, type PyValue } from "@/platform/py/value";

// The revocation triggers of D20 (writer lease → per-aggregate optimistic concurrency) and D21
// (REST → a data-access Worker), checked on every finished daily run (Will 2026-10-26: a single run
// is enough, no 7-day window). Each run's usage sits at the top of daily_runs.result (plan step 4e).
// Runs without it (rows copied from the Python writer) are skipped.

/** Over this many milliseconds of lease waiting in one run (D20). */
export const LEASE_WAIT_LIMIT_MS = 2_000;
/** Over this many D1 requests in one run, a conservative bound for the 1,200 per 5 minutes (D21). */
export const REQUEST_LIMIT = 600;

export type StorageSignal = {
  localDate: string;
  /** Which decision it reopens: D20 for the lease, D21 for the access path; "totals" only qualifies the run's numbers. */
  decision: "D20" | "D21" | "totals";
  signal: "lease_wait_over_limit" | "lease_timeout" | "lease_lost" | "rate_limited" | "requests_over_limit" | "lost_steps";
  value: number;
};

const count = (v: PyValue | undefined) => (typeof v === "bigint" ? Number(v) : 0);

/** The signals in one run's result; empty when nothing tripped or the run recorded no usage. */
export function runSignals(localDate: string, result: string | null): StorageSignal[] {
  if (result === null) return [];
  const r = loadsDict(result);
  if (!r.has("d1_requests")) return [];
  const errors = r.get("d1_errors");
  const out: StorageSignal[] = [];
  const add = (decision: StorageSignal["decision"], signal: StorageSignal["signal"], value: number, tripped: boolean) => {
    if (tripped) out.push({ localDate, decision, signal, value });
  };
  const wait = count(r.get("lease_wait_ms")), timeouts = count(r.get("lease_timeouts")), lost = count(r.get("lease_lost"));
  const limited = errors instanceof PyDict ? count(errors.get("rate_limited")) : 0, requests = count(r.get("d1_requests"));
  add("D20", "lease_wait_over_limit", wait, wait > LEASE_WAIT_LIMIT_MS);
  add("D20", "lease_timeout", timeouts, timeouts > 0);
  add("D20", "lease_lost", lost, lost > 0);
  add("D21", "rate_limited", limited, limited > 0);
  add("D21", "requests_over_limit", requests, requests > REQUEST_LIMIT);
  add("totals", "lost_steps", count(r.get("lost_steps")), count(r.get("lost_steps")) > 0);
  return out;
}

/** Signals of every daily run from `since` (a local date) on, in date order; one read request. */
export async function storageSignals(db: Db, since: string): Promise<{ runs: number; signals: StorageSignal[] }> {
  const [rows] = await readAll(db, [read(db.select({ localDate: dailyRuns.localDate, result: dailyRuns.result }).from(dailyRuns)
    .where(gte(dailyRuns.localDate, since)).orderBy(asc(dailyRuns.localDate)), (r) => r)]);
  return { runs: rows.length, signals: rows.flatMap((row) => runSignals(row.localDate, row.result)) };
}
