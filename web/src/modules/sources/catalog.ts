import { ARBEITNOW_SETTINGS } from "./arbeitnow";
import { HACKERNEWS_SETTINGS, V2EX_SETTINGS } from "./community-jobs";
import { CRYPTOJOBSLIST_SETTINGS } from "./cryptojobslist";
import { freeJobsConnector } from "./free-jobs";
import { FREELANCER_SETTINGS } from "./freelancer";
import { GETONBOARD_SETTINGS } from "./getonboard";
import { HIMALAYAS_SETTINGS } from "./himalayas";
import { TAIWANJOBS_SETTINGS } from "./taiwanjobs";
import type { SourceSettings } from "./types";

// Every source of the new system, one entry each (plan step 4; steps 5, 7 and 8 add theirs following
// docs/plans/2026-11-15-self-hosted-rebuild/connector-checklist.md). Both free boards answer with
// their whole latest list in one request. Every source keeps the old daily order (collection/source-catalog.ts) times ten;
// each connector's settings cite the old request count and pause. completeRead (plan D9): only sources
// whose one read pages through the whole board to its end (arbeitnow; getonboard reads a remote-only
// search, so a listing can leave the read while still open); the free boards
// (limit/count 200) and taiwanjobs (count=1000) answer a latest-N window, where an open listing can drop out.

export const SOURCES: readonly SourceSettings[] = [
  { name: "remotive", label: "Remotive", order: 70, connector: freeJobsConnector("remotive"), maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null },
  { name: "jobicy", label: "Jobicy", order: 60, connector: freeJobsConnector("jobicy"), maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null },
  { ...FREELANCER_SETTINGS, order: 50 },
  { ...HIMALAYAS_SETTINGS, order: 80 },
  { ...HACKERNEWS_SETTINGS, order: 90 },
  { ...V2EX_SETTINGS, order: 100 },
  { ...TAIWANJOBS_SETTINGS, order: 170 },
  { ...ARBEITNOW_SETTINGS, order: 180 },
  { ...GETONBOARD_SETTINGS, order: 200 },
  { ...CRYPTOJOBSLIST_SETTINGS, order: 220 },
];

export function sourceSettings(name: string): SourceSettings {
  const s = SOURCES.find((x) => x.name === name);
  if (!s) throw new Error(`unknown source ${name}`);
  return s;
}

/** The label a page shows for a source name; the name itself for a source not in the catalog. */
export const sourceLabel = (name: string): string => SOURCES.find((s) => s.name === name)?.label ?? name;
