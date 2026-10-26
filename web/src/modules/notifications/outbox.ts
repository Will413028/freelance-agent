import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { inList, insertChunks, read, readAll, retrying, type Db } from "@/db/client";
import { d1ErrorOf } from "@/db/d1/client";
import { digestNovelty, digestOutbox, utcNowText } from "@/db/schema";
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

export const findDigestRead = (db: Db, localDate: string, recipient: string) => read(
  db.select().from(digestOutbox).where(and(eq(digestOutbox.localDate, localDate), eq(digestOutbox.recipient, recipient))),
  ([row]) => (row ? decode(row) : null));

export const findDigest = async (db: Db, localDate: string, recipient: string) => (await readAll(db, [findDigestRead(db, localDate, recipient)]))[0];

export async function getDigest(db: Db, id: string): Promise<DigestRow> {
  const [row] = await retrying(() => db.select().from(digestOutbox).where(eq(digestOutbox.id, id)));
  if (!row) throw new PyError("KeyError", id);
  return decode(row);
}

/**
 * The novelty pairs a snapshot announced (D15): the digest_novelty rows written with it. Items
 * stored before snapshots carried novelty_keys derive them, exactly as the old full scan did.
 */
export function noveltyRows(snapshot: PyDict): [string, string][] {
  const pairs = new TupleSet();
  for (const item of asList(snapshot.req("items"))) for (const pair of novelty(asDict(item)).values()) pairs.add(pair);
  return [...pairs.values()].map(([key, fingerprint]) => [key, fingerprint]);
}

type Statement = BatchItem<"sqlite">;

/** The ledger inserts for one snapshot, to go in the same batch as whatever makes them true. */
function noveltyInserts(db: Db, digestId: string, snapshot: PyDict): { statements: Statement[]; rows: number } {
  const rows = noveltyRows(snapshot).map(([key, fingerprint]) => ({ digestId, key, fingerprint }));
  return { statements: insertChunks(rows, 3).map((chunk) => db.insert(digestNovelty).values(chunk)), rows: rows.length };
}

/**
 * The keys unseen() looks up for these candidates: their novelty keys and member ids. Every pair it
 * reads has one of them as its key, so the ledger rows for these keys decide exactly as all would.
 */
export function lookupKeys(candidates: PyDict[]): string[] {
  const keys = new Set<string>();
  for (const item of candidates) {
    for (const [key] of novelty(item).values()) keys.add(key);
    const members = item.has("members") ? asList(item.get("members")!).map(asDict) : [item];
    for (const member of members) keys.add(member.str("id"));
  }
  return [...keys];
}

/** Pairs with these keys that a sent, attempted or unknown digest to this recipient announced. */
export async function announced(db: Db, recipient: string, keys: string[]): Promise<TupleSet> {
  if (keys.length === 0) return new TupleSet();
  const [pairs] = await readAll(db, [read(
    db.selectDistinct({ key: digestNovelty.key, fingerprint: digestNovelty.fingerprint }).from(digestNovelty)
      .innerJoin(digestOutbox, eq(digestOutbox.id, digestNovelty.digestId))
      .where(and(eq(digestOutbox.recipient, recipient), inArray(digestOutbox.status, ["sent", "attempted", "unknown"]), inList(digestNovelty.key, keys))),
    (rows) => rows.map((r): [string, string] => [r.key, r.fingerprint]))]);
  return new TupleSet(pairs);
}

/**
 * The selection inside create_digest: candidates none of whose novelty an earlier sent, attempted
 * or unknown digest announced, so an uncertain delivery is never repeated by the next day's mail.
 * Pure, so its cost is tested alone.
 */
export function selectUnseen(candidates: PyDict[], announced: TupleSet): PyDict[] {
  const known = seenIds(announced);
  return candidates.filter((item) => unseen(item, announced, known));
}

/**
 * create_digest after list_in: select, then store the immutable snapshot and its ledger rows in one
 * batch. The announced pairs are read in a request after the list (their keys come from it); that
 * is the same as reading them together because what they read only grows: ledger rows are never
 * changed or removed (trigger), and an earlier digest's status only moves forward, which at worst
 * suppresses a candidate that a delivery claimed in between, as a later run would. The day's own
 * digest is not among them: none exists yet, and a pending one is not counted. The day's digest is unique per recipient, so the batch is safe to repeat: when it fails on
 * that key (another run stored the day first, or a lost response had committed this one), the
 * stored digest is returned, as Python returns an existing one unchanged.
 */
export async function insertDigest(db: Db, allItems: PyDict[], sources: PyDict, localDate: string, recipient: string, now: PyDateTime): Promise<DigestRow> {
  const candidates = groupItems(allItems).filter(isCandidate);
  const fresh = selectUnseen(candidates, await announced(db, recipient, lookupKeys(candidates)));
  const items = fresh.map((item) => publicItem(item).update({ fingerprint: item.req("fingerprint"), novelty_keys: item.req("novelty_keys") }));
  const snapshot = encode(PyDict.of({
    items, candidate_count: BigInt(candidates.length), unseen_count: BigInt(fresh.length), suppressed_count: BigInt(candidates.length - fresh.length),
    sources, generated_at: now.isoformat(), recipient, local_date: localDate,
  }));
  const id = randomUUID();
  // From the stored text, the same derivation the backfill applies to older snapshots.
  const ledger = noveltyInserts(db, id, loadsDict(snapshot));
  try {
    const [rows] = await retrying(() => db.batch([db.insert(digestOutbox).values({ id, localDate, recipient, snapshot }).returning(), ...ledger.statements]));
    return decode(rows[0]);
  } catch (e) {
    if (d1ErrorOf(e)?.kind !== "constraint") throw e;
    const stored = await findDigest(db, localDate, recipient);
    if (!stored) throw e;
    return stored;
  }
}

export type StoredDigest = { id: string; snapshot: string };

/**
 * Writes the ledger rows of digests loaded without them: a copy just loaded into an empty ledger
 * (converge, replay), from the copy's own rows rather than reading the snapshots back. A digest
 * that already has rows fails on the primary key instead of being skipped. Returns the rows written.
 */
const BACKFILL_BATCH = 50; // statements per request; a load writes hundreds of digests (D19: 1,200 requests per 5 minutes)

export async function backfillNoveltyIn(db: Db, digests: Iterable<StoredDigest>): Promise<number> {
  let written = 0;
  let pending: Statement[] = [];
  const flush = async () => {
    if (pending.length) await db.batch(pending as [Statement, ...Statement[]]);
    pending = [];
  };
  for (const digest of digests) {
    const ledger = noveltyInserts(db, digest.id, loadsDict(digest.snapshot));
    pending.push(...ledger.statements);
    written += ledger.rows;
    if (pending.length >= BACKFILL_BATCH) await flush();
  }
  await flush();
  return written;
}

export type NoveltyCheck = { digests: number; rows: number; missing: number; extra: number };

/**
 * Rederives the ledger from the stored snapshots and counts the differences; it needs only the
 * snapshots, so it outlives the shadow replay. `since` limits it to digests of that day onwards.
 */
export async function checkNoveltyIn(db: Db, since?: string): Promise<NoveltyCheck> {
  const day = since === undefined ? undefined : gte(digestOutbox.localDate, since);
  const [digests, stored] = await readAll(db, [
    read(db.select({ id: digestOutbox.id, snapshot: digestOutbox.snapshot }).from(digestOutbox).where(day), (rows) => rows),
    read(db.select({ digestId: digestNovelty.digestId, key: digestNovelty.key, fingerprint: digestNovelty.fingerprint }).from(digestNovelty)
      .innerJoin(digestOutbox, eq(digestOutbox.id, digestNovelty.digestId)).where(day), (rows) => rows),
  ]);
  const want = new TupleSet(digests.flatMap((d) => noveltyRows(loadsDict(d.snapshot)).map(([key, fp]) => [d.id, key, fp])));
  const have = new TupleSet(stored.map((r) => [r.digestId, r.key, r.fingerprint]));
  const missing = [...want.values()].filter((t) => !have.has(t)).length;
  return { digests: digests.length, rows: stored.length, missing, extra: [...have.values()].filter((t) => !want.has(t)).length };
}

/**
 * pending → attempted, committed before any sender is called; null when the intent was not pending.
 * Never repeated: after a lost response the claim may have committed, and the caller fails without
 * sending, leaving the digest pending or attempted for a person (plan step 10c).
 */
export async function claimDigest(db: Db, id: string): Promise<DigestRow | null> {
  const [row] = await db.update(digestOutbox).set({ status: "attempted", attemptedAt: utcNowText })
    .where(and(eq(digestOutbox.id, id), eq(digestOutbox.status, "pending"))).returning();
  return row ? decode(row) : null;
}

/** attempted → sent (with a provider receipt) or unknown; there is no way back to pending, so repeating it changes nothing. */
export async function finishDigest(db: Db, id: string, status: "sent" | "unknown", receipt: string | null = null): Promise<DigestRow> {
  if (status !== "sent" && status !== "unknown") throw new PyError("ValueError", "Only sent or unknown delivery outcomes are supported");
  if (status === "sent" && (typeof receipt !== "string" || !pyStrip(receipt))) throw new PyError("ValueError", "sent requires a provider receipt");
  await retrying(() => db.update(digestOutbox).set({ status, deliveryReceipt: receipt, finishedAt: utcNowText })
    .where(and(eq(digestOutbox.id, id), eq(digestOutbox.status, "attempted"))));
  return getDigest(db, id);
}
