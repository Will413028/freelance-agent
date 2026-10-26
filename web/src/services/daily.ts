import type { Db } from "@/db/client";
import { detailDict, enabledSources, FAILURE_REASON, runSource, RUNNERS, succeeded, type SourceDetail, type SourceRunner } from "@/modules/collection/public";
import { buildMessage, claimDailyRun, dailyRecipient, deliver, findDigest, finishDailyRun, gmailOpener, messageSha256, smtpPassword, taipeiLocal, type SmtpOpener } from "@/modules/notifications/public";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { asList, pyGet, PyDict, type PyValue } from "@/platform/py/value";
import { createDigest } from "./digest";

// The daily run of notifications/daily.py:run_daily, delivery included (plan step 10c). Each function
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

export type DeliveryOutcome = "not_configured" | "pending" | "attempted" | "sent" | "unknown" | "existing_snapshot_requires_review" | "send_preflight_failed";

const configuredOpener = (): SmtpOpener | null => {
  const password = smtpPassword();
  return password === null ? null : gmailOpener(password);
};

/**
 * run_daily after the sources: build (or reuse) the day's digest and its message, send it when
 * delivery is configured, and finish the claimed run. `details` is null when the claim found an
 * existing digest. Any failure finishes the run as daily_processing_failed, never leaving it running;
 * a process that dies after the claim leaves the run running and the digest attempted, for a person
 * to reconcile (no automatic retry: the workflow step has maxRetries 0).
 */
export async function finishDaily(db: Db, localDate: string, startedAt: string, details: Record<string, SourceDetail> | null,
  open: SmtpOpener | null = configuredOpener()): Promise<{ status: "complete" | "failed"; delivery: DeliveryOutcome }> {
  const now = fromisoformat(startedAt), recipient = dailyRecipient();
  let status: "complete" | "failed", result: PyDict, delivery: DeliveryOutcome = open ? "pending" : "not_configured";
  try {
    const reused = details === null;
    const existing = reused ? await findDigest(db, localDate, recipient) : null;
    if (reused && !existing) throw new Error("claimed digest disappeared");
    const source = existing
      ? PyDict.of({ status: pyGet(existing.snapshot.dict("sources"), "tasker", "not_connected") })
      : sourceDetails(details!);
    const intent = existing ?? await createDigest(db, localDate, recipient, now);
    const snapshot = intent.snapshot;
    // Built even when not sending: Python fails the run when the preview cannot render (a list
    // `kind` passes intake but not render), and the message contains that render.
    const raw = buildMessage(snapshot, intent.id, recipient);
    result = new PyDict([
      ["status", reused ? "existing_digest" : source.at("status") === "ok" ? "digest_ready" : "source_failed"],
      ["local_date", localDate], ["intent_id", intent.id],
      ["source_status", source.req("status")], ["source_reason", source.at("reason")], ["source_details", source],
      ["candidates", BigInt(asList(snapshot.req("items")).length)], ["delivery_status", intent.status],
    ] as [string, PyValue][]);
    status = reused || source.at("status") === "ok" ? "complete" : "failed";
    if (open) {
      if (reused) {
        // A reused snapshot was built by an earlier, interrupted run; a person decides whether to send it.
        delivery = "existing_snapshot_requires_review";
        result.set("delivery_error", delivery);
        status = "failed";
      } else {
        try {
          const delivered = await deliver(db, intent.id, recipient, messageSha256(raw), open);
          delivery = delivered.status as DeliveryOutcome;
          result.set("delivery_status", delivered.status);
          if (delivered.status !== "sent") status = "failed";
        } catch {
          delivery = "send_preflight_failed";
          result.set("delivery_error", delivery);
          status = "failed";
        }
      }
    }
  } catch {
    status = "failed";
    result = PyDict.of({ status: "failed", local_date: localDate, reason: "daily_processing_failed" });
  }
  await finishDailyRun(db, localDate, recipient, status, result, PyDateTime.now());
  return { status, delivery };
}
