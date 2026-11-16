import { and, desc, eq, gte, inArray, lt, max } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { runs, runSources } from "@/db/pg/schema";
import type { Tier } from "@/platform/fetch";

// The daily run's records (plan step 6): one `runs` row per Asia/Taipei day, one `run_sources` row per source
// per run. A day whose run did not succeed is reopened by the next start and resumed: sources already `ok`
// are skipped. The caller guarantees one run at a time (scripts/daily.ts holds an advisory lock); these
// functions only record.

export type RunStatus = "running" | "succeeded" | "failed";
export type SourceStatus = "ok" | "waiting" | "failed";
export type RunCounts = Record<string, number | boolean | null>;

/** The Asia/Taipei calendar date of `now`, YYYY-MM-DD. */
export function taipeiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type Opened = { outcome: "done"; runId: number } | { outcome: "started" | "resumed"; runId: number; done: Set<string> };

/** Claims the day, or reopens it when its run did not succeed; a succeeded day is not run again. */
export async function openRun(db: PgDb, localDate: string, now: Date): Promise<Opened> {
  // An earlier day still `running` was killed and its day has passed: nothing will resume it.
  await db.update(runs).set({ status: "failed", reason: "interrupted", finishedAt: now }).where(and(eq(runs.status, "running"), lt(runs.localDate, localDate)));
  const [inserted] = await db.insert(runs).values({ localDate, status: "running", startedAt: now })
    .onConflictDoNothing({ target: runs.localDate }).returning({ id: runs.id });
  if (inserted) return { outcome: "started", runId: inserted.id, done: new Set() };
  const [row] = await db.select({ id: runs.id, status: runs.status }).from(runs).where(eq(runs.localDate, localDate));
  if (row!.status === "succeeded") return { outcome: "done", runId: row!.id };
  await db.update(runs).set({ status: "running", reason: null, finishedAt: null }).where(eq(runs.id, row!.id));
  const ok = await db.select({ source: runSources.source }).from(runSources).where(and(eq(runSources.runId, row!.id), eq(runSources.status, "ok")));
  return { outcome: "resumed", runId: row!.id, done: new Set(ok.map((r) => r.source)) };
}

/** `tier`: the tier the source read with (plan step 8c; every request of a source uses its highest tier). */
export type SourceRecord = { source: string; status: SourceStatus; tier: Tier; reason: string | null; error: string | null; counts: RunCounts; startedAt: Date; finishedAt: Date };

/** Writes a source's outcome for the run, replacing an earlier attempt's row from the same day. */
export async function recordSource(db: PgDb, runId: number, r: SourceRecord): Promise<void> {
  const values = { status: r.status, tier: r.tier, reason: r.reason, error: r.error, counts: r.counts, startedAt: r.startedAt, finishedAt: r.finishedAt };
  await db.insert(runSources).values({ runId, source: r.source, ...values })
    .onConflictDoUpdate({ target: [runSources.runId, runSources.source], set: values });
}

export async function finishRun(db: PgDb, runId: number, status: Exclude<RunStatus, "running">, reason: string | null, counts: RunCounts, now: Date): Promise<void> {
  await db.update(runs).set({ status, reason, counts, finishedAt: now }).where(eq(runs.id, runId));
}

/** The sources with an `ok` row finished at or after `since`: the ones retention may prune. */
export async function sourcesReadSince(db: PgDb, since: Date, sources: readonly string[]): Promise<string[]> {
  if (sources.length === 0) return [];
  const rows = await db.selectDistinct({ source: runSources.source }).from(runSources)
    .where(and(eq(runSources.status, "ok"), gte(runSources.finishedAt, since), inArray(runSources.source, [...sources])));
  return rows.map((r) => r.source).sort();
}

export type RunRow = { localDate: string; status: RunStatus; reason: string | null; counts: RunCounts; startedAt: Date; finishedAt: Date | null };
export type LatestSource = Omit<SourceRecord, "finishedAt" | "error" | "tier"> & { localDate: string; finishedAt: Date | null };

/** The latest run, and each source's latest row across runs (a source skipped as done keeps an earlier row). */
export async function latestRuns(db: PgDb): Promise<{ run: RunRow | null; sources: LatestSource[] }> {
  const [run] = await db.select({ localDate: runs.localDate, status: runs.status, reason: runs.reason, counts: runs.counts, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
    .from(runs).orderBy(desc(runs.localDate)).limit(1);
  const rows = await db.selectDistinctOn([runSources.source], {
    source: runSources.source, status: runSources.status, reason: runSources.reason, counts: runSources.counts,
    startedAt: runSources.startedAt, finishedAt: runSources.finishedAt, localDate: runs.localDate,
  }).from(runSources).innerJoin(runs, eq(runs.id, runSources.runId)).orderBy(runSources.source, desc(runs.localDate));
  return {
    run: run ? { ...run, counts: run.counts as RunCounts } : null,
    sources: rows.map((r) => ({ ...r, counts: r.counts as RunCounts })),
  };
}


/**
 * When a source last finished `ok`, or null when none has (plan step 6b). Not the run's status: one failing
 * source marks the whole run `failed` while the schedule is fine, and the notice asks "has the schedule stopped".
 */
export async function lastSourceOkAt(db: PgDb): Promise<Date | null> {
  const [row] = await db.select({ at: max(runSources.finishedAt) }).from(runSources).where(eq(runSources.status, "ok"));
  return row?.at ?? null;
}
