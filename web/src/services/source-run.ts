import type { IntakeCounts } from "@/modules/listings/public";

// What one run of one source did, for page and mail sources alike (services/collect, services/collect-mail).

/**
 * `truncated`: the source stopped at its read cap (old partial); `rejected`: listings the connector set aside,
 * out of `examined` entries checked. Step 6 records both (a run is partial when `truncated || rejected > 0`).
 * `stored`: every listing written (plan D9: all of them); `externalIds`: the stored ones.
 */
export type SourceRun = { source: string; seen: number; stored: number; requests: number; intake: IntakeCounts; externalIds: string[]; truncated: boolean; rejected: number; examined: number; reread?: number; rereadRejected?: number };
