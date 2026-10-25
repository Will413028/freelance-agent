import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { dateFromIsoformat, PyDateTime } from "@/platform/py/datetime";
import { identityHash, loads } from "@/platform/py/json";
import { htmlFeed } from "@/platform/py/html";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { pyLen } from "@/platform/py/unicode";
import { urlsplit } from "@/platform/py/url";
import { isDict, PyDict, PyError, pyGet, pySorted, truthy, type PyValue } from "@/platform/py/value";
import { sourceBatch } from "../ingest";
import { attr, canonicalOn, employmentTypes, kindOf, pageReader, pageText, rejectsDetail, seams, SOURCE_BUDGET_MS, type FetchSeams } from "./job-pages";
import { published, text, visibleParts } from "./text";

// Port of collection/jobbank518.py: 518's public part-time software search; no login, application, or
// private API.

const ORIGIN = "https://www.518.com.tw";
export const INDEX = ORIGIN + "/job-index-P-1.html?ai=2&ab=2032001005,2032001003,2032001016,2032001018";
export const CATEGORIES = ["軟體設計工程師", "Internet程式設計師", "APP工程師", "AI工程師"];
const ARTICLE = String.raw`/job-([A-Za-z0-9]{6})\.html\Z`;

const get = pyGet;

export const canonical = (value: PyValue | undefined) => canonicalOn(ORIGIN, "www.518.com.tw", ARTICLE, value);

const visibleText = (html: string) => visibleParts(html).join("\n");

/** jobbank518.date_value: a date-only value stays a date (no invented midnight UTC); anything else is published(). */
export function dateValue(value: PyValue): string {
  // Source date-only values carry no timezone; don't invent midnight UTC.
  if (typeof value === "string" && pyFullmatch(String.raw`\d{4}-\d{2}-\d{2}`, value)) return dateFromIsoformat(value);
  return published(value).isoformat();
}

/** jobbank518.Page: job links, raw ld+json scripts and the h1 text. */
function parsePage(html: string) {
  const urls: string[] = [], scripts: string[] = [], heading: string[] = [];
  let inHeading = false, inScript = false, parts: string[] = [];
  htmlFeed(html, {
    starttag(tag, attrs) {
      if (tag === "h1") inHeading = true;
      if (tag === "a") {
        try {
          urls.push(canonical(attr(attrs, "href", null)));
        } catch (e) {
          // navigation, ads and external links are not jobs
          if (!pyIsInstance(e, "ValueError")) throw e;
        }
      }
      if (tag === "script" && attr(attrs, "type") === "application/ld+json") inScript = true, (parts = []);
    },
    data(data) {
      if (inHeading) heading.push(data);
      if (inScript) parts.push(data);
    },
    endtag(tag) {
      if (tag === "h1") inHeading = false;
      if (tag === "script" && inScript) {
        inScript = false;
        scripts.push(parts.join(""));
      }
    },
  }, true);
  return { urls, scripts, heading: heading.join("") };
}

/** jobbank518.postings: JobPosting metadata (a list or one object per script); only detail pages decode it, since an
 * index page's unrelated ld+json can be malformed (518, 2026-10-25). */
function postings(scripts: string[]): PyDict[] {
  const jobs: PyDict[] = [];
  for (const script of scripts) {
    const value = loads(script);
    const values = Array.isArray(value) ? value : [value];
    jobs.push(...values.filter((v): v is PyDict => isDict(v) && get(v, "@type") === "JobPosting"));
  }
  return jobs;
}

/** jobbank518.parse_index: the distinct job links; an explicit empty result is [] and anything unrecognized fails. */
export function parseIndex(raw: Uint8Array): string[] {
  const html = pageText(raw);
  const page = parsePage(html);
  if (!page.heading.includes("兼職工作職缺") || !CATEGORIES.every((c) => page.heading.includes(c))) throw new PyError("ValueError", "Search filters not confirmed");
  const urls = [...new Set(page.urls)];
  const empty = visibleText(html).includes("抱歉沒有搜到適合的職缺");
  if ((empty && urls.length) || (!empty && !urls.length) || urls.length > 200) throw new PyError("ValueError", "Unrecognized search result");
  return urls;
}

const UPDATED = pyRe(String.raw`更新日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})`);
const CATEGORY = pyRe(String.raw`職務類別\s*(.*?)\s*職缺條件`, false, false, true);
/** Every regex above, for the golden test. */
export const regexes = () => ({ UPDATED, CATEGORY });

export function parseArticle(raw: Uint8Array, pageUrl: string): PyDict {
  const url = canonical(pageUrl), html = pageText(raw);
  const page = parsePage(html);
  const jobs = postings(page.scripts);
  if (jobs.length !== 1) throw new PyError("ValueError", "Expected one JobPosting");
  const data = jobs[0];
  if (canonical(get(data, "url")) !== url) throw new PyError("ValueError", "Mismatched job URL");
  const title = text(get(data, "title")), body = text(get(data, "description"));
  if (pyLen(title) > 500 || pyLen(body) > 100_000) throw new PyError("ValueError", "Oversize job");
  const types = pySorted(new Set(employmentTypes(get(data, "employmentType"), true)));
  const stamp = dateValue(get(data, "datePosted"));
  const update = UPDATED.exec(visibleText(html));
  const updated = update ? dateValue(update[1]) : null;
  const category = CATEGORY.exec(body);
  const categoryText = category ? category[1] : "";
  let expiry = get(data, "validThrough");
  if (truthy(expiry)) expiry = dateValue(expiry);
  const job = PyDict.of({
    source: "jobbank518", external_id: pyFullmatch(ARTICLE, urlsplit(url).path)![1],
    title, description: body, url, canonical_url: url, attribution: "518熊班",
    kind: kindOf(types), published_at: stamp, received_at: stamp, updated_at: updated,
    deadline: truthy(expiry) ? expiry : null, employment_types: types, category_evidence: categoryText,
    software_category: CATEGORIES.some((c) => categoryText.includes(c)),
    location_evidence: get(data, "jobLocation"), salary_evidence: get(data, "baseSalary"),
    remote_evidence: get(data, "jobLocationType") === "TELECOMMUTE",
    weekly_hours: null, taiwan_eligible: null, timezone_compatible: null,
    currency: null, budget_min: null, budget_max: null, free_apply: null,
    language: "zh-TW", complete: false, body_available: true,
  });
  return job.update({ receipt_id: "jobbank518:" + identityHash(job) });
}

/** jobbank518.fetch */
export async function fetchJobbank518(s: FetchSeams = {}): Promise<PyDict> {
  const { request, pause, monotonic } = seams(s);
  const deadline = monotonic() + SOURCE_BUDGET_MS;
  const get_ = pageReader(request, monotonic, deadline);
  const read = (url: string) => {
    if (url !== INDEX) canonical(url);
    return get_(url);
  };
  const urls = parseIndex(await read(INDEX));
  const jobs: PyDict[] = [];
  let rejected = 0n, attempted = 0;
  for (const url of urls) {
    if (deadline - monotonic() < 1000) break;
    await pause(600);
    attempted++;
    try {
      jobs.push(parseArticle(await read(url), url));
    } catch (e) {
      if (!rejectsDetail(e, "ValueError", "TypeError", "KeyError", "OSError")) throw e;
      rejected++;
    }
  }
  return PyDict.of({
    jobs, seen: BigInt(urls.length), details_read: BigInt(jobs.length), rejected_count: rejected,
    truncated: attempted < urls.length, complete_scan: false, scope: "public_part_time_four_software_categories_first_page",
  });
}

export type JobsReader = () => Promise<PyDict>;

/**
 * jobbank518.sync minus its first line (runSource marks the source failed). Throws where Python
 * returns {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncJobbank518(db: Db, reader: JobsReader = () => fetchJobbank518()): Promise<PyDict> {
  const result = await reader();
  const now = PyDateTime.now();
  const partial = truthy(result.req("rejected_count")) || truthy(result.req("truncated"));
  const count = await sourceBatch(db, "jobbank518", now, async (batch) => {
    const old = await batch.existingIds();
    let n = 0n;
    for (const job of result.req("jobs") as PyDict[]) {
      if (old.has(job.str("external_id")) || (truthy(job.at("software_category")) && job.at("kind") === "contract"
        && qualifyForIntake(job, now).at("status") !== "excluded")) {
        await batch.ingest(job, job.at("receipt_id"));
        n++;
      }
    }
    await batch.finish(partial ? "failed" : "ok");
    return n;
  });
  const out = new PyDict([...result].filter(([k]) => k !== "jobs"));
  return out.update({ jobs: count, status: partial ? "partial" : "ok" });
}
