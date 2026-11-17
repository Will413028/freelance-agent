import { and, asc, count, eq, inArray, lt, ne } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { mailCursors, mailMessages } from "@/db/pg/schema";
import type { MailReason } from "./reasons";

// What a mail source remembers between runs: each message it looked at, once (mail_messages, keyed by
// source, inbox and Resend id), and where its scan of the inbox stands (mail_cursors). Only ids, statuses
// and reason codes; never a subject or body.

/**
 * Scan position (old mail/sync.ts): `cursor` is the newest id of the last complete scan, where the next
 * scan stops; `head` is the newest id of the scan in progress; `after` is the last id that scan handled,
 * where an interrupted scan resumes paging.
 */
export type MailCursor = { cursor: string | null; after: string | null; head: string | null };

export async function loadCursor(db: PgDb, source: string, recipient: string): Promise<MailCursor> {
  const [row] = await db.select().from(mailCursors).where(and(eq(mailCursors.source, source), eq(mailCursors.recipient, recipient)));
  return { cursor: row?.cursor ?? null, after: row?.after ?? null, head: row?.head ?? null };
}

export async function saveCursor(db: PgDb, source: string, recipient: string, c: MailCursor): Promise<void> {
  await db.insert(mailCursors).values({ source, recipient, ...c })
    .onConflictDoUpdate({ target: [mailCursors.source, mailCursors.recipient], set: c });
}

/** Which of `ids` this source has recorded for the inbox: none of them is read again. */
export async function recordedMessages(db: PgDb, source: string, recipient: string, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.select({ id: mailMessages.messageId }).from(mailMessages)
    .where(and(eq(mailMessages.source, source), eq(mailMessages.recipient, recipient), inArray(mailMessages.messageId, [...ids])));
  return new Set(rows.map((r) => r.id));
}

export type MailOutcome = { status: "processed"; reason: "content_changed" | null } | { status: "rejected"; reason: MailReason };

/**
 * Records one message's outcome. A message already recorded keeps its outcome (read once), unless it is
 * marked for a re-read: then the new outcome replaces it and the mark is cleared.
 */
export async function recordMessage(db: PgDb, source: string, recipient: string, messageId: string, outcome: MailOutcome, now: Date): Promise<void> {
  await db.insert(mailMessages).values({ source, recipient, messageId, status: outcome.status, reason: outcome.reason, checkedAt: now })
    .onConflictDoUpdate({
      target: [mailMessages.source, mailMessages.recipient, mailMessages.messageId],
      set: { status: outcome.status, reason: outcome.reason, disposition: "none", checkedAt: now },
      setWhere: eq(mailMessages.disposition, "retry"),
    });
}

/** Up to `limit` of this source's messages marked for a re-read, longest waiting first. */
export async function retryMessages(db: PgDb, source: string, recipient: string, limit: number): Promise<string[]> {
  const rows = await db.select({ id: mailMessages.messageId }).from(mailMessages)
    .where(and(eq(mailMessages.source, source), eq(mailMessages.recipient, recipient), eq(mailMessages.disposition, "retry")))
    .orderBy(asc(mailMessages.checkedAt), asc(mailMessages.messageId)).limit(limit);
  return rows.map((r) => r.id);
}

export type MailDisposition = "retry" | "dismissed";

/**
 * Marks the rejected messages of `source` with `reason` (the plan's dead-letter actions, grouped by reason
 * because a row holds no content to judge one message by): `retry` re-reads the open ones on the next runs
 * (a dismissed message stays dismissed), `dismissed` takes open and waiting ones out of the count. Returns
 * how many rows changed.
 */
export async function markRejected(db: PgDb, source: string, reason: MailReason, disposition: MailDisposition): Promise<number> {
  const from = disposition === "retry" ? eq(mailMessages.disposition, "none") : ne(mailMessages.disposition, "dismissed");
  const rows = await db.update(mailMessages).set({ disposition })
    .where(and(eq(mailMessages.source, source), eq(mailMessages.status, "rejected"), eq(mailMessages.reason, reason), from))
    .returning({ id: mailMessages.messageId });
  return rows.length;
}

export type RejectedGroup = { source: string; reason: string; open: number; retry: number };

/** Rejected messages by source and reason: open (no action yet) and waiting for a re-read; dismissed ones are not counted. */
export async function rejectedGroups(db: PgDb): Promise<RejectedGroup[]> {
  const rows = await db.select({ source: mailMessages.source, reason: mailMessages.reason, disposition: mailMessages.disposition, n: count() }).from(mailMessages)
    .where(and(eq(mailMessages.status, "rejected"), ne(mailMessages.disposition, "dismissed")))
    .groupBy(mailMessages.source, mailMessages.reason, mailMessages.disposition);
  const groups = new Map<string, RejectedGroup>();
  for (const r of rows) {
    const key = `${r.source}\u0000${r.reason}`;
    const g = groups.get(key) ?? { source: r.source, reason: r.reason ?? "", open: 0, retry: 0 };
    if (r.disposition === "retry") g.retry += r.n; else g.open += r.n;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.source.localeCompare(b.source) || a.reason.localeCompare(b.reason));
}

/**
 * How long a message's record is kept after its last check. Resend documents 30 days for email data
 * (receiving retention is not stated separately), so an older message could not be re-read anyway. A
 * pruned message is older than the scan position, so normally it is not listed again; if the scan ever
 * runs past a cursor Resend dropped, it is read once more, which writes the same fingerprints. A message
 * waiting for its re-read is kept until the re-read records an outcome (message_gone at worst).
 */
export const MAIL_RETENTION_DAYS = 30;

/** Deletes the records last checked more than MAIL_RETENTION_DAYS before `now`, except those waiting for a re-read; returns how many. */
export async function pruneMailMessages(db: PgDb, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - MAIL_RETENTION_DAYS * 86_400_000);
  const rows = await db.delete(mailMessages).where(and(lt(mailMessages.checkedAt, cutoff), ne(mailMessages.disposition, "retry"))).returning({ id: mailMessages.messageId });
  return rows.length;
}
