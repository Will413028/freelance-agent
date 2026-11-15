import { freeJobsConnector } from "./free-jobs";
import type { SourceSettings } from "./types";

// Every source of the new system, one entry each (plan step 4; steps 5, 7 and 8 add theirs following
// docs/plans/2026-11-15-self-hosted-rebuild/connector-checklist.md). Both free boards answer with
// their whole latest list in one request.

export const SOURCES: readonly SourceSettings[] = [
  { name: "remotive", order: 10, connector: freeJobsConnector("remotive"), maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, disabled: null },
  { name: "jobicy", order: 20, connector: freeJobsConnector("jobicy"), maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, disabled: null },
];

export function sourceSettings(name: string): SourceSettings {
  const s = SOURCES.find((x) => x.name === name);
  if (!s) throw new Error(`unknown source ${name}`);
  return s;
}
