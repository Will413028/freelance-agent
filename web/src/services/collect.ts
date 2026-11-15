import type { PgDb } from "@/db/pg/client";
import { CATEGORIES } from "@/db/pg/schema";
import { evaluate, type Settings } from "@/modules/evaluation/public";
import { intakeListings, listingOf, storedExternalIds, type IntakeCounts, type ListingInput } from "@/modules/listings/public";
import { SourceError, sourceSettings, type SourceSettings } from "@/modules/sources/public";
import { createFetcher, type Fetcher } from "@/platform/fetch";

// One source, once: read through its fetcher, keep what intake screening allows, write the listings
// (plan step 4; the daily run of step 6 calls this per source and records run_sources).

/**
 * Intake screening with no personal limits (old qualifyForIntake): only a reason that no setting can
 * undo drops a listing; hours, budget floor and categories belong to the saved view (inventory B2).
 */
export const INTAKE_SETTINGS: Settings = { maxWeeklyHours: null, minFixedTwd: 0, categories: CATEGORIES };

export const screen = (listings: readonly ListingInput[], now: Date) =>
  listings.filter((l) => evaluate(listingOf(l), INTAKE_SETTINGS, now).status !== "excluded");

/**
 * `truncated`: the source stopped at its read cap (old partial); `rejected`: listings the connector set aside,
 * out of `examined` entries checked.
 * Step 6 records both (a run is partial when `truncated || rejected > 0`).
 */
export type SourceRun = { source: string; seen: number; jobs: number; requests: number; intake: IntakeCounts; externalIds: string[]; truncated: boolean; rejected: number; examined: number };

export async function collectSource(db: PgDb, source: string | SourceSettings, now = new Date(), fetcher?: Fetcher): Promise<SourceRun> {
  const s = typeof source === "string" ? sourceSettings(source) : source;
  if (s.disabled) throw new Error(`${s.name} is disabled: ${s.disabled}`);
  const f = fetcher ?? createFetcher(s);
  const collected = await s.connector(f, now);
  const rejected = collected.rejected ?? 0;
  // More than half of the entries checked refused: a format change, not a few bad rows (Will 2026-11-15).
  // The denominator is `examined`, counted at the same level as `rejected`; a connector that sets listings
  // aside without reporting it is a programming error, not a payload problem, so no fallback to `seen`.
  if (rejected > 0 && collected.examined === undefined) throw new Error(`${s.name}: rejected reported without examined`);
  if (rejected * 2 > (collected.examined ?? 0)) throw new SourceError(`${s.name}: ${rejected} of ${collected.examined} listings refused`);
  const kept = screen(collected.listings, now);
  // Sources with the old `exists ||` exception: a stored listing is refreshed even when the rules drop it now.
  const keptIds = new Set(kept.map((l) => l.external_id));
  const dropped = collected.others ? [...collected.others, ...collected.listings.filter((l) => !keptIds.has(l.external_id))] : [];
  const stored = await storedExternalIds(db, s.name, dropped.map((l) => l.external_id));
  const refreshed = dropped.filter((l) => stored.has(l.external_id));
  const intake = await intakeListings(db, s.name, kept, "page", now, refreshed);
  const written = [...kept, ...refreshed];
  return { source: s.name, seen: collected.seen, jobs: written.length, requests: f.requests, intake, externalIds: written.map((l) => l.external_id), truncated: collected.truncated === true, rejected, examined: collected.examined ?? 0 };
}
