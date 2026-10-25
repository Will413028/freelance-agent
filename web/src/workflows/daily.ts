import { getDb } from "@/db/client";
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
  if (begin.reused) {
    // run_daily: a digest already built that day is reused, and no source is called again.
    return { ...begin, status: await finishStep(begin.localDate, begin.startedAt!, null), sources: {} };
  }
  const sources = await sourcesStep();
  // A step that dies (timeout, crash) never returned its detail; record it as Python's unavailable source.
  const details = await syncInOrder(sources, syncStep, { status: "failed", reason: "source_unavailable" } as SourceDetail);
  const status = await finishStep(begin.localDate, begin.startedAt!, details);
  return { ...begin, status, sources: Object.fromEntries(Object.entries(details).map(([s, d]) => [s, d.status])) };
}

async function claimStep() {
  "use step";
  return beginDailyRun(getDb());
}
// An interrupted claim stays `running`; product rule: no automatic retry.
claimStep.maxRetries = 0;

async function sourcesStep() {
  "use step";
  return dailySources();
}

async function syncStep(source: string) {
  "use step";
  return syncDailySource(getDb(), source);
}
syncStep.maxRetries = 0;

async function finishStep(localDate: string, startedAt: string, details: Record<string, SourceDetail> | null) {
  "use step";
  return finishDaily(getDb(), localDate, startedAt, details);
}
finishStep.maxRetries = 0;
