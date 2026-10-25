import type { Db } from "@/db/client";
import { syncArbeitnow } from "./sources/arbeitnow";
import { syncChickpt } from "./sources/chickpt";
import { syncCommunity } from "./sources/community-jobs";
import { syncCryptoJobsList } from "./sources/cryptojobslist";
import { syncDynamiteJobs } from "./sources/dynamitejobs";
import { syncFreeJobs } from "./sources/free-jobs";
import { syncFreelancer } from "./sources/freelancer";
import { syncGetOnBoard } from "./sources/getonboard";
import { syncHimalayas } from "./sources/himalayas";
import { syncJobbank518 } from "./sources/jobbank518";
import { syncJustRemote } from "./sources/justremote";
import { syncNoDesk } from "./sources/nodesk";
import { syncPublicFeed } from "./sources/public-feeds";
import { syncTaiwanJobs } from "./sources/taiwanjobs";
import { REGISTRY, SOURCES } from "./source-catalog";

export type SourceRunner = (db: Db) => Promise<unknown>;

/** Every TS connector ported so far (plan steps 6–8), scheduled or not. */
export const RUNNERS: Record<string, SourceRunner> = {
  jobicy: (db) => syncFreeJobs(db, "jobicy"),
  remotive: (db) => syncFreeJobs(db, "remotive"),
  cryptojobslist: (db) => syncCryptoJobsList(db),
  himalayas: (db) => syncHimalayas(db),
  getonboard: (db) => syncGetOnBoard(db),
  hackernews: (db) => syncCommunity(db, "hackernews"),
  v2ex: (db) => syncCommunity(db, "v2ex"),
  remoteok: (db) => syncPublicFeed(db, "remoteok"),
  realworkfromanywhere: (db) => syncPublicFeed(db, "realworkfromanywhere"),
  weworkremotely: (db) => syncPublicFeed(db, "weworkremotely"),
  workingnomads: (db) => syncPublicFeed(db, "workingnomads"),
  nodesk: (db) => syncNoDesk(db),
  justremote: (db) => syncJustRemote(db),
  dynamitejobs: (db) => syncDynamiteJobs(db),
  jobbank518: (db) => syncJobbank518(db),
  chickpt: (db) => syncChickpt(db),
  taiwanjobs: (db) => syncTaiwanJobs(db),
  arbeitnow: (db) => syncArbeitnow(db),
  freelancer: (db) => syncFreelancer(db),
};

/**
 * Release toggle: the sources the shadow schedule runs, exactly the ones whose deploy Will has authorized. Each step or
 * batch ships in its own deploy with its own shadow comparison, so a deploy of main for any other
 * reason must not start a ported source early. Add a source here in the commit that deploys it.
 * Remove this set and enabledSources' scheduled parameter once it equals RUNNERS minus DISABLED (plan step 14).
 */
export const SCHEDULED: ReadonlySet<string> = new Set([
  "jobicy", "remotive", "cryptojobslist", "himalayas", "getonboard", "hackernews", "v2ex", "remoteok", "realworkfromanywhere",
  "weworkremotely", "workingnomads", "nodesk", "justremote", "dynamitejobs", "jobbank518", "chickpt", "taiwanjobs", "arbeitnow",
  "freelancer",
]);

// D12: Vercel's regions get a challenge from PTT; these stay in the catalog for their history only.
export const DISABLED = new Set(["ptt_soho", "ptt_codejob"]);

/**
 * Sources the daily run fans out to (implemented, scheduled, not disabled), in the catalog's priority order. Enablement lives in code until
 * cutover: the shadow database is reloaded from production every morning, so a switch stored there
 * would be overwritten, and Python's discovery_settings contract rejects extra keys.
 */
export function enabledSources(runners: Record<string, SourceRunner> = RUNNERS, scheduled: ReadonlySet<string> | null = SCHEDULED): string[] {
  return SOURCES.filter((s) => runners[s] && (scheduled === null || scheduled.has(s)) && !DISABLED.has(s)).sort((a, b) => REGISTRY[a].order - REGISTRY[b].order);
}
