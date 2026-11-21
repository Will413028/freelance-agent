import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher, FetchRequest } from "@/platform/fetch";
import { codePoints, isObject, truthy } from "../shared/json";
import { boardUrl, employmentTypes, jobPostings, kindOf, pageHtml, PAGE_BYTES, PAGE_TIMEOUT_MS, readDetails, USER_AGENT } from "../shared/job-pages";
import { pyStrip, visibleLines } from "../shared/text";
import { parseIsoTime, pubDateInstant } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Dynamite Jobs (plan step 5c; old collection/dynamitejobs.py and web/src/modules/collection/sources/
// dynamitejobs.ts at ce1254d): the public development category page, then each listed job's page and its
// one schema.org JobPosting; no accounts or private APIs. Read scope (unchanged from the old reader): every
// distinct job link of that one index page, at most 200, so one run is at most 201 requests.
//
// The index page fails the source when it cannot be read, is a challenge, shows no job link or more than
// 200. A link that looks like a job (`/remote-job/` in it) but is not one of the board's job URLs is set
// aside and counted. A job page is set aside when it cannot be read (other than 401/403/429 or a
// challenge, which fail the source; shared/job-pages readDetails) or lacks its identity: exactly one
// JobPosting whose URL is the page's own, a title (at most 500 characters) and description (at most
// 100,000) with text, and the two fields the source's own rule reads: the employment types and an
// ISO 8601 or RFC 2822 publication time with a zone. Location requirements that cannot be read leave the
// location and Taiwan eligibility unknown (plan D8); validThrough becomes a contract deadline shape.
// The source's own rule (stored as source_kept, plan D9): a remote (TELECOMMUTE) contract job published
// in the last 90 days, not in the future.

const ORIGIN = "https://dynamitejobs.com";
const HOST = "dynamitejobs.com";
export const INDEX = ORIGIN + "/category/development";
const ARTICLE = /^\/company\/[a-z0-9-]+\/remote-job\/[a-z0-9-]+$/;
const MAX_LINKS = 200;
const BROAD = new Set(["taiwan", "taiwan, province of china", "asia", "apac", "worldwide", "anywhere", "global"]);
const DAY_MS = 86_400_000;
const FRESH_DAYS = 90;

export const DYNAMITEJOBS_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  name: "dynamitejobs", label: "Dynamite Jobs", connector: (fetcher, now) => dynamiteJobsConnector(fetcher, now),
  // Old pause was 0.6 s; the fetcher's floor is 1 s. One index page plus at most 200 job pages.
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1 + MAX_LINKS, completeRead: false, disabled: null,
};

/** A job's canonical URL on the board (query and fragment dropped), or null when it is not one. */
export const jobUrl = (value: unknown) => boardUrl(ORIGIN, HOST, ARTICLE, value);

/** The distinct job URLs of the index page in order, and how many job-like links were not job URLs. */
export function parseIndex(raw: Uint8Array): { urls: string[]; rejected: number } {
  const $ = load(pageHtml("dynamitejobs", raw), { scriptingEnabled: false });
  const urls = new Set<string>();
  // A card links its job several times (title, logo, apply): a bad link counts once, as a good one does.
  const bad = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href.includes("/remote-job/")) return;
    const url = jobUrl(href);
    if (url === null) bad.add(href);
    else urls.add(url);
  });
  const rejected = bad.size;
  if (!urls.size && !rejected) throw new SourceError("dynamitejobs: no job links on the development page");
  if (urls.size > MAX_LINKS) throw new SourceError("dynamitejobs: more than 200 job links on the development page");
  return { urls: [...urls], rejected };
}

/** Visible text of a JobPosting field; throws SourceError when it is missing, blank, over 200,000 characters or shows nothing. */
function fieldText(value: unknown, what: string): string {
  if (typeof value !== "string" || !pyStrip(value) || codePoints(value) > 200_000) throw new SourceError(`dynamitejobs: ${what} required`);
  const text = visibleLines(value);
  if (!text) throw new SourceError(`dynamitejobs: empty ${what}`);
  return text;
}

/** The names of applicantLocationRequirements (Country or AdministrativeArea), or null when they cannot be read (unknown, D8). */
function locationNames(value: unknown): string[] | null {
  const list = value === undefined ? [] : isObject(value) ? [value] : value;
  if (!Array.isArray(list)) return null;
  const names: string[] = [];
  for (const loc of list) {
    if (!isObject(loc) || (loc["@type"] !== "Country" && loc["@type"] !== "AdministrativeArea")) return null;
    try {
      names.push(fieldText(loc.name, "location name"));
    } catch {
      return null;
    }
  }
  return names;
}

const rfc3339 = (d: Date) => (Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1 && d.getUTCFullYear() <= 9999 ? d.toISOString() : null);

/** validThrough in the contract's deadline shapes; empty or absent is no deadline. */
function deadlineOf(value: unknown): ListingInput["deadline"] {
  if (!truthy(value)) return null;
  if (typeof value !== "string") return { kind: "invalid", text: JSON.stringify(value) };
  const t = parseIsoTime(value);
  if (t === null) {
    const at = pubDateInstant(value);
    return at === null ? { kind: "invalid", text: value } : { kind: "instant", at };
  }
  if (t.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { kind: "date", date: value } : { kind: "invalid", text: value };
  if (t.kind === "naive") return { kind: "no_timezone", text: value };
  const at = rfc3339(t.instant);
  return at === null ? { kind: "invalid", text: value } : { kind: "instant", at };
}

/** One job page in the contract; throws SourceError (set aside) when its identity is missing, AccessChallenge on a challenge. */
export function normalizeArticle(raw: Uint8Array, pageUrl: string): ListingInput {
  const url = jobUrl(pageUrl);
  if (url === null) throw new SourceError("dynamitejobs: not a job URL");
  const jobs = jobPostings("dynamitejobs", pageHtml("dynamitejobs", raw));
  if (jobs.length !== 1) throw new SourceError("dynamitejobs: expected one JobPosting");
  const data = jobs[0];
  if (jobUrl(data.url) !== url) throw new SourceError("dynamitejobs: JobPosting URL is not the page's");
  const title = fieldText(data.title, "title"), description = fieldText(data.description, "description");
  if (codePoints(title) > 500 || codePoints(description) > 100_000) throw new SourceError("dynamitejobs: oversize job");
  // The source's rule reads the employment type and the publication time: unreadable means set aside.
  const types = [...new Set(employmentTypes("dynamitejobs", data.employmentType, true))].sort();
  const published = typeof data.datePosted === "string" ? pubDateInstant(data.datePosted) : null;
  if (published === null) throw new SourceError("dynamitejobs: publication time with a zone required");
  const names = locationNames(data.applicantLocationRequirements);
  // Remote is not worldwide: only a listed requirement naming none of Taiwan or a broad region says no.
  const taiwanEligible = names !== null && names.length > 0 && !names.some((n) => BROAD.has(n.toLowerCase())) ? false : null;
  return parseListingInput({
    external_id: new URL(url).pathname, title, description, url, canonical_url: url,
    location: names?.length ? names.join("; ") : null, kind: kindOf(types), taiwan_eligible: taiwanEligible, complete: false,
    published_at: published, deadline: deadlineOf(data.validThrough),
    extra: { employment_types: types, location_evidence: names, remote_evidence: data.jobLocationType === "TELECOMMUTE" },
  });
}

/** The source's rule: a remote contract job published in the last 90 days, not in the future (old sync's intake filter). */
export function kept(l: ListingInput, now: Date): boolean {
  if (l.kind !== "contract" || l.extra.remote_evidence !== true || l.published_at === null) return false;
  const at = Date.parse(l.published_at);
  return now.getTime() - FRESH_DAYS * DAY_MS <= at && at <= now.getTime();
}

const request = (url: string): FetchRequest => ({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

export async function dynamiteJobsConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const { urls, rejected: badLinks } = parseIndex((await fetcher.get(request(INDEX))).body);
  const details = await readDetails(urls, async (url) => normalizeArticle((await fetcher.get(request(url))).body, url));
  return {
    seen: urls.length, listings: details.listings, sourceKept: (l) => kept(l, now), truncated: details.truncated,
    rejected: badLinks + details.rejected, examined: badLinks + details.examined,
  };
}
