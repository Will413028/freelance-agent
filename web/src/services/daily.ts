import type { Db } from "@/db/client";
import { detailDict, enabledSources, FAILURE_REASON, runSource, RUNNERS, succeeded, type SourceDetail, type SourceRunner } from "@/modules/collection/public";
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

export async function syncDailySource(db: Db, source: string, runners: Record<string, SourceRunner> = RUNNERS): Promise<SourceDetail> {
  const runner = runners[source];
  return runner ? runSource(db, source, runner, FAILURE_REASON[source]) : { status: "failed", reason: "source_unavailable" };
}

/** collection/service.py's collect_sources result: top-level status and reason, then one dict per source. */
export function sourceDetails(details: Record<string, SourceDetail>): PyDict {
  const ok = Object.values(details).every(succeeded);
  return new PyDict([["status", ok ? "ok" : "failed"], ["reason", ok ? null : "one_or_more_sources_failed"],
    ...Object.entries(details).map(([s, d]) => [s, detailDict(d)] as [string, PyDict])]);
}

export async function finishDailySources(db: Db, localDate: string, details: Record<string, SourceDetail>, now = PyDateTime.now()) {
  const ok = Object.values(details).every(succeeded);
  const result = PyDict.of({ status: ok ? "sources_ok" : "source_failed", local_date: localDate, source_details: sourceDetails(details), delivery_status: "not_configured" });
  await finishDailyRun(db, localDate, dailyRecipient(), ok ? "complete" : "failed", result, now);
  return ok ? "complete" : "failed";
}
