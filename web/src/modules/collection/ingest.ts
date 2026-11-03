import { and, asc, eq } from "drizzle-orm";
import { inList, read, readAll, retrying, type Db } from "@/db/client";
import { mailContentVersions, mailIngestion, mailSyncState, opportunities, sourceHealth, sourceReceipts, utcNowText, type SourceStatus } from "@/db/schema";
import { INTAKE_WRITE, writeUnit, type Writes } from "@/db/unit";
import { evaluate, putVersion, settingsRead, type Settings } from "@/modules/discovery/public";
import { newObservation, Records, recordsRead, refreshRecord } from "@/modules/legacy/public";
import { Conflict } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, identityHash, loads } from "@/platform/py/json";
import { asDict, PyDict, PyError, pySubscript, type PyValue } from "@/platform/py/value";
import { olderNotification } from "./observation";
import { isSource, SOURCES } from "./source-catalog";

// Port of collection/store.py: intake, receipts, source health, mail cursors, mail ingestion records
// and versioned mail intake. Intake runs as write units (src/db/unit.ts): everything a unit decides
// on is read with the writer lease, in one request, for the listings it was given up front.

const STATUSES: readonly SourceStatus[] = ["not_connected", "ok", "failed", "waiting"];
const FINGERPRINT_EXCLUDED = new Set(["received_at", "receipt_id", "evidence_ref", "raw_evidence_ref"]);

export const opportunityId = (source: string, externalId: string) => identityHash([source, externalId]);
export const jobFingerprint = (job: PyDict) => identityHash(new PyDict([...job].filter(([k]) => !FINGERPRINT_EXCLUDED.has(k))));

const pair = (source: string, receiptId: string) => `${source}\0${receiptId}`;

/** Owners of the receipts a unit may use, read with the lease, plus the receipts the unit adds. */
class Receipts {
  constructor(private readonly owners: Map<string, string | null>, private readonly writes: Writes) {}

  owner(source: string, receiptId: string): string | null {
    const known = this.owners.get(pair(source, receiptId));
    if (known === undefined) throw new Error(`receipt ${source}/${receiptId} was not read by this unit`);
    return known;
  }

  /** INSERT … ON CONFLICT DO NOTHING: a receipt keeps its first owner. */
  add(source: string, receiptId: string, key: string) {
    if (this.owner(source, receiptId) !== null) return;
    this.owners.set(pair(source, receiptId), key);
    this.writes.put(sourceReceipts, { kind: "nothing" }, pair(source, receiptId), { source, receiptId, opportunityId: key }, key);
  }
}

const receiptsRead = (db: Db, pairs: readonly [string, string][]) =>
  read(db.select({ source: sourceReceipts.source, receiptId: sourceReceipts.receiptId, owner: sourceReceipts.opportunityId }).from(sourceReceipts)
    .where(inList(sourceReceipts.receiptId, [...new Set(pairs.map(([, r]) => r))])), (rows) => {
    const owners = new Map<string, string | null>(pairs.map(([s, r]) => [pair(s, r), null]));
    for (const row of rows) owners.set(pair(row.source, row.receiptId), row.owner);
    return owners;
  });

/** What intake decides on: the listings' records and receipts, and the settings that evaluate them. */
type Intake = { records: Records; receipts: Receipts; settings: PyDict };

/** A listing to ingest and the receipt that identifies this occurrence of it (or null). */
export type Listing = readonly [job: PyValue, receiptId: PyValue];

/** Listings whose receipt is the job's own receipt_id, as every connector passes it. */
export const listings = (jobs: readonly PyValue[]): Listing[] => jobs.map((job) => [job, job instanceof PyDict ? job.at("receipt_id") : null]);

const listingKey = (job: PyValue): string | null => {
  if (!(job instanceof PyDict)) return null;
  const source = job.at("source"), externalId = job.at("external_id");
  return typeof source === "string" && source && typeof externalId === "string" && externalId ? opportunityId(source, externalId) : null;
};

/** The reads of an intake unit over these listings; malformed ones are left out and fail when ingested. */
function intakeReads(db: Db, items: readonly Listing[]) {
  const keys = new Set<string>(), pairs: [string, string][] = [];
  for (const [job, receiptId] of items) {
    const key = listingKey(job);
    if (key === null) continue;
    keys.add(key);
    if (typeof receiptId === "string" && receiptId) pairs.push([asDict(job).str("source"), receiptId]);
  }
  return [settingsRead(db), recordsRead(db, [...keys]), receiptsRead(db, pairs)] as const;
}

/**
 * receipt_id identifies ONE normalized listing occurrence. For multi-listing notifications use
 * message_id + listing identity; keep the raw message reference in job.evidence_ref.
 */
function ingestListing(unit: Intake, jobValue: PyValue, receiptId: PyValue, now: PyDateTime): PyDict {
  const job = asDict(jobValue);
  const source = job.at("source"), externalId = job.at("external_id");
  if (typeof source !== "string" || !source || typeof externalId !== "string" || !externalId) {
    throw new PyError("ValueError", "source and external_id must be nonempty strings");
  }
  const key = opportunityId(source, externalId);
  const fingerprint = jobFingerprint(job);
  if (receiptId !== null && (typeof receiptId !== "string" || !receiptId)) throw new PyError("ValueError", "receipt_id must be a nonempty string");
  const { records, receipts, settings } = unit;
  const old = records.get(key);
  if (receiptId !== null) {
    const owner = receipts.owner(source, receiptId);
    if (owner !== null) {
      if (owner !== key) throw new Conflict("Receipt already belongs to another opportunity");
      return refreshRecord(records, settings, old!, now);
    }
  }
  let item: PyDict;
  if (old && olderNotification(job, old.dict("job"))) item = refreshRecord(records, settings, old, now);
  else if (old && old.req("fingerprint") === fingerprint) {
    item = old;
    item.set("job", job);
    refreshRecord(records, settings, item, now);
  } else {
    item = newObservation(key, job, fingerprint, evaluate(job, settings, now), old);
    if (!old) records.insert(item);
    records.save(item);
  }
  // The owner was null above and the lease keeps it so: the receipt is this listing's.
  if (receiptId !== null) receipts.add(source, receiptId, key);
  return item;
}

function checkHealth(source: PyValue, status: PyValue): asserts status is SourceStatus {
  if (!isSource(source) || !STATUSES.includes(status as SourceStatus)) throw new PyError("ValueError", "unknown source or source status");
}

/** One upsert: atomic on D1, and repeating it only moves checked_at, so a lost response is retried. */
export async function setSourceHealth(db: Db, source: PyValue, status: PyValue) {
  checkHealth(source, status);
  await retrying(() => db.insert(sourceHealth).values({ source: source as string, status })
    .onConflictDoUpdate({ target: sourceHealth.source, set: { status, checkedAt: utcNowText } }));
}

/**
 * One source's intake as one unit (Python's source_batch): every listing `keep` accepts is ingested
 * and the health, when given, is written with them, all or nothing while it fits one request (past
 * that, each batch carries whole records with their receipts and health comes last; rerunning is
 * idempotent). `keep` sees each listing and whether its record existed when the unit read it, with
 * the writer lease (D20 common basis 1); it may run again when the lease was lost before the write.
 * Returns the ingested records, in listing order.
 */
export function ingestSource(db: Db, source: PyValue, now: PyDateTime, items: readonly Listing[],
  keep: (job: PyDict, exists: boolean) => boolean, health: PyValue | null): Promise<PyDict[]> {
  if (!isSource(source)) throw new PyError("ValueError", "unknown source");
  if (health !== null) checkHealth(source, health);
  return writeUnit(db, INTAKE_WRITE, intakeReads(db, items), ([s, found, receipts], writes) => {
    const existed = new Set([...found].filter(([, item]) => item !== null).map(([key]) => key));
    const unit: Intake = { records: new Records(found, writes, s), receipts: new Receipts(receipts, writes), settings: s.settings };
    const ingested: PyDict[] = [];
    for (const [jobValue, receiptId] of items) {
      const job = asDict(jobValue);
      if (job.at("source") !== source) throw new PyError("ValueError", "Wrong intake source");
      const key = listingKey(job);
      if (keep(job, key !== null && existed.has(key))) ingested.push(ingestListing(unit, job, receiptId, now));
    }
    if (health !== null) {
      writes.put(sourceHealth, { kind: "update", target: sourceHealth.source, set: [sourceHealth.status, sourceHealth.checkedAt] }, source,
        { source, status: health as SourceStatus, checkedAt: utcNowText }, null);
    }
    return ingested;
  });
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

/** The content versions of these opportunities only, in the same order (a discovery page, plan step 10e1). */
export const contentVersionsFor = (db: Db, keys: readonly string[]) =>
  read(db.select().from(mailContentVersions).where(inList(mailContentVersions.opportunityId, keys)).orderBy(asc(mailContentVersions.fingerprint)),
    (rows): ContentVersionRow[] => rows);


/** Which (opportunity, fingerprint) content versions exist for a unit's opportunities, plus the ones it adds (each with its projection row, plan step 10e1). */
class ContentVersions {
  constructor(private readonly known: Set<string>, private readonly writes: Writes, private readonly settings: Settings) {}

  has(key: string, fingerprint: string) {
    return this.known.has(pair(key, fingerprint));
  }

  /** INSERT … ON CONFLICT DO NOTHING; true when the row is new. */
  add(key: string, fingerprint: string, job: PyDict): boolean {
    if (this.has(key, fingerprint)) return false;
    this.known.add(pair(key, fingerprint));
    this.writes.put(mailContentVersions, { kind: "nothing" }, pair(key, fingerprint), { opportunityId: key, fingerprint, job: encode(job) }, key);
    putVersion(this.writes, key, fingerprint, job, this.settings);
    return true;
  }
}

const versionsRead = (db: Db, keys: readonly string[]) =>
  read(db.select({ key: mailContentVersions.opportunityId, fingerprint: mailContentVersions.fingerprint }).from(mailContentVersions)
    .where(inList(mailContentVersions.opportunityId, keys)), (rows) => new Set(rows.map((r) => pair(r.key, r.fingerprint))));

/**
 * Keep distinct forwarded observations without choosing a newer source version
 * (Collection.ingest_resend_batch): one unit for the whole message. `keep` decides, from the
 * listing and whether its record existed when the unit read it (with the lease), which to ingest.
 */
export function ingestResendBatch(db: Db, jobs: PyValue[], now: PyDateTime, keep: (job: PyDict, exists: boolean) => boolean = () => true):
  Promise<{ contentVersions: number; kept: PyDict[] }> {
  const items = listings(jobs);
  const keys = items.map(([job]) => listingKey(job)).filter((k) => k !== null);
  return writeUnit(db, INTAKE_WRITE, [...intakeReads(db, items), versionsRead(db, keys)], ([s, found, receipts, known], writes) => {
    const existed = new Set([...found].filter(([, item]) => item !== null).map(([key]) => key));
    const unit: Intake = { records: new Records(found, writes, s), receipts: new Receipts(receipts, writes), settings: s.settings };
    const versions = new ContentVersions(known, writes, s);
    let newVersions = 0;
    const kept: PyDict[] = [];
    for (const jobValue of jobs) {
      const job = asDict(jobValue);
      const source = pySubscript(job, "source"), receiptId = pySubscript(job, "receipt_id");
      const key = identityHash([source, pySubscript(job, "external_id")]);
      if (!keep(job, existed.has(key))) continue;
      const record = unit.records.get(key);
      kept.push(job);
      const fingerprint = jobFingerprint(job);
      let incoming = job;
      if (record !== null) {
        if (fingerprint !== record.req("fingerprint")) {
          const owner = unit.receipts.owner(source as string, receiptId as string);
          if (owner !== null && owner !== key) throw new Conflict("Receipt already belongs to another opportunity");
          if (owner !== null && !versions.has(key, fingerprint)) throw new Conflict("Receipt reused with different content");
          versions.add(key, record.str("fingerprint"), record.dict("job"));
          if (versions.add(key, fingerprint, job)) newVersions++;
          unit.receipts.add(source as string, receiptId as string, key);
          continue;
        }
        incoming = record.dict("job");
      }
      ingestListing(unit, incoming, receiptId, now);
    }
    return { contentVersions: newVersions, kept };
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
