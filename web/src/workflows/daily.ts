import { getDb } from "@/db/client";
import { beginDailyRun, dailySources, finishDailySources, syncDailySource } from "@/services/daily";
import { syncInOrder } from "./in-order";

// D2-A: one Vercel Cron trigger per slot (D5: 09:00 and 12:00 Asia/Taipei), a durable workflow, one
// step per source. Step inputs and outputs carry only dates, source ids and statuses (plan invariant).
export async function dailyWorkflow() {
  "use workflow";
  const begin = await claimStep();
  if (begin.outcome !== "claimed") {
    console.log(`daily run ${begin.localDate}: ${begin.outcome === "already_run" ? "已有 run" : "not due before 09:00 Asia/Taipei"}`);
    return { ...begin, sources: {} };
  }
  const sources = await sourcesStep();
  const statuses = await syncInOrder(sources, syncStep);
  const status = await finishStep(begin.localDate, statuses);
  return { ...begin, status, sources: statuses };
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

async function finishStep(localDate: string, statuses: Record<string, string>) {
  "use step";
  return finishDailySources(getDb(), localDate, statuses);
}
finishStep.maxRetries = 0;
