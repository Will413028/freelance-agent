import { and, eq } from "drizzle-orm";
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

/** Every message id this source has recorded for the inbox: none of them is read again. */
export async function recordedMessages(db: PgDb, source: string, recipient: string): Promise<Set<string>> {
  const rows = await db.select({ id: mailMessages.messageId }).from(mailMessages).where(and(eq(mailMessages.source, source), eq(mailMessages.recipient, recipient)));
  return new Set(rows.map((r) => r.id));
}

export type MailOutcome = { status: "processed"; reason: "content_changed" | null } | { status: "rejected"; reason: MailReason };

/** Records one message's outcome; a message already recorded keeps its first outcome (read once). */
export async function recordMessage(db: PgDb, source: string, recipient: string, messageId: string, outcome: MailOutcome, now: Date): Promise<void> {
  await db.insert(mailMessages).values({ source, recipient, messageId, status: outcome.status, reason: outcome.reason, checkedAt: now })
    .onConflictDoNothing({ target: [mailMessages.source, mailMessages.recipient, mailMessages.messageId] });
}
