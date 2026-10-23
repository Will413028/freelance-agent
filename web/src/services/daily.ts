import type { Db } from "@/db/client";
import { enabledSources, runSource, RUNNERS, type SourceRunner } from "@/modules/collection/public";
import { claimDailyRun, dailyRecipient, finishDailyRun, taipeiLocal } from "@/modules/notifications/public";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";

// The daily run of notifications/daily.py:run_daily, minus digest and delivery (plan step 10).
// Each function is one workflow step: inputs and outputs carry only dates, source ids and statuses;
// the recipient is read from the environment inside the step.

export type BeginOutcome = { outcome: "claimed" | "already_run" | "not_due"; localDate: string };

export async function beginDailyRun(db: Db, now = PyDateTime.now()): Promise<BeginOutcome> {
  const local = taipeiLocal(now);
  if (local.hour < 9) return { outcome: "not_due", localDate: local.date };
  const claimed = await claimDailyRun(db, local.date, dailyRecipient(), now);
  return { outcome: claimed ? "claimed" : "already_run", localDate: local.date };
}

export function dailySources(): string[] {
  return enabledSources();
}

export async function syncDailySource(db: Db, source: string, runners: Record<string, SourceRunner> = RUNNERS): Promise<"ok" | "failed"> {
  const runner = runners[source];
  return runner ? runSource(db, source, runner) : "failed";
}

export async function finishDailySources(db: Db, localDate: string, statuses: Record<string, string>, now = PyDateTime.now()) {
  const ok = Object.values(statuses).every((s) => s === "ok" || s === "waiting");
  const details = new PyDict(Object.entries(statuses).map(([s, status]) => [s, PyDict.of({ status })]));
  const result = PyDict.of({ status: ok ? "sources_ok" : "source_failed", local_date: localDate, source_details: details, delivery_status: "not_configured" });
  await finishDailyRun(db, localDate, dailyRecipient(), ok ? "complete" : "failed", result, now);
  return ok ? "complete" : "failed";
}
