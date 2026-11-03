import { getDb, usageOf } from "@/db/client";
import { addUsage, NO_USAGE, type Usage } from "@/db/usage";
import type { SourceDetail } from "@/modules/collection/public";
import { beginDailyRun, dailySources, finishDaily, syncDailySource } from "@/services/daily";
import { syncInOrder } from "./in-order";

// D2-A: one Vercel Cron trigger per slot (D5: 09:00 and 12:00 Asia/Taipei), a durable workflow, one
// step per source. Step inputs and outputs carry only dates, source ids, statuses and counts (plan invariant).
export async function dailyWorkflow() {
  "use workflow";
  const begin = await claimStep();
  if (begin.outcome !== "claimed") {
    console.log(`daily run ${begin.localDate}: ${begin.outcome === "already_run" ? "已有 run" : "not due before 09:00 Asia/Taipei"}`);
    return { ...begin, sources: {} };
  }
  const sources = await sourcesStep();
  // A step that dies (timeout, crash) never returned its detail; record it as Python's unavailable
  // source. Its D1 usage is lost with it: lost_steps marks the run's totals as a lower bound.
  const synced = await syncInOrder(sources, syncStep, { detail: { status: "failed", reason: "source_unavailable" } as SourceDetail, usage: { ...NO_USAGE, lost_steps: 1 } });
  const details = Object.fromEntries(Object.entries(synced).map(([s, r]) => [s, r.detail]));
  const usage = Object.values(synced).reduce((sum, r) => addUsage(sum, r.usage), begin.usage);
  const finished = await finishStep(begin.localDate, begin.startedAt!, details, usage);
  return { ...begin, ...finished, sources: Object.fromEntries(Object.entries(details).map(([s, d]) => [s, d.status])) };
}

// Each step gets its own client (getDb), so its counters cover only that step; the finish step adds
// them up into daily_runs.result (plan step 4e).
async function claimStep() {
  "use step";
  const db = getDb();
  const begin = await beginDailyRun(db);
  return { ...begin, usage: usageOf(db) };
}
// An interrupted claim stays `running`; product rule: no automatic retry.
claimStep.maxRetries = 0;

async function sourcesStep() {
  "use step";
  return dailySources();
}

async function syncStep(source: string): Promise<{ detail: SourceDetail; usage: Usage }> {
  "use step";
  const db = getDb();
  const detail = await syncDailySource(db, source);
  return { detail, usage: usageOf(db) };
}
syncStep.maxRetries = 0;

// Records the run's outcome (plan step 10f); like every step of the run, never retried.
export async function finishStep(localDate: string, startedAt: string, details: Record<string, SourceDetail>, usage: Usage) {
  "use step";
  return finishDaily(getDb(), localDate, startedAt, details, usage);
}
finishStep.maxRetries = 0;
