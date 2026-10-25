import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { Conflict } from "@/platform/errors";
import { PyDateTime } from "@/platform/py/datetime";
import { isList, pyEq, pyGet, PyDict, PyError, pySubscript, truthy, type PyValue } from "@/platform/py/value";
import { existingSourceIds, ingestResendBatch, mailRecords, mailState, recordMail, saveMailState, setSourceHealth, type MailRecord } from "../ingest";
import { matches, NotificationError, readNotification, ReceivingClient, resendId, SENDERS } from "./receiving";

// Port of collection/resend_sync.py: incremental receiving intake; quarantined messages never discard
// good mail. Message bodies stay inside this function: only counts and statuses leave it.

export type MailLimits = { maxMessages?: number; maxPages?: number; maxSeconds?: number; monotonic?: () => number; clock?: () => PyDateTime };

const RECIPIENT = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.resend\.app$/;
const isInt = (n: number) => Number.isInteger(n);

export async function syncMail(db: Db, client: ReceivingClient, recipientValue: string, source: string, limits: MailLimits = {}): Promise<PyDict> {
  const { maxMessages = 20, maxPages = 20, maxSeconds = 90, monotonic = () => performance.now() / 1000, clock = () => PyDateTime.now() } = limits;
  if (!(source in SENDERS) || typeof recipientValue !== "string" || !RECIPIENT.test(recipientValue)) throw new PyError("ValueError", "Explicit Resend recipient required");
  // str.casefold() of the ASCII the pattern admits.
  const recipient = recipientValue.toLowerCase();
  if (!isInt(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new PyError("ValueError", "Message limit must be 1–100");
  if (!isInt(maxPages) || maxPages < 1 || maxPages > 100 || !(maxSeconds > 0 && maxSeconds <= 300)) throw new PyError("ValueError", "Invalid scan limits");
  const counts = { metadata_seen: 0, body_reads: 0, messages: 0, jobs: 0, content_versions: 0, pages: 0 };
  const errors = new Map<string, number>();
  const bump = (stage: string) => errors.set(stage, (errors.get(stage) ?? 0) + 1);
  const countEntries = () => Object.entries(counts).map(([k, v]): [string, PyValue] => [k, BigInt(v)]);
  const errorStages = () => new PyDict([...errors].map(([k, v]) => [k, BigInt(v)]));
  let complete = false, interrupted = false;
  try {
    await setSourceHealth(db, source, "failed");
    let state = await mailState(db, source, recipient);
    const records: Map<string, MailRecord> = await mailRecords(db, source, recipient);
    const existing = await existingSourceIds(db, source);
    const end = monotonic() + maxSeconds;

    const process = async (messageId: string, retry = false): Promise<boolean> => {
      counts.body_reads++;
      let jobs: PyDict[];
      try {
        jobs = await readNotification(client, messageId, recipient, source, retry);
      } catch (e) {
        if (!(e instanceof NotificationError)) throw e;
        bump(e.stage);
        if (e.stage === "fetch") return false;
        await recordMail(db, source, recipient, messageId, "rejected", e.stage);
        records.set(messageId, { status: "rejected", reason: null });
        return true;
      }
      if (source === "linkedin" && !jobs.length) {
        await recordMail(db, source, recipient, messageId, "processed", "non_job_notification");
        records.set(messageId, { status: "processed", reason: "non_job_notification" });
        return true;
      }
      // qualify_for_intake reads the wall clock, not the store clock.
      const now = PyDateTime.now();
      const kept = jobs.filter((job) => existing.has(job.req("external_id") as string) || qualifyForIntake(job, now).req("status") !== "excluded");
      let outcome;
      try {
        outcome = await ingestResendBatch(db, kept, clock());
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
        await recordMail(db, source, recipient, messageId, "conflict", "receipt_collision");
        records.set(messageId, { status: "conflict", reason: null });
        bump("receipt_collision");
        return true;
      }
      await recordMail(db, source, recipient, messageId, "processed", outcome.contentVersions ? "content_changed" : null);
      records.set(messageId, { status: "processed", reason: null });
      counts.messages++;
      counts.jobs += kept.length;
      counts.content_versions += outcome.contentVersions;
      for (const job of kept) existing.add(job.req("external_id") as string);
      return true;
    };

    const visited = new Set<string>();
    while (counts.pages < maxPages && monotonic() < end && !complete && !interrupted) {
      const after = pySubscript(state, "after");
      const listing = truthy(after) ? await client.listReceived(after as string) : await client.listReceived();
      const entries = listing.get("data");
      if (!isList(entries) || entries.length > 100 || typeof listing.get("has_more") !== "boolean") throw new PyError("ValueError", "Invalid page");
      if (listing.get("has_more") && !entries.length) throw new PyError("ValueError", "Empty nonterminal page");
      counts.pages++;
      for (const entryValue of entries) {
        const entry = entryValue as PyDict;
        const messageId = resendId(pyGet(entry, "id"));
        if (pyEq(messageId, pySubscript(state, "cursor"))) {
          complete = true;
          break;
        }
        if (visited.has(messageId)) throw new PyError("ValueError", "Repeated pagination identity");
        visited.add(messageId);
        if (counts.body_reads >= maxMessages || monotonic() >= end) {
          interrupted = true;
          break;
        }
        const head = pySubscript(state, "head");
        state.set("head", truthy(head) ? head : messageId);
        counts.metadata_seen++;
        if (!records.has(messageId) && matches(entry, source) && !(await process(messageId))) {
          interrupted = true;
          break;
        }
        state.set("after", messageId);
      }
      if (interrupted) break;
      if (!listing.get("has_more")) complete = true;
    }
    if (complete) {
      const head = pySubscript(state, "head");
      state = PyDict.of({ cursor: truthy(head) ? head : pySubscript(state, "cursor"), after: null, head: null });
    }
    await saveMailState(db, source, recipient, state);
    // Recovery has its own durable IDs; an unavailable old body must not block new mail.
    for (const [messageId, record] of [...records]) {
      if (!record.retryPending) continue;
      if (counts.body_reads >= maxMessages || monotonic() >= end) break;
      await process(messageId, true);
    }
    const all = [...records.values()];
    const quarantined = all.filter((r) => r.status !== "processed").length;
    const anyProcessed = all.some((r) => r.status === "processed" && r.reason !== "non_job_notification");
    const status = !complete || quarantined ? "failed" : source !== "tasker" && !anyProcessed ? "waiting" : "ok";
    await setSourceHealth(db, source, status);
    return new PyDict([
      ["status", status],
      ["reason", status === "failed" ? "incomplete_or_unsupported_scan" : status === "waiting" ? "no_matching_notification" : null],
      ...countEntries(),
      ["truncated", !complete], ["complete_scan", complete], ["quarantined", BigInt(quarantined)],
      ["retry_pending", BigInt(all.filter((r) => r.retryPending).length)],
      ["error_count", BigInt([...errors.values()].reduce((a, b) => a + b, 0))], ["error_stages", errorStages()],
    ]);
  } catch {
    return new PyDict([
      ["status", "failed"], ["reason", "source_or_reconciliation_failed"], ...countEntries(),
      ["truncated", true], ["complete_scan", false], ["error_stages", errorStages()],
    ]);
  }
}

/**
 * The daily runner for one mail source: Resend credentials come from the environment inside the
 * step. Without them the source fails as Python's does when no receiving client exists.
 */
export async function syncMailSource(db: Db, source: string): Promise<PyDict> {
  const key = process.env.RESEND_API_KEY, inbox = process.env.RESEND_INBOX;
  if (!key || !inbox) {
    await setSourceHealth(db, source, "failed");
    return PyDict.of({ status: "failed", reason: "source_unavailable" });
  }
  return syncMail(db, new ReceivingClient(key, { sources: [source] }), inbox, source);
}
