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
// (network, timeout, HTTP 429 and 5xx) are retried, after 30 and 120 seconds; a page source that failed wrote
// nothing (collectSource writes after the whole read), so a retry starts clean; a mail source writes message
// by message and records each in mail_messages, so a retry skips what was written (a failed row's counts
// then show only the attempts; what was written is in mail_messages and listings). One source failing never
// stops the others. Records carry ids, counts and statuses only, never listing text.

export const RETRY_DELAYS_MS = [30_000, 120_000] as const;
const DAY_MS = 86_400_000;
/**
 * No run starts before this Asia/Taipei hour, the timer's first trigger; a start the timer's Persistent
 * catch-up makes earlier (e.g. right after midnight) exits as not_due.
 */
export const EARLIEST_HOUR = 9;

export type DailyDeps = {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  sources?: readonly SourceSettings[];
  collect?: (db: PgDb, source: SourceSettings, now: Date) => Promise<SourceRun>;
};

export type DailyOutcome = { outcome: "not_due" | "done" | "succeeded" | "failed"; localDate: string; ran: string[]; skipped: string[] };

const transient = (e: unknown) => e instanceof FetchError && e.transient;
const errorKind = (e: unknown) => (e instanceof FetchError || e instanceof SourceError ? e.kind : "internal");
/** The stored error: a code only, never a message, which can quote a page or a failed query's listing params. */
const errorCode = (e: unknown) => (e instanceof FetchError && e.status !== null ? `http_${e.status}` : e instanceof Error ? e.name : "unknown");
const taipeiHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", hourCycle: "h23" }).format(d));

const countsOf = (r: SourceRun, attempts: number): RunCounts => ({
  seen: r.seen, examined: r.examined, rejected: r.rejected, truncated: r.truncated, stored: r.stored, jobs: r.jobs,
  requests: r.requests, attempts, ...r.intake,
});

export async function runDaily(db: PgDb, deps: DailyDeps): Promise<DailyOutcome> {
  const started = deps.now();
  const localDate = taipeiDate(started);
  if (taipeiHour(started) < EARLIEST_HOUR) return { outcome: "not_due", localDate, ran: [], skipped: [] };
  const opened = await openRun(db, localDate, started);
  if (opened.outcome === "done") return { outcome: "done", localDate, ran: [], skipped: [] };
  try {
    return await runOpened(db, deps, localDate, opened.runId, opened.done);
  } catch (e) {
    // A write failed (the database went away): finish the day as failed if it still can, so it is resumed, not left running.
    await finishRun(db, opened.runId, "failed", `internal: ${errorCode(e)}`, {}, deps.now()).catch(() => {});
    throw e;
  }
}

async function runOpened(db: PgDb, deps: DailyDeps, localDate: string, runId: number, done: Set<string>): Promise<DailyOutcome> {
  const collect = deps.collect ?? ((d, s, now) => collectSource(d, s, now));
  const enabled = [...(deps.sources ?? SOURCES)].filter((s) => !s.disabled).sort((a, b) => a.order - b.order);
  const ran: string[] = [], skipped: string[] = [];
  let allOk = true;
  for (const s of enabled) {
    if (done.has(s.name)) { skipped.push(s.name); continue; }
    ran.push(s.name);
    const sourceStarted = deps.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const run = await collect(db, s, deps.now());
        await recordSource(db, runId, { source: s.name, status: "ok", tier: s.maxTier, reason: null, error: null, counts: countsOf(run, attempt), startedAt: sourceStarted, finishedAt: deps.now() });
        break;
      } catch (e) {
        if (transient(e) && attempt <= RETRY_DELAYS_MS.length) { await deps.sleep(RETRY_DELAYS_MS[attempt - 1]!); continue; }
        allOk = false;
        await recordSource(db, runId, { source: s.name, status: "failed", tier: s.maxTier, reason: errorKind(e), error: errorCode(e), counts: { attempts: attempt }, startedAt: sourceStarted, finishedAt: deps.now() });
        break;
      }
    }
  }
  const counts: RunCounts = { pruned: null, listMs: null };
  let reason: string | null = allOk ? null : "one_or_more_sources_failed";
  try {
    const now = deps.now();
    // One window for both: the sources read within it, and the listings unseen for longer.
    const healthy = await sourcesReadSince(db, new Date(now.getTime() - RETENTION_DAYS * DAY_MS), enabled.map((s) => s.name));
    counts.pruned = await pruneListings(db, healthy, now, RETENTION_DAYS);
    const t0 = performance.now();
    await listJobs(db, now, "candidates", 1);
    counts.listMs = Math.round(performance.now() - t0);
  } catch (e) {
    reason = `after_sources_failed: ${errorCode(e)}`;
  }
  const status = reason === null ? "succeeded" : "failed";
  await finishRun(db, runId, status, reason, counts, deps.now());
  return { outcome: status, localDate, ran, skipped };
}
