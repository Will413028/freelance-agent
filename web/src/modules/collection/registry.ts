import type { Db } from "@/db/client";
import type { PyDict } from "@/platform/py/value";
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
import { syncMailSource } from "./mail/sync";
import { syncNoDesk } from "./sources/nodesk";
import { syncPublicFeed } from "./sources/public-feeds";
import { syncTaiwanJobs } from "./sources/taiwanjobs";
import { REGISTRY, SOURCES } from "./source-catalog";

/** Every connector returns its Python result dict; runSource refuses anything else at run time too. */
export type SourceRunner = (db: Db) => Promise<PyDict>;

/** Every connector. */
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
  tasker: (db) => syncMailSource(db, "tasker"),
  linkedin: (db) => syncMailSource(db, "linkedin"),
  cake: (db) => syncMailSource(db, "cake"),
  jobbank104: (db) => syncMailSource(db, "jobbank104"),
  talent: (db) => syncMailSource(db, "talent"),
  glassdoor: (db) => syncMailSource(db, "glassdoor"),
};

/**
 * The fixed reason each Python sync returns from its `except Exception` (where the TS connector
 * throws instead). Mail sources catch inside syncMail as resend_sync.py does, so they have none.
 */
export const FAILURE_REASON: Readonly<Record<string, string>> = {
  jobicy: "public_feed_unavailable_or_unsupported",
  remotive: "public_feed_unavailable_or_unsupported",
  cryptojobslist: "cryptojobslist_unavailable_or_unsupported",
  himalayas: "public_feed_unavailable_or_unsupported",
  getonboard: "getonboard_unavailable_or_unsupported",
  hackernews: "community_feed_unavailable_or_unsupported",
  v2ex: "community_feed_unavailable_or_unsupported",
  remoteok: "public_feed_unavailable_or_unsupported",
  realworkfromanywhere: "public_feed_unavailable_or_unsupported",
  weworkremotely: "public_feed_unavailable_or_unsupported",
  workingnomads: "public_feed_unavailable_or_unsupported",
  nodesk: "nodesk_unavailable_or_unsupported",
  justremote: "justremote_unavailable_or_unsupported",
  dynamitejobs: "dynamitejobs_unavailable_or_unsupported",
  jobbank518: "jobbank518_unavailable_or_unsupported",
  chickpt: "chickpt_unavailable_or_unsupported",
  taiwanjobs: "taiwanjobs_unavailable_or_unsupported",
  arbeitnow: "arbeitnow_source_unavailable_or_unsupported",
  freelancer: "freelancer_source_failed",
};

/**
 * Sources the daily run fans out to: every catalog entry with a connector and no lasting `disabled`
 * reason, in the catalog's priority order. A switch that can be flipped without a deploy does not
 * exist yet; it is built when a source first has to be turned off faster than a deploy (plan step 14).
 */
export function enabledSources(runners: Record<string, SourceRunner> = RUNNERS): string[] {
  return SOURCES.filter((s) => runners[s] && !REGISTRY[s].disabled).sort((a, b) => REGISTRY[a].order - REGISTRY[b].order);
}
