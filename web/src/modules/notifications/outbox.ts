import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { readTransaction, writeTransaction, type Db, type Executor } from "@/db/client";
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
 * The novelty pairs a snapshot announced (D15): the digest_novelty rows written with it. Items
 * stored before snapshots carried novelty_keys derive them, exactly as the old full scan did.
 */
export function noveltyRows(snapshot: PyDict): [string, string][] {
  const pairs = new TupleSet();
  for (const item of asList(snapshot.req("items"))) for (const pair of novelty(asDict(item)).values()) pairs.add(pair);
  return [...pairs.values()].map(([key, fingerprint]) => [key, fingerprint]);
}

const LEDGER_CHUNK = 10_000; // 3 bind parameters per row, under Postgres's 65535

async function insertNoveltyIn(tx: Executor, digestId: string, snapshot: PyDict): Promise<number> {
  const rows = noveltyRows(snapshot).map(([key, fingerprint]) => ({ digestId, key, fingerprint }));
  for (let at = 0; at < rows.length; at += LEDGER_CHUNK) await tx.insert(digestNovelty).values(rows.slice(at, at + LEDGER_CHUNK));
  return rows.length;
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
async function announcedIn(tx: Executor, recipient: string, keys: string[]): Promise<TupleSet> {
  const rows = await tx.selectDistinct({ key: digestNovelty.key, fingerprint: digestNovelty.fingerprint }).from(digestNovelty)
    .innerJoin(digestOutbox, eq(digestOutbox.id, digestNovelty.digestId))
    .where(and(eq(digestOutbox.recipient, recipient), inArray(digestOutbox.status, ["sent", "attempted", "unknown"]),
      sql`${digestNovelty.key} = any(${sql.param(keys)}::text[])`));
  return new TupleSet(rows.map((r) => [r.key, r.fingerprint]));
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

/** create_digest after list_in: select, then store the immutable snapshot and its ledger rows. */
export async function insertDigestIn(tx: Executor, allItems: PyDict[], sources: PyDict, localDate: string, recipient: string, now: PyDateTime): Promise<DigestRow> {
  const candidates = groupItems(allItems).filter(isCandidate);
  const fresh = selectUnseen(candidates, await announcedIn(tx, recipient, lookupKeys(candidates)));
  const items = fresh.map((item) => publicItem(item).update({ fingerprint: item.req("fingerprint"), novelty_keys: item.req("novelty_keys") }));
  const snapshot = PyDict.of({
    items, candidate_count: BigInt(candidates.length), unseen_count: BigInt(fresh.length), suppressed_count: BigInt(candidates.length - fresh.length),
    sources, generated_at: now.isoformat(), recipient, local_date: localDate,
  });
  const [row] = await tx.insert(digestOutbox).values({ id: randomUUID(), localDate, recipient, snapshot: encode(snapshot) }).returning();
  const stored = decode(row);
  // From the stored text, the same derivation the backfill applies to older snapshots.
  await insertNoveltyIn(tx, stored.id, stored.snapshot);
  return stored;
}

export type StoredDigest = { id: string; snapshot: string };

/**
 * Writes the ledger rows of digests loaded without them: a copy just loaded into an empty ledger
 * (converge, replay), from the copy's own rows rather than reading the snapshots back. A digest
 * that already has rows fails on the primary key instead of being skipped. Returns the rows written.
 */
export async function backfillNoveltyIn(tx: Executor, digests: Iterable<StoredDigest>): Promise<number> {
  let written = 0;
  for (const digest of digests) written += await insertNoveltyIn(tx, digest.id, loadsDict(digest.snapshot));
  return written;
}

export type NoveltyCheck = { digests: number; rows: number; missing: number; extra: number };

/**
 * Rederives the ledger from the stored snapshots and counts the differences; it needs only the
 * snapshots, so it outlives the shadow replay. `since` limits it to digests of that day onwards.
 */
export async function checkNoveltyIn(tx: Executor, since?: string): Promise<NoveltyCheck> {
  const digests = await tx.select({ id: digestOutbox.id, snapshot: digestOutbox.snapshot }).from(digestOutbox)
    .where(since === undefined ? undefined : gte(digestOutbox.localDate, since));
  const want = new TupleSet(digests.flatMap((d) => noveltyRows(loadsDict(d.snapshot)).map(([key, fp]) => [d.id, key, fp])));
  const stored = await tx.select().from(digestNovelty).where(inArray(digestNovelty.digestId, digests.length ? digests.map((d) => d.id) : [""]));
  const have = new TupleSet(stored.map((r) => [r.digestId, r.key, r.fingerprint]));
  const missing = [...want.values()].filter((t) => !have.has(t)).length;
  return { digests: digests.length, rows: stored.length, missing, extra: [...have.values()].filter((t) => !want.has(t)).length };
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
