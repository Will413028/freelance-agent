import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { boardUrl, employmentTypes, kindOf, pageHtml, PAGE_BYTES, PAGE_TIMEOUT_MS, readDetails, USER_AGENT } from "../shared/job-pages";
import { codePoints, isObject, truthy } from "../shared/json";
import { pyStrip, visibleLines } from "../shared/text";
import { pubDateInstant } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// 518 熊班's public part-time search in four software categories (plan step 5c; old
// collection/jobbank518.py, web/src/modules/collection/sources/jobbank518.ts at ce1254d). No login,
// application or private API. One request reads the first index page; each job link on it (at most
// 200, the old read scope) is read from its detail page. An index page that is not the confirmed
// search, is ambiguous about being empty, or lists over 200 jobs fails the source. A detail page
// without exactly one JobPosting naming its own URL, a title and description with text within 500 and
// 100,000 characters, or a readable employment type (the source's rule reads it) is set aside and
// counted; an access challenge or HTTP 401/403/429 fails the source (shared/job-pages readDetails).
//
// Times: 518 sends datePosted as a bare date with no zone. The old rule was "don't invent midnight
// UTC", so a date-only value is no instant: published_at is unknown and the date is kept in
// extra.posted_date. A value with a zone is converted. validThrough keeps the contract's four shapes.
//
// The source's rule (old intake filter, plan D9: now sourceKept): a contract-kind job whose 職務類別
// names one of the four software categories. The old qualifyForIntake term is evaluation's (checklist §2).

const NAME = "jobbank518";
const ORIGIN = "https://www.518.com.tw";
const HOST = "www.518.com.tw";
export const INDEX = ORIGIN + "/job-index-P-1.html?ai=2&ab=2032001005,2032001003,2032001016,2032001018";
export const CATEGORIES = ["軟體設計工程師", "Internet程式設計師", "APP工程師", "AI工程師"] as const;
const ARTICLE = /^\/job-([A-Za-z0-9]{6})\.html$/;
const MAX_JOBS = 200;

/** Old fetch: one index page plus at most 200 detail pages, 600 ms apart (raised to the 1 s floor). */
export const JOBBANK518_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  name: NAME, label: "518 熊班", connector: (fetcher, now) => jobbank518Connector(fetcher, now), maxTier: "plain",
  minIntervalMs: 1_000, maxRequestsPerRun: 1 + MAX_JOBS, completeRead: false, disabled: null,
};

/** The job's URL on 518 (`https://www.518.com.tw/job-XXXXXX.html`), or null when the value is not one. */
export const jobUrl = (value: unknown) => boardUrl(ORIGIN, HOST, ARTICLE, value);

/** The listing id: the six-character job code of its URL, the same for every spelling of that URL. */
const idOf = (url: string) => ARTICLE.exec(new URL(url).pathname)![1];

/** The job links of the first index page; [] only when the page says it found nothing. Throws SourceError on anything unrecognized. */
export function parseIndex(raw: Uint8Array): string[] {
  const html = pageHtml(NAME, raw);
  const $ = load(html, { scriptingEnabled: false });
  const heading = $("h1").text();
  if (!heading.includes("兼職工作職缺") || !CATEGORIES.every((c) => heading.includes(c))) throw new SourceError(`${NAME}: search filters not confirmed`);
  // Navigation, ads and external links are not jobs. The index's own ld+json is never decoded (518 sent a malformed one, 2026-10-25).
  const urls = [...new Set($("a").toArray().map((a) => jobUrl($(a).attr("href"))).filter((u): u is string => u !== null))];
  const empty = htmlText(html).includes("抱歉沒有搜到適合的職缺");
  if (empty === urls.length > 0 || urls.length > MAX_JOBS) throw new SourceError(`${NAME}: unrecognized search result`);
  return urls;
}

/** The JobPosting objects of the page's ld+json scripts, each script one object or a list (old postings); a script that is not JSON refuses the page. */
function postings(html: string): Record<string, unknown>[] {
  // Local: shared jobPostings reads one object per script, 518 sends a list.
  const $ = load(html, { scriptingEnabled: false });
  const jobs: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let value: unknown;
    try {
      value = JSON.parse($(el).text());
    } catch {
      throw new SourceError(`${NAME}: page metadata is not JSON`);
    }
    for (const v of Array.isArray(value) ? value : [value]) if (isObject(v) && v["@type"] === "JobPosting") jobs.push(v);
  });
  return jobs;
}

/** Visible text of a JobPosting field; throws SourceError when it is missing, blank, over 200,000 characters or shows nothing. */
function fieldText(value: unknown, what: string): string {
  if (typeof value !== "string" || !pyStrip(value) || codePoints(value) > 200_000) throw new SourceError(`${NAME}: ${what} required`);
  const text = visibleLines(value);
  if (!text) throw new SourceError(`${NAME}: empty ${what}`);
  return text;
}

/** A real calendar date `YYYY-MM-DD` from year 1, or null. */
function calendarDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  return y >= 1 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? value : null;
}

/** validThrough in the contract: absent (falsy) is null; a date or an instant with its zone is used; anything else is given but unusable (D8). */
export function deadlineOf(value: unknown): ListingInput["deadline"] {
  if (!truthy(value)) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const date = calendarDate(value);
  if (date) return { kind: "date", date };
  const at = typeof value === "string" ? pubDateInstant(value) : null;
  if (at) return { kind: "instant", at };
  return { kind: typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) ? "no_timezone" : "invalid", text };
}

/** datePosted: an instant only when it carries a zone; a bare date is the posted date with no instant (see the header). */
export function postedOf(value: unknown): { published_at: string | null; posted_date: string | null } {
  const posted_date = calendarDate(value);
  return { published_at: posted_date === null && typeof value === "string" ? pubDateInstant(value) : null, posted_date };
}

const UPDATED = /更新日期\s*[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/;
const CATEGORY = /職務類別\s*(.*?)\s*職缺條件/s;

/** One detail page in the contract; `pageUrl` is the link the index gave. Throws SourceError when the listing's identity is missing. */
export function parseArticle(raw: Uint8Array, pageUrl: string): ListingInput {
  const url = jobUrl(pageUrl);
  if (url === null) throw new SourceError(`${NAME}: invalid job URL`);
  const html = pageHtml(NAME, raw);
  const jobs = postings(html);
  if (jobs.length !== 1) throw new SourceError(`${NAME}: expected one JobPosting`);
  const data = jobs[0];
  if (jobUrl(data.url) !== url) throw new SourceError(`${NAME}: mismatched job URL`);
  const title = fieldText(data.title, "title"), body = fieldText(data.description, "description");
  if (codePoints(title) > 500 || codePoints(body) > 100_000) throw new SourceError(`${NAME}: oversize job`);
  // The source's rule reads the kind, so an unreadable employment type sets the listing aside.
  const types = [...new Set(employmentTypes(NAME, data.employmentType, true))].sort();
  const { published_at, posted_date } = postedOf(data.datePosted);
  const category = CATEGORY.exec(body)?.[1] || null;
  return parseListingInput({
    external_id: idOf(url), title, description: body, url, canonical_url: url, kind: kindOf(types), complete: false,
    published_at, deadline: deadlineOf(data.validThrough),
    extra: {
      posted_date, updated_date: calendarDate(UPDATED.exec(htmlText(html))?.[1]), employment_types: types, category,
      telecommute: data.jobLocationType === "TELECOMMUTE", location_evidence: data.jobLocation ?? null, salary_evidence: data.baseSalary ?? null,
    },
  });
}

/** The source's rule: a contract-kind job in one of the four software categories (old intake filter). */
export function kept(l: ListingInput): boolean {
  const category = l.extra.category;
  if (category !== null && typeof category !== "string") throw new SourceError(`${NAME}: stored category is not text`);
  return l.kind === "contract" && category !== null && CATEGORIES.some((c) => category.includes(c));
}

const page = (fetcher: Fetcher, url: string) => fetcher.get({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

export async function jobbank518Connector(fetcher: Fetcher, _now: Date): Promise<Collected> {
  const urls = parseIndex((await page(fetcher, INDEX)).body);
  // Read scope kept as the old one: every job on the first index page, at most 200.
  const { listings, rejected, examined, truncated } = await readDetails(urls, async (url) => parseArticle((await page(fetcher, url)).body, url));
  return { seen: urls.length, listings: [...new Map(listings.map((l) => [l.external_id, l])).values()], sourceKept: kept, truncated, rejected, examined };
}
