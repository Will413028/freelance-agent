import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { inertiaPage, lastById, lookup, optionalText, requiredText } from "../shared/embedded";
import { pageHtml, pageRequest } from "../shared/job-pages";
import { isObject } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// YC Jobs (plan step 8b, D3; a new source, no old reader): the public ycombinator.com/jobs page and the
// `jobPostings` of its Inertia page data, the latest 20 jobs at YC companies. One plain request; job
// pages are not read, so the description stays unknown (D8). Spike (spikes.md §2): 200, 20 jobs.
//
// Identity is YC's numeric job id. A job is set aside when its id, title or job path is missing or the
// path is not a YC company job path. The page fails the source when the data has no job list, an empty
// one, or more than 200. The page gives the age only as words ("4 months"), so the publication time stays
// unknown and the words are kept in `extra`. The location is free text (a city, "Remote (US)"): Taiwan
// eligibility stays unknown, and so does the visa line's meaning for it. Salary text is evidence only.
// No rule of its own.

const ORIGIN = "https://www.ycombinator.com";
export const INDEX = ORIGIN + "/jobs";
const MAX_JOBS = 200;
const PATH = /^\/companies\/[a-z0-9][a-z0-9-]*\/jobs\/[A-Za-z0-9]+(?:-[A-Za-z0-9-]*)?$/;

export const YCJOBS_SETTINGS: Omit<PageSourceSettings, "order"> = {
  name: "ycjobs", label: "YC Jobs", connector: (fetcher) => ycJobsConnector(fetcher),
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

/** The jobs of the page in order; SourceError when the list is not there or out of bounds. */
export function parseIndex(raw: Uint8Array): unknown[] {
  const props = inertiaPage("ycjobs", pageHtml("ycjobs", raw));
  if (!Array.isArray(props.jobPostings)) throw new SourceError("ycjobs: job list not found");
  if (!props.jobPostings.length) throw new SourceError("ycjobs: no jobs on the page");
  if (props.jobPostings.length > MAX_JOBS) throw new SourceError("ycjobs: more than 200 jobs on the page");
  return props.jobPostings;
}

const KIND: Record<string, ListingInput["kind"]> = { "full-time": "full_time", contract: "contract", "part-time": "contract" };

/** One job in the contract; SourceError (set aside) when its identity is missing. */
export function normalizeJob(job: unknown): ListingInput {
  if (!isObject(job)) throw new SourceError("ycjobs: job is not an object");
  if (typeof job.id !== "number" || !Number.isSafeInteger(job.id) || job.id <= 0) throw new SourceError("ycjobs: job id required");
  const path = typeof job.url === "string" ? job.url.trim() : "";
  if (!PATH.test(path)) throw new SourceError("ycjobs: job path required");
  const title = requiredText("ycjobs", job.title, "title");
  const url = ORIGIN + path;
  const type = typeof job.type === "string" ? job.type.trim().toLowerCase() : null;
  return parseListingInput({
    external_id: String(job.id), title, company: optionalText(job.companyName), url, canonical_url: url,
    location: optionalText(job.location), kind: lookup(KIND, type),
    compensation_evidence: optionalText(job.salaryRange), complete: false,
    extra: {
      type: job.type ?? null, role: job.prettyRole ?? null, created_ago: optionalText(job.createdAt), visa: optionalText(job.visa),
      min_experience: optionalText(job.minExperience), company_batch: optionalText(job.companyBatchName),
    },
  });
}

export async function ycJobsConnector(fetcher: Fetcher): Promise<Collected> {
  const jobs = parseIndex((await fetcher.get(pageRequest(INDEX))).body);
  const read = setAside(jobs, normalizeJob);
  return { seen: jobs.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}
