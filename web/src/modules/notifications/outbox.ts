import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { readTransaction, writeTransaction, type Db, type Executor } from "@/db/client";
import { digestOutbox, utcNowText } from "@/db/schema";
import { groupItems, isCandidate, novelty, publicItem, seenIds, unseen } from "@/modules/discovery/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { pyStrip } from "@/platform/py/unicode";
import { asDict, asList, PyDict, PyError, TupleSet } from "@/platform/py/value";

// Port of the digest_outbox part of notifications/store.py: one immutable snapshot per Taipei day
// and recipient. Composing it with discovery's list_in lives in src/services/digest.ts.

export type DigestRow = {
  id: string; localDate: string; recipient: string; snapshot: PyDict; status: string;
  createdAt: string; attemptedAt: string | null; finishedAt: string | null; deliveryReceipt: string | null;
};

const decode = (row: typeof digestOutbox.$inferSelect): DigestRow => ({ ...row, snapshot: loadsDict(row.snapshot) });

export async function findDigestIn(tx: Executor, localDate: string, recipient: string): Promise<DigestRow | null> {
  const [row] = await tx.select().from(digestOutbox).where(and(eq(digestOutbox.localDate, localDate), eq(digestOutbox.recipient, recipient)));
  return row ? decode(row) : null;
}

export const findDigest = (db: Db, localDate: string, recipient: string) => readTransaction(db, (tx) => findDigestIn(tx, localDate, recipient));

export async function getDigest(db: Db, id: string): Promise<DigestRow> {
  const [row] = await readTransaction(db, (tx) => tx.select().from(digestOutbox).where(eq(digestOutbox.id, id)));
  if (!row) throw new PyError("KeyError", id);
  return decode(row);
}

/**
 * The selection inside create_digest: grouped candidates, and those whose novelty keys no sent,
 * attempted or unknown prior digest (`priorSnapshots`, their stored text) already carried, so an
 * uncertain delivery is never repeated by the next day's mail. Pure, so its cost is tested alone.
 */
export function selectUnseen(allItems: PyDict[], priorSnapshots: string[]): { candidates: PyDict[]; fresh: PyDict[] } {
  const candidates = groupItems(allItems).filter(isCandidate);
  const seen = new TupleSet();
  for (const text of priorSnapshots) for (const item of asList(loadsDict(text).req("items"))) for (const key of novelty(asDict(item)).values()) seen.add(key);
  const known = seenIds(seen);
  return { candidates, fresh: candidates.filter((item) => unseen(item, seen, known)) };
}

/** create_digest after list_in: select, then store the immutable snapshot. */
export async function insertDigestIn(tx: Executor, allItems: PyDict[], sources: PyDict, localDate: string, recipient: string, now: PyDateTime): Promise<DigestRow> {
  const prior = await tx.select({ snapshot: digestOutbox.snapshot }).from(digestOutbox)
    .where(and(eq(digestOutbox.recipient, recipient), inArray(digestOutbox.status, ["sent", "attempted", "unknown"])));
  const { candidates, fresh } = selectUnseen(allItems, prior.map((row) => row.snapshot));
  const items = fresh.map((item) => publicItem(item).update({ fingerprint: item.req("fingerprint"), novelty_keys: item.req("novelty_keys") }));
  const snapshot = PyDict.of({
    items, candidate_count: BigInt(candidates.length), unseen_count: BigInt(fresh.length), suppressed_count: BigInt(candidates.length - fresh.length),
    sources, generated_at: now.isoformat(), recipient, local_date: localDate,
  });
  const [row] = await tx.insert(digestOutbox).values({ id: randomUUID(), localDate, recipient, snapshot: encode(snapshot) }).returning();
  return decode(row);
}

/** pending → attempted, committed before any sender is called; null when the intent was not pending. */
export async function claimDigest(db: Db, id: string): Promise<DigestRow | null> {
  const [row] = await writeTransaction(db, (tx) => tx.update(digestOutbox).set({ status: "attempted", attemptedAt: utcNowText })
    .where(and(eq(digestOutbox.id, id), eq(digestOutbox.status, "pending"))).returning());
  return row ? decode(row) : null;
}

/** attempted → sent (with a provider receipt) or unknown; there is no way back to pending. */
export async function finishDigest(db: Db, id: string, status: "sent" | "unknown", receipt: string | null = null): Promise<DigestRow> {
  if (status !== "sent" && status !== "unknown") throw new PyError("ValueError", "Only sent or unknown delivery outcomes are supported");
  if (status === "sent" && (typeof receipt !== "string" || !pyStrip(receipt))) throw new PyError("ValueError", "sent requires a provider receipt");
  await writeTransaction(db, (tx) => tx.update(digestOutbox).set({ status, deliveryReceipt: receipt, finishedAt: utcNowText })
    .where(and(eq(digestOutbox.id, id), eq(digestOutbox.status, "attempted"))));
  return getDigest(db, id);
}
