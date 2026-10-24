import type { Db } from "@/db/client";
import { syncCryptoJobsList } from "./sources/cryptojobslist";
import { syncFreeJobs } from "./sources/free-jobs";
import { REGISTRY, SOURCES } from "./source-catalog";

export type SourceRunner = (db: Db) => Promise<unknown>;

/** TS connectors, added one by one from plan step 6. */
export const RUNNERS: Record<string, SourceRunner> = {
  jobicy: (db) => syncFreeJobs(db, "jobicy"),
  remotive: (db) => syncFreeJobs(db, "remotive"),
  cryptojobslist: (db) => syncCryptoJobsList(db),
};

// D12: Vercel's regions get a challenge from PTT; these stay in the catalog for their history only.
export const DISABLED = new Set(["ptt_soho", "ptt_codejob"]);

/**
 * Sources the daily run fans out to, in the catalog's priority order. Enablement lives in code until
 * cutover: the shadow database is reloaded from production every morning, so a switch stored there
 * would be overwritten, and Python's discovery_settings contract rejects extra keys.
 */
export function enabledSources(runners: Record<string, SourceRunner> = RUNNERS): string[] {
  return SOURCES.filter((s) => runners[s] && !DISABLED.has(s)).sort((a, b) => REGISTRY[a].order - REGISTRY[b].order);
}
