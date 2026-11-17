import { CATEGORIES } from "@/db/pg/schema";
import { evaluate, type Settings } from "@/modules/evaluation/public";
import { listingOf, type IntakeCounts, type ListingInput } from "@/modules/listings/public";

// What one run of one source did, for page and mail sources alike (services/collect, services/collect-mail).

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
export type SourceRun = { source: string; seen: number; stored: number; jobs: number; jobIds: string[]; requests: number; intake: IntakeCounts; externalIds: string[]; truncated: boolean; rejected: number; examined: number; reread?: number; rereadRejected?: number };
