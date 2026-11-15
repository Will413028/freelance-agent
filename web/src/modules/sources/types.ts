import type { ListingInput } from "@/modules/listings/public";
import type { FetchErrorKind, Fetcher, FetchPolicy } from "@/platform/fetch";

/** What one run of a connector read: how many listings the source showed and the ones its own rules keep. */
export type Collected = { seen: number; listings: ListingInput[] };

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
