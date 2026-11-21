import { load } from "cheerio";
import type { JobInput } from "@/modules/listings/public";
import { ZodError } from "zod";
import { FetchError, type FetchRequest } from "@/platform/fetch";
import { isObject } from "./json";
import { SourceError } from "../types";

// What the public-page sources of plan step 5c (nodesk, justremote, dynamitejobs, jobbank518, chickpt)
// share (old web/src/modules/collection/sources/job-pages.ts at ce1254d): the page checks, the
// JobPosting metadata reader, the employment mapping, the board-URL check and how a failed detail page
// is handled. Sources import this, never each other.

export const USER_AGENT = "side-income/0.1 personal-job-discovery";
/** Old PAGE_LIMIT: an index or detail page over 2 MB fails its read. */
export const PAGE_BYTES = 2_000_000;
/** Old urlopen timeout (10 s per page); the old whole-source budget is not carried (checklist §2). */
export const PAGE_TIMEOUT_MS = 10_000;

/** One plain GET of a board page with the page limits above (plan step 8b; older page sources build the same object inline). */
export const pageRequest = (url: string): FetchRequest => ({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

/**
 * Tier 3 budget for one rendered page (plan step 8d-3): a cold browser launch plus the render. 8d-2 measured
 * 2.6–4.9 s per render from the VM; 60 s leaves the service 55 s (serviceBudget) and still bounds the run.
 */
export const RENDER_TIMEOUT_MS = 60_000;

/** One render of a board page by the browser tier, read once `waitFor` shows (no headers: the fingerprint sets them). */
export const renderRequest = (url: string, waitFor: string): FetchRequest => ({ url, maxBytes: PAGE_BYTES, timeoutMs: RENDER_TIMEOUT_MS, waitFor });

/** A page answered with an access challenge: the whole source fails (old AccessBlocked stopped the fetch). */
export class AccessChallenge extends SourceError {}

// captcha-delivery.com: DataDome's interstitial (Wellfound is known to use it, plan step 8b);
// sec-if-cpt-container: Akamai's behavioural challenge (Remote.co answered a Chrome fingerprint with it, step 8c).
const CHALLENGE = /cf-chl-|_Incapsula_Resource|captcha-container|captcha-delivery\.com|sec-if-cpt-container|<title>\s*(?:Just a moment|Access denied)/i;

/** A page's HTML: empty or over 2 MB, not UTF-8, or an access challenge refuses it (old pageText). */
export function pageHtml(name: string, raw: Uint8Array): string {
  if (!raw.length || raw.length > PAGE_BYTES) throw new SourceError(`${name}: invalid page size`);
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new SourceError(`${name}: page is not UTF-8`);
  }
  if (CHALLENGE.test(html)) throw new AccessChallenge(`${name}: access challenge`);
  return html;
}

/**
 * The JobPosting objects of the page's application/ld+json scripts (old nodesk.Metadata); a script
 * that is not JSON refuses the page. Python's json also read NaN and Infinity; JSON.parse does not, so
 * such a page is refused (accepted: boards send standard JSON).
 */
export function jobPostings(name: string, html: string): Record<string, unknown>[] {
  const $ = load(html, { scriptingEnabled: false });
  const jobs: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let value: unknown;
    try {
      value = JSON.parse($(el).text());
    } catch {
      throw new SourceError(`${name}: page metadata is not JSON`);
    }
    if (isObject(value) && value["@type"] === "JobPosting") jobs.push(value);
  });
  return jobs;
}

/** The kind every page source derives from schema.org employmentType. */
export const kindOf = (types: readonly string[]): JobInput["kind"] =>
  types.includes("FULL_TIME") ? "full_time" : types.some((t) => t === "PART_TIME" || t === "CONTRACTOR" || t === "TEMPORARY") ? "contract" : null;

/** employmentType as the sources accept it: text becomes [text]; otherwise a list of text (non-empty when `nonEmpty`). */
export function employmentTypes(name: string, value: unknown, nonEmpty: boolean): string[] {
  const types = typeof value === "string" ? [value] : value;
  if (!Array.isArray(types) || (nonEmpty && !types.length) || types.some((t) => typeof t !== "string")) throw new SourceError(`${name}: invalid employment types`);
  return types as string[];
}

/**
 * A board's job URL, `https://<host><path>` without query or fragment, or null when it is not one: the
 * value is resolved against the board's origin with the standard URL parser (plan D10), so a relative
 * link, the host's case, a default port or surrounding spaces name the same job; the path must match
 * `article` whole (old canonicalOn).
 */
export function boardUrl(origin: string, host: string, article: RegExp, value: unknown): string | null {
  if (typeof value !== "string" || /[\\\t\r\n]/.test(value.trim()) || !URL.canParse(value, origin)) return null;
  const u = new URL(value, origin);
  if (u.protocol !== "https:" || u.host !== host || u.username || u.password || !article.test(u.pathname)) return null;
  return `https://${host}${u.pathname}`;
}

/**
 * Reads each detail page in order and normalizes it (old fetch loops). One listing's page that cannot be
 * read or normalized is set aside and counted: an HTTP error other than 401/403/429, a network failure,
 * a timeout, an oversize page, or the connector's own refusal. An access challenge or HTTP 401/403/429
 * fails the whole source (old rejectsDetail). Reaching the source's request cap stops the read and marks
 * it truncated; what was read is kept.
 */
export async function readDetails<T>(items: readonly T[], read: (item: T) => Promise<JobInput>): Promise<{ listings: JobInput[]; rejected: number; examined: number; truncated: boolean }> {
  const listings: JobInput[] = [];
  let rejected = 0, examined = 0;
  for (const item of items) {
    try {
      const listing = await read(item);
      examined++;
      listings.push(listing);
    } catch (e) {
      if (e instanceof FetchError) {
        if (e.kind === "request_limit") return { listings, rejected, examined, truncated: true };
        if (e.kind === "http_status" && [401, 403, 429].includes(e.status ?? 0)) throw e;
      } else if (e instanceof AccessChallenge || !(e instanceof SourceError || e instanceof ZodError)) throw e;
      examined++;
      rejected++;
    }
  }
  return { listings, rejected, examined, truncated: false };
}
