import type { PgDb } from "@/db/pg/client";
import { intakeListings, type IntakeCounts, type ListingInput } from "@/modules/listings/public";
import {
  inboxAddress, loadCursor, MailRejection, readMessage, ReceivingClient, recordedMessages, recordMessage, saveCursor, SourceError,
  type MailCursor, type MailSourceSettings,
} from "@/modules/sources/public";
import { createFetcher, FetchError, type Fetcher } from "@/platform/fetch";
import { screen, type SourceRun } from "./source-run";

// One mail source, once (plan step 7; old web/src/modules/collection/mail/sync.ts until step 11): page the
// Resend inbox newest first down to where the last complete scan stopped, read each new message from the
// source's sender whose subject passes the gate, and write its listings in their own transaction (mode
// "mail": a contradicting content becomes a version). Each message is recorded once in mail_messages,
// processed or rejected with a reason code, and never read again; a rejected message never undoes
// another. A read failure (network, timeout, HTTP 429 or 5xx, an unreadable response) stops the scan with
// the position saved and propagates, so the daily run records its kind and retries the transient ones;
// the retry skips what was recorded. Listings are written before their message is recorded: a crash in
// between reads that message again next time, which finds the same fingerprints and changes nothing.
// Message text never leaves this function: only ids, counts and reason codes.

/** Per run: inbox pages listed and message bodies read (old maxPages, maxMessages). */
export const MAIL_LIMITS = { maxPages: 20, maxMessages: 20 } as const;

export type MailEnv = { key: string; inbox: string };

/** The mail source has no Resend key or inbox configured, or the inbox is not a Resend receiving address. */
export class MailConfigError extends Error {
  constructor() {
    super("RESEND_API_KEY and RESEND_INBOX must be set");
    this.name = "MailConfigError";
  }
}

function envFromProcess(): MailEnv {
  const key = process.env.RESEND_API_KEY, inbox = process.env.RESEND_INBOX;
  if (!key || !inbox) throw new MailConfigError();
  return { key, inbox };
}

export type CollectMailOptions = { fetcher?: Fetcher; env?: MailEnv; limits?: { maxPages: number; maxMessages: number } };

export async function collectMail(db: PgDb, s: MailSourceSettings, now: Date, opts: CollectMailOptions = {}): Promise<SourceRun> {
  const env = opts.env ?? envFromProcess();
  const limits = opts.limits ?? MAIL_LIMITS;
  // A full scan (every page plus every body) must fit the source's request cap, so the scan stops as truncated, never on request_limit.
  if (limits.maxPages + limits.maxMessages > s.maxRequestsPerRun) throw new Error(`${s.name}: mail limits exceed maxRequestsPerRun`);
  let inbox: string;
  try {
    inbox = inboxAddress(env.inbox);
  } catch {
    throw new MailConfigError();
  }
  const f = opts.fetcher ?? createFetcher(s);
  const client = new ReceivingClient(f, env.key, s.sender);
  let c: MailCursor = await loadCursor(db, s.name, inbox);
  const intake: IntakeCounts = { inserted: 0, updated: 0, unchanged: 0, versioned: 0 };
  /** Listings written this run by id: two digests can name the same job; the later content counts once. */
  const written = new Map<string, ListingInput>();
  let seen = 0, pages = 0, reads = 0, rejected = 0, complete = false, interrupted = false;

  const handle = async (id: string) => {
    let listings: ListingInput[];
    try {
      let raw: Record<string, unknown>;
      try {
        raw = await client.message(id);
      } catch (e) {
        // A transient failure is retried by the daily run; one message Resend cannot serve readably is
        // rejected and recorded, so it never blocks the newer mail behind it.
        if (e instanceof FetchError && e.transient) throw e;
        if (e instanceof FetchError && e.kind === "too_large") throw new MailRejection("body_too_large");
        if (e instanceof SourceError) throw new MailRejection("unreadable_message");
        throw e;
      }
      listings = s.parse(readMessage(raw, id, s.sender, inbox, s.preferText));
    } catch (e) {
      if (!(e instanceof MailRejection)) throw e;
      await recordMessage(db, s.name, inbox, id, { status: "rejected", reason: e.reason }, now);
      rejected++;
      return;
    }
    const got = await intakeListings(db, s.name, listings, "mail", now);
    for (const k of Object.keys(intake) as (keyof IntakeCounts)[]) intake[k] += got[k];
    for (const l of listings) written.set(l.external_id, l);
    await recordMessage(db, s.name, inbox, id, { status: "processed", reason: got.versioned ? "content_changed" : null }, now);
  };

  try {
    const visited = new Set<string>();
    while (!complete && !interrupted && pages < limits.maxPages) {
      const page = await client.list(c.after);
      pages++;
      if (page.hasMore && !page.entries.length) throw new SourceError("Resend list: empty page before the end");
      const recorded = await recordedMessages(db, s.name, inbox, page.entries.map((e) => e.id));
      for (const e of page.entries) {
        if (e.id === c.cursor) { complete = true; break; }
        if (visited.has(e.id)) throw new SourceError("Resend list: the same message on two pages");
        visited.add(e.id);
        const wanted = !recorded.has(e.id) && e.sender === s.sender && s.subjectGate(e.subject);
        if (wanted && reads >= limits.maxMessages) { interrupted = true; break; }
        c.head ??= e.id;
        seen++;
        if (wanted) {
          reads++;
          await handle(e.id);
        }
        c.after = e.id;
      }
      if (!complete && !interrupted && !page.hasMore) complete = true;
    }
    if (complete) c = { cursor: c.head ?? c.cursor, after: null, head: null };
  } finally {
    await saveCursor(db, s.name, inbox, c);
  }
  // Most messages read this run refused: the template changed, the source failed (same rule as set-aside listings).
  if (rejected * 2 > reads) throw new SourceError(`${s.name}: ${rejected} of ${reads} messages rejected`);
  const jobIds = screen([...written.values()], now).map((l) => l.external_id);
  return {
    source: s.name, seen, stored: written.size, jobs: jobIds.length, jobIds, requests: f.requests, intake,
    externalIds: [...written.keys()], truncated: !complete, rejected, examined: reads,
  };
}
