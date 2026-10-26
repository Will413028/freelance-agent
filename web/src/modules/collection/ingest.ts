import { and, asc, eq, sql } from "drizzle-orm";
import { read, readAll, retrying, writeTransaction, type Db } from "@/db/client";
import { mailContentVersions, mailIngestion, mailSyncState, opportunities, sourceHealth, sourceReceipts, utcNowText, type SourceStatus } from "@/db/schema";
import { evaluate, readSettings } from "@/modules/discovery/public";
import { getRecord, insertRecord, newObservation, recordsForSource, refreshRecord, saveRecord } from "@/modules/legacy/public";
import { Conflict } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, identityHash, loads } from "@/platform/py/json";
import { asDict, PyDict, PyError, pySubscript, type PyValue } from "@/platform/py/value";
import { olderNotification } from "./observation";
import { isSource, SOURCES } from "./source-catalog";

// Port of collection/store.py: intake, receipts, source health, mail cursors, mail ingestion records
// and versioned mail intake.

const STATUSES: readonly SourceStatus[] = ["not_connected", "ok", "failed", "waiting"];
const FINGERPRINT_EXCLUDED = new Set(["received_at", "receipt_id", "evidence_ref", "raw_evidence_ref"]);

export const opportunityId = (source: string, externalId: string) => identityHash([source, externalId]);
export const jobFingerprint = (job: PyDict) => identityHash(new PyDict([...job].filter(([k]) => !FINGERPRINT_EXCLUDED.has(k))));

async function receiptOwner(tx: Db, source: string, receiptId: string): Promise<string | null> {
  const [row] = await tx.select({ id: sourceReceipts.opportunityId }).from(sourceReceipts)
    .where(and(eq(sourceReceipts.source, source), eq(sourceReceipts.receiptId, receiptId)));
  return row?.id ?? null;
}

/**
 * receipt_id identifies ONE normalized listing occurrence. For multi-listing notifications use
 * message_id + listing identity; keep the raw message reference in job.evidence_ref.
 */
export async function ingestIn(tx: Db, jobValue: PyValue, receiptId: PyValue, now: PyDateTime): Promise<PyDict> {
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

/** One upsert: atomic on D1, and repeating it only moves checked_at, so a lost response is retried. */
export async function setSourceHealthIn(tx: Db, source: PyValue, status: PyValue) {
  if (!isSource(source) || !STATUSES.includes(status as SourceStatus)) throw new PyError("ValueError", "unknown source or source status");
  await tx.insert(sourceHealth).values({ source, status: status as SourceStatus })
    .onConflictDoUpdate({ target: sourceHealth.source, set: { status: status as SourceStatus, checkedAt: utcNowText } });
}

export const setSourceHealth = (db: Db, source: PyValue, status: PyValue) => retrying(() => setSourceHealthIn(db, source, status));

/** Source-scoped data operations sharing the caller's intake transaction. */
export class SourceBatch {
  constructor(private readonly tx: Db, readonly source: string, private readonly now: PyDateTime) {}

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

async function existingIdsIn(tx: Db, source: string): Promise<Set<string>> {
  const rows = await tx.select({ id: opportunities.externalId }).from(opportunities).where(eq(opportunities.source, source));
  return new Set(rows.map((r) => r.id));
}

export async function existingSourceIds(db: Db, source: PyValue): Promise<Set<string>> {
  if (!isSource(source)) throw new PyError("ValueError", "unknown source");
  return retrying(() => existingIdsIn(db, source));
}

// Python reads source_health without ORDER BY (SQLite rowid order); rows outside the catalog are
// appended in source order here, which only affects display order of retired sources.
export const sourcesRead = (db: Db) => read(db.select().from(sourceHealth).orderBy(asc(sourceHealth.source)), (rows) => {
  const result = new PyDict(SOURCES.map((s) => [s, "not_connected"]));
  for (const row of rows) result.set(row.source, row.status);
  return result;
});

export async function sourceStatuses(db: Db): Promise<PyDict> {
  return (await readAll(db, [sourcesRead(db)]))[0];
}

export async function sourceChecks(db: Db): Promise<PyDict> {
  const result = new PyDict(SOURCES.map((s) => [s, PyDict.of({ status: "not_connected", checked_at: null })]));
  for (const row of await retrying(() => db.select().from(sourceHealth).orderBy(asc(sourceHealth.source)))) {
    result.set(row.source, PyDict.of({ status: row.status, checked_at: row.checkedAt }));
  }
  return result;
}

export type ContentVersionRow = { opportunityId: string; fingerprint: string; job: string };

export const contentVersionsRead = (db: Db) =>
  read(db.select().from(mailContentVersions).orderBy(asc(mailContentVersions.fingerprint)), (rows): ContentVersionRow[] => rows);


/**
 * Keep distinct forwarded observations without choosing a newer source version
 * (Collection.ingest_resend_batch): one transaction for the whole message.
 */
export function ingestResendBatch(db: Db, jobs: PyValue[], now: PyDateTime): Promise<{ contentVersions: number }> {
  return writeTransaction(db, async (tx) => {
    let newVersions = 0;
    for (const jobValue of jobs) {
      const job = asDict(jobValue);
      const source = pySubscript(job, "source"), receiptId = pySubscript(job, "receipt_id");
      const key = identityHash([source, pySubscript(job, "external_id")]);
      const record = await getRecord(tx, key);
      const fingerprint = jobFingerprint(job);
      let incoming = job;
      if (record !== null) {
        if (fingerprint !== record.req("fingerprint")) {
          const owner = await receiptOwner(tx, source as string, receiptId as string);
          if (owner !== null && owner !== key) throw new Conflict("Receipt already belongs to another opportunity");
          const [known] = await tx.select({ one: sql`1` }).from(mailContentVersions)
            .where(and(eq(mailContentVersions.opportunityId, key), eq(mailContentVersions.fingerprint, fingerprint)));
          if (owner !== null && !known) throw new Conflict("Receipt reused with different content");
          await tx.insert(mailContentVersions).values({ opportunityId: key, fingerprint: record.str("fingerprint"), job: encode(record.dict("job")) })
            .onConflictDoNothing();
          const inserted = await tx.insert(mailContentVersions).values({ opportunityId: key, fingerprint, job: encode(job) })
            .onConflictDoNothing().returning({ key: mailContentVersions.opportunityId });
          newVersions += inserted.length;
          await tx.insert(sourceReceipts).values({ source: source as string, receiptId: receiptId as string, opportunityId: key }).onConflictDoNothing();
          continue;
        }
        incoming = record.dict("job");
      }
      await ingestIn(tx, incoming, receiptId, now);
    }
    return { contentVersions: newVersions };
  });
}

export type MailRecord = { status: string; reason: string | null; retryPending?: boolean };

export async function mailState(db: Db, source: string, recipient: string): Promise<PyDict> {
  const [row] = await retrying(() => db.select({ state: mailSyncState.state }).from(mailSyncState)
    .where(and(eq(mailSyncState.source, source), eq(mailSyncState.recipient, recipient))));
  return row ? asDict(loads(row.state)) : PyDict.of({ cursor: null, after: null, head: null });
}

/** One upsert of the same value: safe to repeat after a lost response. */
export async function saveMailState(db: Db, source: string, recipient: string, state: PyDict) {
  await retrying(() => db.insert(mailSyncState).values({ source, recipient, state: encode(state) })
    .onConflictDoUpdate({ target: [mailSyncState.source, mailSyncState.recipient], set: { state: encode(state) } }));
}

/** Python iterates these rows in the primary-key index order SQLite reads them in (measured). */
export async function mailRecords(db: Db, source: string, recipient: string): Promise<Map<string, MailRecord>> {
  const rows = await retrying(() => db.select().from(mailIngestion)
    .where(and(eq(mailIngestion.source, source), eq(mailIngestion.recipient, recipient))).orderBy(asc(mailIngestion.messageId)));
  return new Map(rows.map((r) => [r.messageId, { status: r.status, reason: r.reason, retryPending: r.retryPending === 1 }]));
}

/**
 * A new message is recorded once; only an explicit retry (retry_pending=1) may overwrite it, and the
 * overwrite clears the flag, so repeating the statement after a lost response changes nothing.
 */
export async function recordMail(db: Db, source: string, recipient: string, messageId: string, status: string, reason: string | null = null) {
  await retrying(() => db.insert(mailIngestion).values({ source, recipient, messageId, status, reason })
    .onConflictDoUpdate({
      target: [mailIngestion.source, mailIngestion.recipient, mailIngestion.messageId],
      set: { status, reason, retryPending: 0, checkedAt: utcNowText },
      setWhere: eq(mailIngestion.retryPending, 1),
    }));
}
