import { and, asc, eq } from "drizzle-orm";
import { writeTransaction, type Db, type Executor } from "@/db/client";
import { mailContentVersions, opportunities, sourceHealth, sourceReceipts, utcNowText, type SourceStatus } from "@/db/schema";
import { evaluate, readSettings } from "@/modules/discovery/public";
import { getRecord, insertRecord, newObservation, recordsForSource, refreshRecord, saveRecord } from "@/modules/legacy/public";
import { Conflict } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { asDict, PyDict, PyError, type PyValue } from "@/platform/py/value";
import { olderNotification } from "./observation";
import { isSource, SOURCES } from "./source-catalog";

// Port of collection/store.py (intake, receipts and source health). Mail cursors, ingestion records
// and versioned mail intake arrive with the mail sources (plan step 9).

const STATUSES: readonly SourceStatus[] = ["not_connected", "ok", "failed", "waiting"];
const FINGERPRINT_EXCLUDED = new Set(["received_at", "receipt_id", "evidence_ref", "raw_evidence_ref"]);

export const opportunityId = (source: string, externalId: string) => identityHash([source, externalId]);
export const jobFingerprint = (job: PyDict) => identityHash(new PyDict([...job].filter(([k]) => !FINGERPRINT_EXCLUDED.has(k))));

async function receiptOwner(tx: Executor, source: string, receiptId: string): Promise<string | null> {
  const [row] = await tx.select({ id: sourceReceipts.opportunityId }).from(sourceReceipts)
    .where(and(eq(sourceReceipts.source, source), eq(sourceReceipts.receiptId, receiptId)));
  return row?.id ?? null;
}

/**
 * receipt_id identifies ONE normalized listing occurrence. For multi-listing notifications use
 * message_id + listing identity; keep the raw message reference in job.evidence_ref.
 */
export async function ingestIn(tx: Executor, jobValue: PyValue, receiptId: PyValue, now: PyDateTime): Promise<PyDict> {
  const job = asDict(jobValue);
  const source = job.at("source"), externalId = job.at("external_id");
  if (typeof source !== "string" || !source || typeof externalId !== "string" || !externalId) {
    throw new PyError("ValueError", "source and external_id must be nonempty strings");
  }
  const key = opportunityId(source, externalId);
  const fingerprint = jobFingerprint(job);
  if (receiptId !== null && (typeof receiptId !== "string" || !receiptId)) throw new PyError("ValueError", "receipt_id must be a nonempty string");
  const old = await getRecord(tx, key);
  if (receiptId !== null) {
    const owner = await receiptOwner(tx, source, receiptId);
    if (owner !== null) {
      if (owner !== key) throw new Conflict("Receipt already belongs to another opportunity");
      return refreshRecord(tx, old!, now);
    }
  }
  let item: PyDict;
  if (old && olderNotification(job, old.dict("job"))) item = await refreshRecord(tx, old, now);
  else if (old && old.req("fingerprint") === fingerprint) {
    item = old;
    item.set("job", job);
    await refreshRecord(tx, item, now);
  } else {
    const evaluation = evaluate(job, (await readSettings(tx)).settings, now);
    item = newObservation(key, job, fingerprint, evaluation, old);
    if (!old) await insertRecord(tx, item);
    await saveRecord(tx, item);
  }
  if (receiptId !== null) {
    await tx.insert(sourceReceipts).values({ source, receiptId, opportunityId: key }).onConflictDoNothing();
    if ((await receiptOwner(tx, source, receiptId)) !== key) throw new Conflict("Receipt already belongs to another opportunity");
  }
  return item;
}

export const ingest = (db: Db, job: PyValue, receiptId: PyValue, now: PyDateTime) =>
  writeTransaction(db, (tx) => ingestIn(tx, job, receiptId, now));

export async function setSourceHealthIn(tx: Executor, source: PyValue, status: PyValue) {
  if (!isSource(source) || !STATUSES.includes(status as SourceStatus)) throw new PyError("ValueError", "unknown source or source status");
  await tx.insert(sourceHealth).values({ source, status: status as SourceStatus })
    .onConflictDoUpdate({ target: sourceHealth.source, set: { status: status as SourceStatus, checkedAt: utcNowText } });
}

export const setSourceHealth = (db: Db, source: PyValue, status: PyValue) =>
  writeTransaction(db, (tx) => setSourceHealthIn(tx, source, status));

/** Source-scoped data operations sharing the caller's intake transaction. */
export class SourceBatch {
  constructor(private readonly tx: Executor, readonly source: string, private readonly now: PyDateTime) {}

  existingIds(): Promise<Set<string>> {
    return existingIdsIn(this.tx, this.source);
  }

  async existingJobs(): Promise<Map<string, PyDict>> {
    const records = await recordsForSource(this.tx, this.source);
    return new Map(records.map((item) => [item.dict("job").str("external_id"), item.dict("job")]));
  }

  ingest(job: PyValue, receiptId: PyValue = null) {
    if (asDict(job).at("source") !== this.source) throw new PyError("ValueError", "Wrong intake source");
    return ingestIn(this.tx, job, receiptId, this.now);
  }

  finish(status: PyValue) {
    return setSourceHealthIn(this.tx, this.source, status);
  }
}

/** Everything fn does commits together or not at all, health included. */
export function sourceBatch<T>(db: Db, source: PyValue, now: PyDateTime, fn: (batch: SourceBatch) => Promise<T>): Promise<T> {
  if (!isSource(source)) throw new PyError("ValueError", "unknown source");
  return writeTransaction(db, (tx) => fn(new SourceBatch(tx, source, now)));
}

async function existingIdsIn(tx: Executor, source: string): Promise<Set<string>> {
  const rows = await tx.select({ id: opportunities.externalId }).from(opportunities).where(eq(opportunities.source, source));
  return new Set(rows.map((r) => r.id));
}

export async function existingSourceIds(db: Db, source: PyValue): Promise<Set<string>> {
  if (!isSource(source)) throw new PyError("ValueError", "unknown source");
  return existingIdsIn(db, source);
}

// Python reads source_health without ORDER BY (SQLite rowid order); rows outside the catalog are
// appended in source order here, which only affects display order of retired sources.
export async function sourcesIn(tx: Executor): Promise<PyDict> {
  const result = new PyDict(SOURCES.map((s) => [s, "not_connected"]));
  for (const row of await tx.select().from(sourceHealth).orderBy(asc(sourceHealth.source))) result.set(row.source, row.status);
  return result;
}

export async function sourceChecksIn(tx: Executor): Promise<PyDict> {
  const result = new PyDict(SOURCES.map((s) => [s, PyDict.of({ status: "not_connected", checked_at: null })]));
  for (const row of await tx.select().from(sourceHealth).orderBy(asc(sourceHealth.source))) {
    result.set(row.source, PyDict.of({ status: row.status, checked_at: row.checkedAt }));
  }
  return result;
}

export type ContentVersionRow = { opportunityId: string; fingerprint: string; job: string };

export async function contentVersions(tx: Executor): Promise<ContentVersionRow[]> {
  return tx.select().from(mailContentVersions).orderBy(asc(mailContentVersions.fingerprint));
}

