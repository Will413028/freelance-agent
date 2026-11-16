import { parseLegacyIsoTime, parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { eligibleFromCodes, flightValue, lastById, lookup, optionalText, requiredText } from "../shared/embedded";
import { pageHtml, pageRequest } from "../shared/job-pages";
import { isObject } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { awareInstant } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Remote.com Jobs (plan step 8b, D3; a new source, no old reader): the first page of the public
// /jobs/all list, newest first, read from the `jobsData` object in the page's Next.js server-component
// stream. One plain request; job pages are not read, so the description stays unknown (D8). Spike
// (spikes.md §2): 200, 20 jobs per page; the board holds thousands, so this is a latest-20 window.
//
// Identity is the job's path, /jobs/<company slug>/<job slug>, the page's own link. A job is set aside
// when a slug or the title is missing or a slug is malformed. The page fails the source when `jobsData`
// is missing, not one object, has no job list, an empty one, or more than 200. Hiring locations of type
// `location` name the countries or regions the hire must be in: a list of countries only, none with
// alpha-2 code TW, makes Taiwan eligibility false; a region (free text such as "Europe"), `global` and
// anything else stay unknown (remote is not worldwide, AGENTS.md). Compensation amounts come in minor units (inferred, not documented: on
// 2026-11-17 a yearly VND salary read 57,500,000,000 and a monthly MXN one 1,600,000), so the evidence
// text divides by 100 and says so; the budget fields stay unknown. No rule of its own.

const ORIGIN = "https://remote.com";
export const INDEX = ORIGIN + "/jobs/all";
const MAX_JOBS = 200;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const REMOTECOM_SETTINGS: Omit<PageSourceSettings, "order"> = {
  name: "remotecom", label: "Remote.com Jobs", connector: (fetcher) => remoteComConnector(fetcher),
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

/** The jobs of the page in order; SourceError when the list is not there or out of bounds. */
export function parseIndex(raw: Uint8Array): unknown[] {
  const data = flightValue("remotecom", pageHtml("remotecom", raw), "jobsData");
  if (!Array.isArray(data.jobs)) throw new SourceError("remotecom: job list not found");
  if (!data.jobs.length) throw new SourceError("remotecom: no jobs on the page");
  if (data.jobs.length > MAX_JOBS) throw new SourceError("remotecom: more than 200 jobs on the page");
  return data.jobs;
}

const KIND: Record<string, ListingInput["kind"]> = { full_time: "full_time", contractor: "contract", part_time: "contract" };

/**
 * The place names of a `location` hiring requirement, and the countries' alpha-2 codes when every place
 * is a country with one (else null); null altogether when it is another type or unreadable.
 */
function hiringPlaces(value: unknown): { names: string[]; codes: string[] | null } | null {
  if (!isObject(value) || value.type !== "location" || !Array.isArray(value.includedLocations)) return null;
  const names: string[] = [];
  let codes: string[] | null = [];
  for (const loc of value.includedLocations) {
    if (!isObject(loc) || (loc.type !== "country" && loc.type !== "region") || !isObject(loc.value)) return null;
    const name = optionalText(loc.value.name);
    if (name === null) return null;
    names.push(name);
    const code = loc.type === "country" ? optionalText(loc.value.alpha2Code) : null;
    codes = codes !== null && code !== null ? [...codes, code] : null;
  }
  return { names, codes };
}

function payEvidence(value: unknown): string | null {
  if (!isObject(value) || !isObject(value.currency) || typeof value.currency.code !== "string") return null;
  const amounts = [value.minimum, value.maximum].filter((v): v is number => typeof v === "number" && Number.isFinite(v)).map((v) => v / 100);
  if (!amounts.length) return null;
  const per = typeof value.frequency === "string" ? ` ${value.frequency}` : "";
  return `${value.currency.code} ${[...new Set(amounts)].join("–")}${per} (listed in minor units, divided by 100)`;
}

/** The deadline in the contract's shapes; absent is none. */
function deadlineOf(value: unknown): ListingInput["deadline"] {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return { kind: "invalid", text: JSON.stringify(value) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parseLegacyIsoTime(value) ? { kind: "date", date: value } : { kind: "invalid", text: value };
  const at = awareInstant(value);
  if (at !== null) return { kind: "instant", at };
  return parseLegacyIsoTime(value)?.kind === "naive" ? { kind: "no_timezone", text: value } : { kind: "invalid", text: value };
}

/** One job in the contract; SourceError (set aside) when its identity is missing. */
export function normalizeJob(job: unknown): ListingInput {
  if (!isObject(job)) throw new SourceError("remotecom: job is not an object");
  const company = isObject(job.companyProfile) ? job.companyProfile : {};
  const companySlug = typeof company.slug === "string" ? company.slug.trim() : "";
  const slug = typeof job.slug === "string" ? job.slug.trim() : "";
  if (!SLUG.test(companySlug) || !SLUG.test(slug)) throw new SourceError("remotecom: job slugs required");
  const title = requiredText("remotecom", job.title, "title");
  const path = `/jobs/${companySlug}/${slug}`;
  const url = ORIGIN + path;
  const places = hiringPlaces(job.hiringLocation);
  const workplace = isObject(job.workplaceLocation) && typeof job.workplaceLocation.type === "string" ? job.workplaceLocation.type : null;
  const hiring = isObject(job.hiringLocation) && typeof job.hiringLocation.type === "string" ? job.hiringLocation.type : null;
  return parseListingInput({
    external_id: path, title, company: optionalText(company.name), url, canonical_url: url,
    location: places?.names.length ? places.names.join(", ") : hiring === "global" ? "Global (as listed)" : null,
    kind: lookup(KIND, job.employmentType),
    compensation_evidence: payEvidence(job.compensation),
    taiwan_eligible: eligibleFromCodes(places?.codes ?? null), complete: false,
    listing_closed: job.status === "published" ? false : null,
    published_at: awareInstant(job.publishedAt), deadline: deadlineOf(job.deadline),
    extra: { employment_type: job.employmentType ?? null, workplace, hiring_location_type: hiring, hiring_places: places?.names ?? null, compensation: job.compensation ?? null },
  });
}

export async function remoteComConnector(fetcher: Fetcher): Promise<Collected> {
  const jobs = parseIndex((await fetcher.get(pageRequest(INDEX))).body);
  const read = setAside(jobs, normalizeJob);
  return { seen: jobs.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}
