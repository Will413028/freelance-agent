import { parseJobInput, type JobInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { lastById, nextData, optionalText, requiredText, stringList } from "../shared/embedded";
import { pageHtml, pageRequest } from "../shared/job-pages";
import { isObject } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { epochInstant } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Wellfound (plan step 8b, D3; a new source, no old reader): the public /jobs page and the job listings
// in its Next.js page props (the Apollo cache, `JobListing:<id>` entries, each pointing at its
// `Startup:<id>`). One plain request; job pages are not read, so the description and the employment type
// stay unknown (D8). Spike (spikes.md §2): 200, 48 jobs; the site is known to use DataDome (inferred),
// which answers with a challenge page: that fails the source (shared/job-pages), it is never solved.
//
// Identity is the numeric listing id. A listing is set aside when its id, title or slug is missing. The
// page fails the source when the cache is not there, holds no listing, or more than 200. Places are free text (cities,
// regions such as "Europe"), kept as the location; Taiwan eligibility stays unknown, since an unlisted
// spelling of a place containing Taiwan must not hide the listing (D8). The
// compensation text is evidence only. No rule of its own (sourceKept is always true).

const ORIGIN = "https://wellfound.com";
export const INDEX = ORIGIN + "/jobs";
const MAX_JOBS = 200;
const ID = /^[1-9][0-9]{0,15}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const WELLFOUND_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  name: "wellfound", label: "Wellfound", connector: (fetcher) => wellfoundConnector(fetcher),
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

type Cache = Record<string, unknown>;

/** The page's Apollo cache and its job listings in page order; SourceError when the cache is not there or out of bounds. */
export function parseIndex(raw: Uint8Array): { cache: Cache; jobs: unknown[] } {
  const props = nextData("wellfound", pageHtml("wellfound", raw));
  const cache = isObject(props.apolloState) ? props.apolloState.data : undefined;
  if (!isObject(cache)) throw new SourceError("wellfound: listing cache not found");
  const jobs = Object.entries(cache).filter(([k]) => k.startsWith("JobListing:")).map(([, v]) => v);
  if (!jobs.length) throw new SourceError("wellfound: no job listings on the page");
  if (jobs.length > MAX_JOBS) throw new SourceError("wellfound: more than 200 job listings on the page");
  return { cache, jobs };
}

/** One listing in the contract; SourceError (set aside) when its identity is missing. */
export function normalizeJob(cache: Cache, job: unknown): JobInput {
  if (!isObject(job)) throw new SourceError("wellfound: listing is not an object");
  const id = typeof job.id === "string" || typeof job.id === "number" ? String(job.id).trim() : "";
  if (!ID.test(id)) throw new SourceError("wellfound: listing id required");
  const slug = typeof job.slug === "string" ? job.slug.trim() : "";
  if (!SLUG.test(slug)) throw new SourceError("wellfound: listing slug required");
  const title = requiredText("wellfound", job.title, "title");
  const url = `${ORIGIN}/jobs/${id}-${slug}`;
  const ref = isObject(job.startup) && typeof job.startup.__ref === "string" ? cache[job.startup.__ref] : undefined;
  const company = isObject(ref) ? optionalText(ref.name) : null;
  const places = stringList(job.locationNames);
  const remotePlaces = stringList(job.acceptedRemoteLocationNames);
  const remote = typeof job.remote === "boolean" ? job.remote : null;
  return parseJobInput({
    external_id: id, title, company, url, canonical_url: url,
    location: [...(places ?? []), ...(remote ? (remotePlaces ?? []).map((p) => `Remote: ${p}`) : [])].join("; ") || null,
    compensation_evidence: optionalText(job.compensation),
    complete: false,
    published_at: epochInstant(job.liveStartAt),
    extra: { remote, location_names: places, accepted_remote_locations: remotePlaces, role: isObject(job.primaryRole) ? job.primaryRole.slug ?? null : null },
  });
}

export async function wellfoundConnector(fetcher: Fetcher): Promise<Collected<JobInput>> {
  const { cache, jobs } = parseIndex((await fetcher.get(pageRequest(INDEX))).body);
  const read = setAside(jobs, (job) => normalizeJob(cache, job));
  return { seen: jobs.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}
