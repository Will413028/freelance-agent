import type { PgDb } from "@/db/pg/client";
import { pruneListings, RETENTION_DAYS } from "@/modules/listings/public";
import { finishRun, openRun, recordSource, sourcesReadSince, taipeiDate, type RunCounts } from "@/modules/runs/public";
import { SOURCES, SourceError, type SourceSettings } from "@/modules/sources/public";
import { FetchError } from "@/platform/fetch";
import { collectSource, type SourceRun } from "./collect";
import { listJobs } from "./pages";

// The daily run of the new system (plan step 6): claim the Asia/Taipei day, run each enabled source in
// catalog order, record each in run_sources, prune, time the list page, finish. A rerun the same day skips
// the sources already `ok` and does the rest; a succeeded day is not run again. Only transient read errors
// (network, timeout, HTTP 429 and 5xx) are retried, after 30 and 120 seconds; a read that failed wrote
// nothing (collectSource writes after the whole read), so a retry starts clean. One source failing never
// stops the others. Records carry ids, counts and statuses only, never listing text.

export const RETRY_DELAYS_MS = [30_000, 120_000] as const;
const DAY_MS = 86_400_000;
const ERROR_CHARS = 300;

export type DailyDeps = {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  sources?: readonly SourceSettings[];
  collect?: (db: PgDb, source: SourceSettings, now: Date) => Promise<SourceRun>;
};

export type DailyOutcome = { outcome: "done" | "succeeded" | "failed"; localDate: string; ran: string[]; skipped: string[] };

const transient = (e: unknown) => e instanceof FetchError && e.transient;
const errorKind = (e: unknown) => (e instanceof FetchError || e instanceof SourceError ? e.kind : "internal");
const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, ERROR_CHARS);

const countsOf = (r: SourceRun, attempts: number): RunCounts => ({
  seen: r.seen, examined: r.examined, rejected: r.rejected, truncated: r.truncated, stored: r.stored, jobs: r.jobs,
  requests: r.requests, attempts, ...r.intake,
});

export async function runDaily(db: PgDb, deps: DailyDeps): Promise<DailyOutcome> {
  const started = deps.now();
  const localDate = taipeiDate(started);
  const opened = await openRun(db, localDate, started);
  if (opened.outcome === "done") return { outcome: "done", localDate, ran: [], skipped: [] };
  const collect = deps.collect ?? ((d, s, now) => collectSource(d, s, now));
  const enabled = [...(deps.sources ?? SOURCES)].filter((s) => !s.disabled).sort((a, b) => a.order - b.order);
  const ran: string[] = [], skipped: string[] = [];
  let allOk = true;
  for (const s of enabled) {
    if (opened.done.has(s.name)) { skipped.push(s.name); continue; }
    ran.push(s.name);
    const sourceStarted = deps.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const run = await collect(db, s, deps.now());
        await recordSource(db, opened.runId, { source: s.name, status: "ok", reason: null, error: null, counts: countsOf(run, attempt), startedAt: sourceStarted, finishedAt: deps.now() });
        break;
      } catch (e) {
        if (transient(e) && attempt <= RETRY_DELAYS_MS.length) { await deps.sleep(RETRY_DELAYS_MS[attempt - 1]!); continue; }
        allOk = false;
        await recordSource(db, opened.runId, { source: s.name, status: "failed", reason: errorKind(e), error: message(e), counts: { attempts: attempt }, startedAt: sourceStarted, finishedAt: deps.now() });
        break;
      }
    }
  }
  const counts: RunCounts = { pruned: null, listMs: null };
  let reason: string | null = allOk ? null : "one_or_more_sources_failed";
  try {
    const now = deps.now();
    const healthy = await sourcesReadSince(db, new Date(now.getTime() - RETENTION_DAYS * DAY_MS), enabled.map((s) => s.name));
    counts.pruned = await pruneListings(db, healthy, now);
    const t0 = performance.now();
    await listJobs(db, now, "candidates", 1);
    counts.listMs = Math.round(performance.now() - t0);
  } catch (e) {
    reason = `after_sources_failed: ${message(e)}`;
  }
  const status = reason === null ? "succeeded" : "failed";
  await finishRun(db, opened.runId, status, reason, counts, deps.now());
  return { outcome: status, localDate, ran, skipped };
}
