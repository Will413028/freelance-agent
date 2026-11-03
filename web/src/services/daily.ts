import { usageOf, type Db } from "@/db/client";
import { addUsage, NO_USAGE, type Usage } from "@/db/usage";
import { detailDict, enabledSources, FAILURE_REASON, runSource, RUNNERS, succeeded, type SourceDetail, type SourceRunner } from "@/modules/collection/public";
import { claimDailyRun, dailyRecipient, finishDailyRun, taipeiLocal } from "@/modules/notifications/public";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { PyDict, type PyValue } from "@/platform/py/value";
import { crossSourceTitles } from "./discovery";

// The daily run: claim the day, run every enabled source, record the outcome (plan step 10f, D22:
// no digest and no mail since 2026-11-03). Each function is one workflow step: inputs and outputs
// carry only dates, source ids, statuses and counts. DIGEST_RECIPIENT only keys daily_runs now. The
// claim time is the run's `now` (the D18 measurement's 7 days); finished_at is the actual finish time.

export type BeginOutcome = { outcome: "claimed" | "already_run" | "not_due"; localDate: string; startedAt?: string };

export async function beginDailyRun(db: Db, now = PyDateTime.now()): Promise<BeginOutcome> {
  const local = taipeiLocal(now);
  if (local.hour < 9) return { outcome: "not_due", localDate: local.date };
  const recipient = dailyRecipient();
  if (!(await claimDailyRun(db, local.date, recipient, now))) return { outcome: "already_run", localDate: local.date };
  // A run that dies after the claim stays `running`: that day returns already_run above, for a person to reconcile.
  return { outcome: "claimed", localDate: local.date, startedAt: now.isoformat() };
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

/**
 * The daily run after its sources (plan step 10f, D22: no digest and no mail). The result keeps the
 * shape a Python rollback reads (status, local_date, source_status, source_reason, source_details:
 * backend notifications/store.py reads source_details) and adds D18's trigger measurement and the
 * run's D1 usage at the top level, never inside source_details, where every key is read as a source.
 * The run is complete when every source succeeded, failed otherwise; the step is never retried.
 */
export async function finishDaily(db: Db, localDate: string, startedAt: string, details: Record<string, SourceDetail>,
  earlier: Usage = NO_USAGE): Promise<{ status: "complete" | "failed" }> {
  const now = fromisoformat(startedAt), recipient = dailyRecipient();
  const source = sourceDetails(details);
  const ok = source.at("status") === "ok";
  const result = new PyDict([
    ["status", ok ? "collected" : "source_failed"], ["local_date", localDate],
    ["source_status", source.req("status")], ["source_reason", source.at("reason")], ["source_details", source],
  ] as [string, PyValue][]);
  // D18's trigger measurement (plan step 10e2), never part of the run's outcome. A failure is
  // recorded as null, which check-storage-triggers flags.
  try {
    const titles = await crossSourceTitles(db, now);
    result.set("cross_source_title_pairs", BigInt(titles.pairs));
    result.set("cross_source_unknown_published", BigInt(titles.unknownPublished));
  } catch (e) {
    result.set("cross_source_title_pairs", null);
    console.warn(`cross-source title measurement failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const [k, v] of Object.entries(addUsage(earlier, usageOf(db)))) {
    result.set(k, typeof v === "number" ? BigInt(v) : new PyDict(Object.entries(v).map(([kind, n]) => [kind, BigInt(n)])));
  }
  const status = ok ? "complete" : "failed";
  await finishDailyRun(db, localDate, recipient, status, result, PyDateTime.now());
  return { status };
}
