import type { ListingInput } from "@/modules/listings/public";
import type { FetchErrorKind, Fetcher, FetchPolicy } from "@/platform/fetch";

/**
 * What one run of a connector read: how many listings the source showed, every listing read that passed
 * the per-listing contract, and the source's own rule as a mark on each (plan D9: intake stores all, the
 * listing query picks).
 */
export type Collected = {
  seen: number;
  listings: ListingInput[];
  /**
   * The source's own rule for one listing (stored as listings.source_kept). Required, so a connector cannot
   * leave its rule out by omission; a source with no rule of its own passes every listing. May throw
   * `SourceError` when a field the rule reads changed format (a failed source, checklist §2).
   */
  sourceKept: (l: ListingInput) => boolean;
  /** The read stopped at the source's read cap before the source's end (old `partial`): what was read is written, the run records it. */
  truncated?: boolean;
  /**
   * Listings set aside (Will 2026-11-15, step 5a VM run: set aside and count, fail only when too many).
   * A refusal raised while normalizing ONE listing (its own identity or format is bad, including a field the
   * source's own rule reads being unreadable) skips that listing and counts it here; the rest are kept.
   * Batch-level problems still throw `SourceError`: body not decodable, envelope or list missing, too many
   * entries, inconsistent pagination, a listing changing during pagination, conflicting versions of one id,
   * duplicate ids where the old connector refused them, request failures. Counted at the same level as
   * `examined`; when `rejected * 2 > examined` the run fails (services/collect).
   */
  rejected?: number;
  /**
   * The entries checked at the per-listing level (every entry `setAside` ran its normalizer on, kept,
   * skipped by the source's own rule or set aside), summed over every `setAside` call at one consistent
   * level per source: an entry a source shows on several pages or queries counts each time, in both
   * `examined` and `rejected`. The denominator of the set-aside threshold; required whenever `rejected > 0`.
   * Unlike `seen`, which keeps each source's own reporting meaning.
   */
  examined?: number;
};

export type Connector = (fetcher: Fetcher, now: Date) => Promise<Collected>;

/**
 * One notification as a mail parser reads it, after readMessage (mail/message.ts): parsers rely on its
 * envelope checks and body cap. Never logged or stored: only the listings it yields are.
 */
export type MailMessage = { id: string; sender: string; subject: string; body: string; isHtml: boolean; receivedAt: string };

type BaseSettings = FetchPolicy & {
  name: string;
  /** What a page shows for the source. */
  label: string;
  /** Order in the daily run. */
  order: number;
  /**
   * One successful, untruncated read shows every listing the source has (plan D9): a stored listing such
   * a read no longer shows gets gone_at. False for sources read through searches, latest-N feeds or
   * selected threads, where a listing can drop out of the read while still open.
   */
  completeRead: boolean;
  /** Set when the source has a lasting block; the daily run skips it. */
  disabled: string | null;
};

/** A source read from public pages (plan step 4, inventory: one entry per source). */
export type PageSourceSettings = BaseSettings & { kind?: "page"; connector: Connector };

/**
 * A source read from notifications in the Resend inbox (plan step 7): the inbox list is filtered by
 * the one sender address and the subject gate, each new message is parsed on its own and written in
 * its own transaction, and mail_messages records it once (services/collect-mail). Mail has no
 * current state, so completeRead is always false and a contradicting content becomes a version.
 */
export type MailSourceSettings = BaseSettings & {
  kind: "mail";
  sender: string;
  subjectGate: (subject: string) => boolean;
  /** The listings of one message; throws MailRejection naming the check that failed. */
  parse: (message: MailMessage) => ListingInput[];
  /** Read only the text part (a parser of plain-text notifications). */
  preferText: boolean;
  completeRead: false;
};

export type SourceSettings = PageSourceSettings | MailSourceSettings;

/** Why a source run failed, for the source's run row: a read failure kind, or a payload the connector refused. */
export type SourceErrorKind = FetchErrorKind | "bad_payload";

export class SourceError extends Error {
  readonly kind = "bad_payload" as const;
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}
