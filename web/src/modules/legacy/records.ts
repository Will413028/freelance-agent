import { asc, eq } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { opportunities, proposalRevisions } from "@/db/schema";
import { evaluate, readSettings } from "@/modules/discovery/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { pyEq, PyDict, truthy, type PyValue } from "@/platform/py/value";

// Port of legacy/records.py: the compatibility codec owning historical opportunity/proposal row
// envelopes. The envelope keeps its legacy review fields (D8); `item` text is written with encode()
// so rows stay byte-compatible with the Python writer.

export async function getRecord(tx: Executor, key: string): Promise<PyDict | null> {
  const [row] = await tx.select({ item: opportunities.item }).from(opportunities).where(eq(opportunities.id, key));
  return row ? loadsDict(row.item) : null;
}

export async function allRecords(tx: Executor): Promise<PyDict[]> {
  const rows = await tx.select({ item: opportunities.item }).from(opportunities).orderBy(asc(opportunities.id));
  return rows.map((r) => loadsDict(r.item));
}

/** Python leaves the order of this query to SQLite; callers only build sets and maps from it. */
export async function recordsForSource(tx: Executor, source: string): Promise<PyDict[]> {
  const rows = await tx.select({ item: opportunities.item }).from(opportunities).where(eq(opportunities.source, source));
  return rows.map((r) => loadsDict(r.item));
}

export async function insertRecord(tx: Executor, item: PyDict) {
  const job = item.dict("job");
  await tx.insert(opportunities).values({ id: item.str("id"), source: job.str("source"), externalId: job.str("external_id"), item: encode(item) });
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

export async function feedbackChanged(tx: Executor, item: PyDict, feedback: PyValue, now: PyDateTime): Promise<PyDict> {
  if (pyEq(feedback, "skipped") && pyEq(item.req("review_status"), "approved")) {
    item.update({ review_status: "draft", approved_hash: null, version: bump(item) });
  }
  if ((pyEq(feedback, "neutral") || pyEq(feedback, "interested")) && pyEq(item.req("review_status"), "skipped")) {
    item.update({ review_status: "draft", skip_reason: "", approved_hash: null, version: bump(item) });
  }
  await saveRecord(tx, item);
  return refreshRecord(tx, item, now);
}

export async function saveRecord(tx: Executor, item: PyDict) {
  await tx.update(opportunities).set({ item: encode(item) }).where(eq(opportunities.id, item.str("id")));
  if (!truthy(item.at("proposal"))) return;
  await tx.insert(proposalRevisions).values({
    opportunityId: item.str("id"), version: Number(item.req("version")), proposal: item.str("proposal"), fingerprint: item.str("fingerprint"),
  }).onConflictDoNothing();
}

export async function refreshRecord(tx: Executor, item: PyDict, now: PyDateTime): Promise<PyDict> {
  const oldEvaluation = item.at("evaluation");
  const oldReview = item.req("review_status");
  item.set("evaluation", evaluate(item.dict("job"), (await readSettings(tx)).settings, now));
  if (item.dict("evaluation").req("status") !== "qualified" && pyEq(item.req("review_status"), "approved")) {
    item.update({ review_status: "draft", approved_hash: null, version: bump(item) });
  }
  if (!pyEq(item.get("evaluation")!, oldEvaluation) || !pyEq(item.req("review_status"), oldReview)) await saveRecord(tx, item);
  return item;
}
