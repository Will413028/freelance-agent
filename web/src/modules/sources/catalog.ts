import { ARBEITNOW_SETTINGS } from "./arbeitnow";
import { ARC_SETTINGS } from "./arc";
import { HACKERNEWS_SETTINGS, V2EX_SETTINGS } from "./community-jobs";
import { CHICKPT_SETTINGS } from "./chickpt";
import { CRYPTOJOBSLIST_SETTINGS } from "./cryptojobslist";
import { DYNAMITEJOBS_SETTINGS } from "./dynamitejobs";
import { freeJobsConnector } from "./free-jobs";
import { FREELANCER_SETTINGS } from "./freelancer";
import { GETONBOARD_SETTINGS } from "./getonboard";
import { HIMALAYAS_SETTINGS } from "./himalayas";
import { JOBBANK518_SETTINGS } from "./jobbank518";
import { JUSTREMOTE_SETTINGS } from "./justremote";
import { JOBBANK104_SETTINGS } from "./mail/jobbank104";
import { NODESK_SETTINGS } from "./nodesk";
import { PTT_CODEJOB_SETTINGS, PTT_SOHO_SETTINGS } from "./ptt";
import { REMOTECOM_SETTINGS } from "./remotecom";
import { REALWORKFROMANYWHERE_SETTINGS, REMOTEOK_SETTINGS, WEWORKREMOTELY_SETTINGS, WORKINGNOMADS_SETTINGS } from "./public-feeds";
import { TAIWANJOBS_SETTINGS } from "./taiwanjobs";
import type { SourceSettings } from "./types";
import { WEB3CAREER_SETTINGS } from "./web3career";
import { WELLFOUND_SETTINGS } from "./wellfound";
import { YCJOBS_SETTINGS } from "./ycjobs";

// Every source of the new system, one entry each (plan step 4; steps 5, 7 and 8 add theirs following
// docs/plans/2026-11-15-self-hosted-rebuild/connector-checklist.md). Both free boards answer with
// their whole latest list in one request. Every source keeps the old daily order (collection/source-catalog.ts) times ten;
// each connector's settings cite the old request count and pause. completeRead (plan D9): only sources
// whose one read pages through the whole board to its end (arbeitnow; getonboard reads a remote-only
// search, so a listing can leave the read while still open); the free boards
// (limit/count 200), the public feeds (latest 200 entries), taiwanjobs (count=1000) and the page sources
// (an index's first page or feed, plan step 5c) answer a latest-N window, where an open listing can drop out.

export const SOURCES: readonly SourceSettings[] = [
  { ...JOBBANK104_SETTINGS, order: 30 },
  { name: "remotive", label: "Remotive", order: 70, connector: freeJobsConnector("remotive"), maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null },
  { name: "jobicy", label: "Jobicy", order: 60, connector: freeJobsConnector("jobicy"), maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null },
  { ...FREELANCER_SETTINGS, order: 50 },
  { ...HIMALAYAS_SETTINGS, order: 80 },
  { ...HACKERNEWS_SETTINGS, order: 90 },
  { ...V2EX_SETTINGS, order: 100 },
  { ...PTT_SOHO_SETTINGS, order: 110 },
  { ...PTT_CODEJOB_SETTINGS, order: 120 },
  { ...REMOTEOK_SETTINGS, order: 130 },
  { ...REALWORKFROMANYWHERE_SETTINGS, order: 140 },
  { ...WEWORKREMOTELY_SETTINGS, order: 150 },
  { ...WORKINGNOMADS_SETTINGS, order: 160 },
  { ...TAIWANJOBS_SETTINGS, order: 170 },
  { ...ARBEITNOW_SETTINGS, order: 180 },
  { ...NODESK_SETTINGS, order: 190 },
  { ...GETONBOARD_SETTINGS, order: 200 },
  { ...JUSTREMOTE_SETTINGS, order: 210 },
  { ...CRYPTOJOBSLIST_SETTINGS, order: 220 },
  { ...DYNAMITEJOBS_SETTINGS, order: 230 },
  { ...JOBBANK518_SETTINGS, order: 240 },
  { ...CHICKPT_SETTINGS, order: 250 },
  // Plan step 8b: new sources (no old order), each one plain request for its latest page (latest-N window).
  { ...ARC_SETTINGS, order: 260 },
  { ...WEB3CAREER_SETTINGS, order: 270 },
  { ...WELLFOUND_SETTINGS, order: 280 },
  { ...REMOTECOM_SETTINGS, order: 290 },
  { ...YCJOBS_SETTINGS, order: 300 },
];

export function sourceSettings(name: string): SourceSettings {
  const s = SOURCES.find((x) => x.name === name);
  if (!s) throw new Error(`unknown source ${name}`);
  return s;
}

/** The label a page shows for a source name; the name itself for a source not in the catalog. */
export const sourceLabel = (name: string): string => SOURCES.find((s) => s.name === name)?.label ?? name;
