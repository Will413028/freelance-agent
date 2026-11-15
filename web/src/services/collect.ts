import type { PgDb } from "@/db/pg/client";
import { CATEGORIES } from "@/db/pg/schema";
import { evaluate, type Settings } from "@/modules/evaluation/public";
import { intakeListings, listingOf, type IntakeCounts, type ListingInput } from "@/modules/listings/public";
import { SourceError, sourceSettings, type SourceSettings } from "@/modules/sources/public";
import { createFetcher, type Fetcher } from "@/platform/fetch";

// One source, once: read through its fetcher and write every listing read, each marked with the source's
// own rule (plan D9; the listing query picks). The daily run of step 6 calls this per source and records run_sources.

/**
 * Intake screening with no personal limits (old qualifyForIntake): only a reason that no setting can
 * undo. Since plan D9 it drops nothing from storage; it gives SourceRun.jobs the old meaning, for the
 * comparisons with production, while the listing query reads the stored hard_excluded.
 */
export const INTAKE_SETTINGS: Settings = { maxWeeklyHours: null, minFixedTwd: 0, categories: CATEGORIES };

export const screen = (listings: readonly ListingInput[], now: Date) =>
  listings.filter((l) => evaluate(listingOf(l), INTAKE_SETTINGS, now).status !== "excluded");

/**
 * `truncated`: the source stopped at its read cap (old partial); `rejected`: listings the connector set aside,
 * out of `examined` entries checked. Step 6 records both (a run is partial when `truncated || rejected > 0`).
 * `stored`: every listing written (plan D9: all of them); `jobs`: the ones the source's rule keeps and intake
 * screening allows, the old count the step 4/5 comparisons with production use. `externalIds`: the stored ones; `jobIds`: the ones counted in `jobs`.
 */
export type SourceRun = { source: string; seen: number; stored: number; jobs: number; jobIds: string[]; requests: number; intake: IntakeCounts; externalIds: string[]; truncated: boolean; rejected: number; examined: number };

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
  // The rule runs here, before anything is written: a rule that refuses (SourceError) fails the run with nothing stored.
  const kept = new Set(collected.listings.filter(collected.sourceKept).map((l) => l.external_id));
  // A read is complete when the catalog says one read shows the whole source and this one was not cut short.
  const complete = s.completeRead && collected.truncated !== true;
  const intake = await intakeListings(db, s.name, collected.listings, "page", now, { sourceKept: (id) => kept.has(id), complete });
  const jobIds = screen(collected.listings.filter((l) => kept.has(l.external_id)), now).map((l) => l.external_id);
  return { source: s.name, seen: collected.seen, stored: collected.listings.length, jobs: jobIds.length, jobIds, requests: f.requests, intake, externalIds: collected.listings.map((l) => l.external_id), truncated: collected.truncated === true, rejected, examined: collected.examined ?? 0 };
}
