import type { Db } from "@/db/client";
import { detailDict, enabledSources, FAILURE_REASON, runSource, RUNNERS, succeeded, type SourceDetail, type SourceRunner } from "@/modules/collection/public";
import { claimDailyRun, dailyRecipient, findDigest, finishDailyRun, render, taipeiLocal } from "@/modules/notifications/public";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { asDict, asList, pyGet, PyDict, type PyValue } from "@/platform/py/value";
import { createDigest } from "./digest";

// The daily run of notifications/daily.py:run_daily, minus delivery (plan step 10c). Each function
// is one workflow step: inputs and outputs carry only dates, source ids, statuses and counts; the
// recipient is read from the environment inside the step. As in Python, the claim time is the run's
// `now` for the digest (generated_at, freshness); finished_at is the actual finish time, unlike
// Python's single `now` (both columns are volatile for the comparator; the ops page shows duration).

export type BeginOutcome = { outcome: "claimed" | "already_run" | "not_due"; localDate: string; startedAt?: string; reused?: boolean };

export async function beginDailyRun(db: Db, now = PyDateTime.now()): Promise<BeginOutcome> {
  const local = taipeiLocal(now);
  if (local.hour < 9) return { outcome: "not_due", localDate: local.date };
  const recipient = dailyRecipient();
  if (!(await claimDailyRun(db, local.date, recipient, now))) return { outcome: "already_run", localDate: local.date };
  // run_daily's reuse: a digest for the day without a daily_runs row (in TS only after the row was
  // removed by hand, or a copy that holds the digest but not the run). A crash between digest and
  // finish leaves the row `running`, so that day returns already_run above and never gets here.
  const reused = (await findDigest(db, local.date, recipient)) !== null;
  return { outcome: "claimed", localDate: local.date, startedAt: now.isoformat(), reused };
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
 * run_daily after the sources: build (or reuse) the day's digest, check that it renders, and finish
 * the claimed run. `details` is null when the claim found an existing digest. Any failure finishes
 * the run as daily_processing_failed, never leaving it running.
 */
export async function finishDaily(db: Db, localDate: string, startedAt: string, details: Record<string, SourceDetail> | null): Promise<"complete" | "failed"> {
  const now = fromisoformat(startedAt), recipient = dailyRecipient();
  let status: "complete" | "failed", result: PyDict;
  try {
    const reused = details === null;
    const existing = reused ? await findDigest(db, localDate, recipient) : null;
    if (reused && !existing) throw new Error("claimed digest disappeared");
    const source = existing
      ? PyDict.of({ status: pyGet(existing.snapshot.dict("sources"), "tasker", "not_connected") })
      : sourceDetails(details!);
    const intent = existing ?? await createDigest(db, localDate, recipient, now);
    const snapshot = intent.snapshot;
    // Python writes this HTML to a preview file and fails the run when it cannot; TS keeps only the
    // failure (a list `kind` passes intake but not render). Replaced by building the delivery
    // message itself once step 10c wires delivery into this function.
    render(asList(snapshot.req("items")).map(asDict), snapshot.dict("sources"), { mode: "sqlite", counts: snapshot });
    result = new PyDict([
      ["status", reused ? "existing_digest" : source.at("status") === "ok" ? "digest_ready" : "source_failed"],
      ["local_date", localDate], ["intent_id", intent.id],
      ["source_status", source.req("status")], ["source_reason", source.at("reason")], ["source_details", source],
      ["candidates", BigInt(asList(snapshot.req("items")).length)], ["delivery_status", intent.status],
    ] as [string, PyValue][]);
    status = reused || source.at("status") === "ok" ? "complete" : "failed";
  } catch {
    status = "failed";
    result = PyDict.of({ status: "failed", local_date: localDate, reason: "daily_processing_failed" });
  }
  await finishDailyRun(db, localDate, recipient, status, result, PyDateTime.now());
  return status;
}
