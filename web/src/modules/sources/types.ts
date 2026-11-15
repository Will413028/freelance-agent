import type { ListingInput } from "@/modules/listings/public";
import type { FetchErrorKind, Fetcher, FetchPolicy } from "@/platform/fetch";

/** What one run of a connector read: how many listings the source showed and the ones its own rules keep. */
export type Collected = {
  seen: number;
  listings: ListingInput[];
  /**
   * Set only by sources whose old connector updated stored listings whatever their rules said (`exists ||`):
   * the listings read but not kept by the source's own rule. Intake refreshes the stored ones among
   * these and among the screened-out listings, and never inserts them (Will 2026-11-15, step 5a).
   */
  others?: ListingInput[];
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

/** A source as configured (plan step 4, inventory: one entry per source). */
export type SourceSettings = FetchPolicy & {
  name: string;
  /** Order in the daily run. */
  order: number;
  connector: Connector;
  /** Set when the source has a lasting block; the daily run skips it. */
  disabled: string | null;
};

/** Why a source run failed, for the source's run row: a read failure kind, or a payload the connector refused. */
export type SourceErrorKind = FetchErrorKind | "bad_payload";

export class SourceError extends Error {
  readonly kind = "bad_payload" as const;
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}
