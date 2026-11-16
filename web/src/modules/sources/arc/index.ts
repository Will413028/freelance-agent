import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { eligibleFrom, epochInstant, lastById, nextData, optionalText, pageRequest, requiredText, stringList } from "../shared/embedded";
import { pageHtml } from "../shared/job-pages";
import { isObject } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Arc (plan step 8b, D3; a new source, no old reader): the public remote-jobs page and the jobs its
// Next.js page props carry, Arc's own (`arcJobs`, linked under /remote-jobs/details/) and the ones it
// lists from elsewhere (`externalJobs`, under /remote-jobs/j/). One plain request; job pages are not
// read, so the description stays unknown (D8). Spike (spikes.md §2): 200, 60 jobs on 2026-11-17.
//
// Identity is Arc's `randomKey`, the token that ends each job URL. A job is set aside when its key, title
// or URL slug is missing. The page fails the source when it has no props, neither list, no job at all,
// or more than 200. Required countries (ISO codes) name where the hire must be: a list without Taiwan
// makes Taiwan eligibility false, an empty list leaves it unknown. Pay (Arc's hourly rate for contract
// work, a yearly salary otherwise) is kept as evidence text, not as a budget: the contract's budget has
// no unit. The source has no rule of its own (sourceKept is always true; evaluation judges fit).

const ORIGIN = "https://arc.dev";
export const INDEX = ORIGIN + "/remote-jobs";
const MAX_JOBS = 200;
const KEY = /^[a-z0-9]{6,20}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const ARC_SETTINGS: Omit<PageSourceSettings, "order"> = {
  name: "arc", label: "Arc", connector: (fetcher) => arcConnector(fetcher),
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

type Listed = { job: unknown; external: boolean };

/** The jobs on the page in order, Arc's own first; SourceError when the page data is not there or out of bounds. */
export function parseIndex(raw: Uint8Array): Listed[] {
  const props = nextData("arc", pageHtml("arc", raw));
  const own = props.arcJobs, external = props.externalJobs;
  if (!Array.isArray(own) || !Array.isArray(external)) throw new SourceError("arc: job lists not found");
  const jobs = [...own.map((job) => ({ job, external: false })), ...external.map((job) => ({ job, external: true }))];
  if (!jobs.length) throw new SourceError("arc: no jobs on the page");
  if (jobs.length > MAX_JOBS) throw new SourceError("arc: more than 200 jobs on the page");
  return jobs;
}

const KIND: Record<string, ListingInput["kind"]> = { contract: "contract", permanent: "full_time" };

function pay(job: Record<string, unknown>): string | null {
  const range = (lo: unknown, hi: unknown, unit: string) => {
    const nums = [lo, hi].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return nums.length ? `USD ${[...new Set(nums)].join("–")} ${unit}` : null;
  };
  return range(job.minHourlyRate, job.maxHourlyRate, "per hour") ?? range(job.minAnnualSalary, job.maxAnnualSalary, "per year");
}

/** One job in the contract; SourceError (set aside) when its identity is missing. */
export function normalizeJob({ job, external }: Listed): ListingInput {
  if (!isObject(job)) throw new SourceError("arc: job is not an object");
  const key = typeof job.randomKey === "string" ? job.randomKey.trim() : "";
  if (!KEY.test(key)) throw new SourceError("arc: job key required");
  const slug = typeof job.urlString === "string" ? job.urlString.trim() : "";
  if (!SLUG.test(slug)) throw new SourceError("arc: job URL slug required");
  const title = requiredText("arc", job.title, "title");
  const url = `${ORIGIN}/remote-jobs/${external ? "j" : "details"}/${slug}-${key}`;
  const countries = stringList(job.requiredCountries);
  const company = isObject(job.company) ? optionalText(job.company.name) : null;
  const evidence = pay(job);
  const categories = Array.isArray(job.categories) ? job.categories.flatMap((c) => (isObject(c) && typeof c.name === "string" ? [c.name] : [])) : null;
  return parseListingInput({
    external_id: key, title, company, url, canonical_url: url,
    location: countries?.length ? countries.join(", ") : null,
    kind: typeof job.jobType === "string" ? KIND[job.jobType] ?? null : null,
    currency: evidence ? "USD" : null, compensation_evidence: evidence,
    taiwan_eligible: eligibleFrom(countries), complete: false,
    published_at: epochInstant(job.postedAt),
    extra: { listed_by: external ? "external" : "arc", job_type: job.jobType ?? null, required_countries: countries, categories },
  });
}

export async function arcConnector(fetcher: Fetcher): Promise<Collected> {
  const jobs = parseIndex((await fetcher.get(pageRequest(INDEX))).body);
  const read = setAside(jobs, normalizeJob);
  return { seen: jobs.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}
