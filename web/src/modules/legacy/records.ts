import { asc } from "drizzle-orm";
import { inList, read, readAll, type Db } from "@/db/client";
import { opportunities, proposalRevisions } from "@/db/schema";
import type { Writes } from "@/db/unit";
import { evaluate, putItem, type Settings } from "@/modules/discovery/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { deepCopy, pyEq, PyDict, truthy, type PyValue } from "@/platform/py/value";

// Port of legacy/records.py: the compatibility codec owning historical opportunity/proposal row
// envelopes. The envelope keeps its legacy review fields (D8); `item` text is written with encode()
// so rows stay byte-compatible with the Python writer.

export const allRecordsRead = (db: Db) =>
  read(db.select({ item: opportunities.item }).from(opportunities).orderBy(asc(opportunities.id)), (rows) => rows.map((r) => loadsDict(r.item)));

export async function allRecords(db: Db): Promise<PyDict[]> {
  return (await readAll(db, [allRecordsRead(db)]))[0];
}

/** The records with these ids, for a unit's read request (absent ids map to null). */
export const recordsRead = (db: Db, keys: readonly string[]) =>
  read(db.select({ id: opportunities.id, item: opportunities.item }).from(opportunities).where(inList(opportunities.id, keys)), (rows) => {
    const found = new Map<string, PyDict | null>(keys.map((k) => [k, null]));
    for (const row of rows) found.set(row.id, loadsDict(row.item));
    return found;
  });

/**
 * A unit's view of opportunity records (plan step 4e2b): the records it read, with its own unsent
 * writes applied, so a later step of the same unit sees an earlier one's record. Each get returns a
 * fresh copy, as a read of the row would; only insert and save change what later gets see.
 */
export class Records {
  private readonly created = new Set<string>();

  /**
   * `settings` are the ones the unit read, for the projection row written with every record (plan
   * step 10e1); `complete` when the unit read every record, so an id it has not seen does not exist.
   */
  constructor(private readonly items: Map<string, PyDict | null>, private readonly writes: Writes, private readonly settings: Settings, private readonly complete = false) {}

  static over(items: readonly PyDict[], writes: Writes, settings: Settings) {
    return new Records(new Map(items.map((item) => [item.str("id"), item])), writes, settings, true);
  }

  get(key: string): PyDict | null {
    if (!this.items.has(key) && !this.complete) throw new Error(`record ${key} was not read by this unit`);
    const item = this.items.get(key);
    return item ? deepCopy(item) : null;
  }

  /** A new record: a plain INSERT, which fails if the row exists after all (one row per record, however often it is saved). */
  insert(item: PyDict) {
    this.created.add(item.str("id"));
    this.put(item);
  }

  /** The record's current envelope, and its proposal revision when it carries proposal text. */
  save(item: PyDict) {
    this.put(item);
    if (!truthy(item.at("proposal"))) return;
    const id = item.str("id"), version = Number(item.req("version"));
    this.writes.put(proposalRevisions, { kind: "nothing" }, `${id}\0${version}`,
      { opportunityId: id, version, proposal: item.str("proposal"), fingerprint: item.str("fingerprint") }, id);
  }

  private put(item: PyDict) {
    const id = item.str("id"), job = item.dict("job");
    this.items.set(id, deepCopy(item));
    this.writes.put(opportunities, this.created.has(id) ? { kind: "insert" } : { kind: "update", target: opportunities.id, set: [opportunities.item] }, id,
      { id, source: job.str("source"), externalId: job.str("external_id"), item: encode(item) }, id);
    putItem(this.writes, item, this.settings);
  }
}

export function newObservation(key: string, job: PyDict, fingerprint: string, evaluation: PyDict, old: PyDict | null): PyDict {
  const item = PyDict.of({
    id: key, job, fingerprint, evaluation, proposal: "", version: old ? (old.req("version") as bigint) + 1n : 1n,
    review_status: "draft", approved_hash: null, skip_reason: "", draft_method: "未建立提案", delivery_mode: "manual",
  });
  if (old && pyEq(old.req("review_status"), "skipped")) item.update({ review_status: "skipped", skip_reason: old.req("skip_reason") });
  return item;
}

const bump = (item: PyDict) => (item.req("version") as bigint) + 1n;

export function feedbackChanged(records: Records, settings: PyDict, item: PyDict, feedback: PyValue, now: PyDateTime): PyDict {
  if (pyEq(feedback, "skipped") && pyEq(item.req("review_status"), "approved")) {
    item.update({ review_status: "draft", approved_hash: null, version: bump(item) });
  }
  if ((pyEq(feedback, "neutral") || pyEq(feedback, "interested")) && pyEq(item.req("review_status"), "skipped")) {
    item.update({ review_status: "draft", skip_reason: "", approved_hash: null, version: bump(item) });
  }
  records.save(item);
  return refreshRecord(records, settings, item, now);
}

/** Re-evaluates a record under the current settings and saves it only when its evaluation or review status changed. */
export function refreshRecord(records: Records, settings: PyDict, item: PyDict, now: PyDateTime): PyDict {
  const oldEvaluation = item.at("evaluation");
  const oldReview = item.req("review_status");
  item.set("evaluation", evaluate(item.dict("job"), settings, now));
  if (item.dict("evaluation").req("status") !== "qualified" && pyEq(item.req("review_status"), "approved")) {
    item.update({ review_status: "draft", approved_hash: null, version: bump(item) });
  }
  if (!pyEq(item.get("evaluation")!, oldEvaluation) || !pyEq(item.req("review_status"), oldReview)) records.save(item);
  return item;
}
