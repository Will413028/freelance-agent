import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { lastById, nextData, optionalText, requiredText, stringList } from "../shared/embedded";
import { pageHtml, pageRequest } from "../shared/job-pages";
import { isObject } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { awareInstant } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Remote.co (plan step 8c, D3; a new source, no old reader): the first page of the public /remote-jobs
// list, newest first, read from the Next.js page props (`jobCardData.jobs.results`). One request at tier
// 2 (`browser_like`): a plain request has its connection reset (spikes.md §2, Akamai). Spike: 52 jobs;
// on 2026-11-17 the page held 50, so this is a latest-50 window. Job pages are not read; the list carries
// a summary of a few sentences, kept as the description of an incomplete listing.
//
// Identity is the job's `id` (a UUID). A job is set aside when its id, title or slug is missing or
// malformed. The page fails the source when the props, the job list or any job is missing, or it holds
// more than 200. Places come as free text ("US National", "Houston, TX") and country names, never codes,
// so Taiwan eligibility stays unknown (remote is not worldwide, AGENTS.md). Pay is a text range
// ("70,000.00 - 80,000.00 USD Annually") kept as evidence; the budget fields stay unknown. Kind is
// full_time only for an employee job on a full-time schedule without a part-time one; freelance and temporary stay unknown, since
// the page does not say hourly or fixed. No rule of its own.

const ORIGIN = "https://remote.co";
export const INDEX = ORIGIN + "/remote-jobs";
const MAX_JOBS = 200;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A slug only builds the link (the id is the identity): any one path segment of letters, digits, `-`, `_`, `.`, not dots alone. */
const SLUG = /^(?!\.+$)[A-Za-z0-9._-]+$/;

export const REMOTECO_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  name: "remoteco", label: "Remote.co", connector: (fetcher) => remoteCoConnector(fetcher),
  maxTier: "browser_like", minIntervalMs: 1_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

/** The jobs of the page in order; SourceError when the list is not there or out of bounds. */
export function parseIndex(raw: Uint8Array): unknown[] {
  const props = nextData("remoteco", pageHtml("remoteco", raw));
  const card = props.jobCardData;
  const jobs = isObject(card) && isObject(card.jobs) ? card.jobs.results : undefined;
  if (!Array.isArray(jobs)) throw new SourceError("remoteco: job list not found");
  if (!jobs.length) throw new SourceError("remoteco: no jobs on the page");
  if (jobs.length > MAX_JOBS) throw new SourceError("remoteco: more than 200 jobs on the page");
  return jobs;
}

const names = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.flatMap((c) => (isObject(c) && typeof c.name === "string" && c.name.trim() ? [c.name.trim()] : [])) : null;

/** One job in the contract; SourceError (set aside) when its identity is missing. */
export function normalizeJob(job: unknown): ListingInput {
  if (!isObject(job)) throw new SourceError("remoteco: job is not an object");
  const id = typeof job.id === "string" ? job.id.trim().toLowerCase() : "";
  if (!ID.test(id)) throw new SourceError("remoteco: job id required");
  const slug = typeof job.slug === "string" ? job.slug.trim() : "";
  if (!SLUG.test(slug)) throw new SourceError("remoteco: job slug required");
  const title = requiredText("remoteco", job.title, "title");
  const url = `${ORIGIN}/job-details/${slug}`;
  const places = stringList(job.allowedCandidateLocation);
  const types = stringList(job.jobTypes), schedules = stringList(job.jobSchedules);
  const fullTime = types?.length === 1 && types[0] === "Employee" && schedules?.includes("Full-Time") && !schedules.includes("Part-Time");
  return parseListingInput({
    external_id: id, title, url, canonical_url: url,
    company: isObject(job.company) ? optionalText(job.company.name) : null,
    description: optionalText(job.description) ?? optionalText(job.jobSummary),
    location: places?.length ? places.join("; ") : null,
    kind: fullTime ? "full_time" : null, compensation_evidence: optionalText(job.salaryRange),
    taiwan_eligible: null, complete: false,
    published_at: awareInstant(job.postedDate),
    extra: {
      job_types: types, schedules, remote_options: stringList(job.remoteOptions), countries: stringList(job.countries),
      categories: names(job.jobCategories), expires_at: awareInstant(job.expireOn),
    },
  });
}

export async function remoteCoConnector(fetcher: Fetcher): Promise<Collected> {
  const jobs = parseIndex((await fetcher.get(pageRequest(INDEX))).body);
  const read = setAside(jobs, normalizeJob);
  return { seen: jobs.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}
