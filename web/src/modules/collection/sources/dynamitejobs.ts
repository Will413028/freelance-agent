import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { htmlFeed } from "@/platform/py/html";
import { pyLen, pyLower } from "@/platform/py/unicode";
import { urlsplit } from "@/platform/py/url";
import { isDict, isList, PyDict, PyError, pyGet, pySorted, truthy, type PyValue } from "@/platform/py/value";
import { sourceBatch } from "../ingest";
import { attr, canonicalOn, employmentTypes, jobPostings, kindOf, pageReader, pageText, rejectsDetail, seams, SOURCE_BUDGET_MS, type FetchSeams } from "./job-pages";
import { published, text } from "./text";

// Port of collection/dynamitejobs.py: the public engineering listing window and JobPosting pages; no
// accounts or private APIs.

const ORIGIN = "https://dynamitejobs.com";
export const INDEX = ORIGIN + "/category/development";
const ARTICLE = String.raw`/company/[a-z0-9-]+/remote-job/[a-z0-9-]+\Z`;
const BROAD = new Set(["taiwan", "taiwan, province of china", "asia", "apac", "worldwide", "anywhere", "global"]);
const DAY_US = 86_400_000_000n;

const get = pyGet;

export const canonical = (value: PyValue | undefined) => canonicalOn(ORIGIN, "dynamitejobs.com", ARTICLE, value);

/** dynamitejobs.parse_index: the distinct job links of the listing page. */
export function parseIndex(raw: Uint8Array): string[] {
  const urls: string[] = [];
  htmlFeed(pageText(raw), {
    starttag(tag, attrs) {
      const href = attr(attrs, "href", "");
      if (tag !== "a") return;
      // '/remote-job/' in None: a bare href attribute fails the listing.
      if (typeof href !== "string") throw new PyError("TypeError", "argument of type 'NoneType' is not iterable");
      if (href.includes("/remote-job/")) urls.push(canonical(href));
    },
  }, true);
  const unique = [...new Set(urls)];
  if (!unique.length || unique.length > 200) throw new PyError("ValueError", "Missing or oversized engineering listing");
  return unique;
}

export function parseArticle(raw: Uint8Array, pageUrl: string): PyDict {
  const url = canonical(pageUrl);
  const jobs = jobPostings(pageText(raw));
  if (jobs.length !== 1) throw new PyError("ValueError", "Expected one JobPosting");
  const data = jobs[0];
  if (canonical(get(data, "url")) !== url) throw new PyError("ValueError", "Mismatched job URL");
  const title = text(get(data, "title")), body = text(get(data, "description"));
  if (pyLen(title) > 500 || pyLen(body) > 100_000) throw new PyError("ValueError", "Oversize job");
  const types = pySorted(new Set(employmentTypes(get(data, "employmentType"), true)));
  let locations = get(data, "applicantLocationRequirements", []);
  if (isDict(locations)) locations = [locations];
  if (!isList(locations)) throw new PyError("ValueError", "Invalid location requirements");
  const names: string[] = [];
  for (const loc of locations) {
    const type = isDict(loc) ? get(loc, "@type") : null;
    if (type !== "Country" && type !== "AdministrativeArea") throw new PyError("ValueError", "Unsupported location requirement");
    names.push(text(get(loc, "name")));
  }
  const excluded = names.length > 0 && !names.some((x) => BROAD.has(pyLower(x)));
  const stamp = published(get(data, "datePosted")).isoformat();
  let expiry = get(data, "validThrough");
  if (truthy(expiry)) expiry = published(expiry).isoformat();
  const job = PyDict.of({
    source: "dynamitejobs", external_id: urlsplit(url).path, title, description: body,
    url, canonical_url: url, attribution: "Dynamite Jobs", kind: kindOf(types),
    published_at: stamp, received_at: stamp, deadline: truthy(expiry) ? expiry : null,
    employment_types: types, location_evidence: names, category_evidence: "development",
    remote_evidence: get(data, "jobLocationType") === "TELECOMMUTE",
    weekly_hours: null, taiwan_eligible: excluded ? false : null, timezone_compatible: null,
    currency: null, budget_min: null, budget_max: null, free_apply: null,
    language: "en", complete: false, body_available: true,
  });
  return job.update({ receipt_id: "dynamitejobs:" + identityHash(job) });
}

/** dynamitejobs.fetch */
export async function fetchDynamiteJobs(s: FetchSeams = {}): Promise<PyDict> {
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
    truncated: attempted < urls.length, complete_scan: false, scope: "public_development_category_window_no_private_api",
  });
}

export type JobsReader = () => Promise<PyDict>;

/**
 * dynamitejobs.sync minus its first line (runSource marks the source failed). Throws where Python
 * returns {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncDynamiteJobs(db: Db, reader: JobsReader = () => fetchDynamiteJobs()): Promise<PyDict> {
  const result = await reader();
  const now = PyDateTime.now();
  const nowUs = now.utcMicros();
  const partial = truthy(result.req("rejected_count")) || truthy(result.req("truncated"));
  const count = await sourceBatch(db, "dynamitejobs", now, async (batch) => {
    const old = await batch.existingIds();
    let n = 0n;
    for (const job of result.req("jobs") as PyDict[]) {
      const at = published(job.req("published_at")).utcMicros();
      const recent = nowUs - 90n * DAY_US <= at && at <= nowUs;
      if (old.has(job.str("external_id")) || (recent && truthy(job.at("remote_evidence")) && job.at("kind") === "contract"
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
