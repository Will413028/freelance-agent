import type { PgDb } from "@/db/pg/client";
import { intakeListings } from "@/modules/listings/public";
import { SourceError, sourceSettings, type SourceSettings } from "@/modules/sources/public";
import { createFetcher, type Fetcher } from "@/platform/fetch";
import { collectMail, type MailEnv } from "./collect-mail";
import { screen, type SourceRun } from "./source-run";

export { INTAKE_SETTINGS, screen, type SourceRun } from "./source-run";

// One source, once: read through its fetcher and write every listing read, each marked with the source's
// own rule (plan D9; the listing query picks). The daily run of step 6 calls this per source and records run_sources.

/** `mailEnv`: the Resend key and inbox for a mail source (default: RESEND_API_KEY, RESEND_INBOX). */
export async function collectSource(db: PgDb, source: string | SourceSettings, now = new Date(), fetcher?: Fetcher, mailEnv?: MailEnv): Promise<SourceRun> {
  const s = typeof source === "string" ? sourceSettings(source) : source;
  if (s.disabled) throw new Error(`${s.name} is disabled: ${s.disabled}`);
  if (s.kind === "mail") return collectMail(db, s, now, { fetcher, env: mailEnv });
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
  // A read is complete when the catalog says one read shows the whole source and this one was neither cut
  // short nor partial: a listing set aside this time is not in the batch but may still be open (plan D9).
  const complete = s.completeRead && collected.truncated !== true && rejected === 0;
  const intake = await intakeListings(db, s.name, collected.listings, "page", now, { sourceKept: (id) => kept.has(id), complete });
  const jobIds = screen(collected.listings.filter((l) => kept.has(l.external_id)), now).map((l) => l.external_id);
  return { source: s.name, seen: collected.seen, stored: collected.listings.length, jobs: jobIds.length, jobIds, requests: f.requests, intake, externalIds: collected.listings.map((l) => l.external_id), truncated: collected.truncated === true, rejected, examined: collected.examined ?? 0 };
}
