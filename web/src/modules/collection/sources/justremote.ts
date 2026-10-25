import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { decodeStrict } from "@/platform/py/codecs";
import { PyDateTime } from "@/platform/py/datetime";
import { identityHash, rawDecode } from "@/platform/py/json";
import { htmlFeed } from "@/platform/py/html";
import { pyLen, pyLower, pyStr, pyStrip } from "@/platform/py/unicode";
import { isDict, isInt, isList, PyDict, PyError, pyGet, pySubscript, truthy, type PyValue } from "@/platform/py/value";
import { sourceBatch } from "../ingest";
import { canonicalOn, employmentTypes, jobPostings, kindOf, pageReader, seams, SOURCE_BUDGET_MS, type FetchSeams } from "./job-pages";
import { published, text } from "./text";

// Port of collection/justremote.py: JustRemote's public HTML listing state and JobPosting metadata;
// no private API.

export const INDEX = "https://justremote.co/remote-jobs";
const TECH = new Set(["developer", "devopsandsysadmin"]);
const ARTICLE = String.raw`/remote-[a-z-]+-jobs/[a-z0-9][a-z0-9-]+\Z`;
const BROAD = new Set(["worldwide", "anywhere", "asia", "apac", "global", "taiwan", "taiwan, province of china"]);
const PREFIX = "window.__PRELOADED_STATE__ = ";
const DAY_US = 86_400_000_000n;

const get = pyGet;

export const canonical = (value: PyValue | undefined) => canonicalOn("https://justremote.co/", "justremote.co", ARTICLE, value);

/** justremote.ListingState: every inline script that assigns the preloaded state, parsed as literal JSON. */
function listingStates(html: string): PyValue[] {
  let active = false, parts: string[] = [];
  const states: PyValue[] = [];
  htmlFeed(html, {
    starttag(tag) {
      if (tag === "script") active = true, (parts = []);
    },
    data(data) {
      if (active) parts.push(data);
    },
    endtag(tag) {
      if (tag !== "script" || !active) return;
      active = false;
      const raw = pyStrip(parts.join(""));
      if (!raw.startsWith(PREFIX)) return;
      // Parse literal JSON only. Never execute the site's JavaScript.
      const [value, end] = rawDecode(raw.slice(PREFIX.length));
      const rest = pyStrip(raw.slice(PREFIX.length + end));
      if (rest !== "" && rest !== ";") throw new PyError("ValueError", "Unsupported state suffix");
      states.push(value);
    },
  }, true);
  return states;
}

/** justremote.parse_index: the valid listing entries (each with its canonical url) and the rejected count. */
export function parseIndex(raw: Uint8Array): { entries: PyDict[]; rejected: bigint } {
  const states = listingStates(decodeStrict("utf-8", raw));
  if (states.length !== 1) throw new PyError("ValueError", "Missing listing state");
  const state = pySubscript(states[0], "jobsState");
  const entries = pySubscript(pySubscript(state, "entity"), "all");
  if (!isDict(state)) throw new PyError("AttributeError", "'list' object has no attribute 'get'");
  const meta = get(state, "meta", new PyDict());
  if (!isDict(meta)) throw new PyError("AttributeError", "object has no attribute 'get'");
  if (get(meta, "status") !== "success" || !isList(entries) || !entries.length) throw new PyError("ValueError", "Incomplete listing state");
  if (entries.length > 2000) throw new PyError("ValueError", "Oversize listing state");
  const valid: PyDict[] = [], ids = new Set<bigint>();
  let rejected = 0n;
  for (const entry of entries) {
    try {
      if (!isDict(entry)) throw new PyError("AttributeError", "object has no attribute 'get'");
      const id = get(entry, "id");
      if (!isInt(id) || id <= 0n) throw new PyError("ValueError", "Invalid id");
      const jobType = get(entry, "job_type");
      if (jobType !== "permanent" && jobType !== "contract") throw new PyError("ValueError", "Unknown employment type");
      const locations = get(entry, "location_restrictions");
      if (!isList(locations) || locations.some((x) => typeof x !== "string" || !pyStrip(x))) throw new PyError("ValueError", "Invalid location restrictions");
      if (typeof get(entry, "category") !== "string" || typeof get(entry, "is_active") !== "boolean") throw new PyError("ValueError", "Invalid category or status");
      const url = canonical(get(entry, "href"));
      text(get(entry, "title"));
      if (ids.has(id)) throw new PyError("ValueError", "Duplicate id");
      ids.add(id);
      valid.push(new PyDict(entry).update({ url }));
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "TypeError", "AttributeError")) throw e;
      rejected++;
    }
  }
  return { entries: valid, rejected };
}

export function parseArticle(raw: Uint8Array, entry: PyDict): PyDict {
  const jobs = jobPostings(decodeStrict("utf-8", raw));
  if (jobs.length !== 1) throw new PyError("ValueError", "Expected one JobPosting");
  const data = jobs[0];
  const title = text(get(data, "title")), body = text(get(data, "description"));
  if (title !== text(entry.req("title")) || pyLen(title) > 500 || pyLen(body) > 100_000) throw new PyError("ValueError", "Mismatched or oversize job");
  const types = employmentTypes(get(data, "employmentType"), false);
  const kind = kindOf(types);
  // Prefer explicit detail metadata; inconsistent contract/permanent is not silently accepted.
  if (entry.req("job_type") === "permanent" && kind !== "full_time") throw new PyError("ValueError", "Employment mismatch");
  const date = published(get(data, "datePosted")).isoformat();
  let deadline = get(data, "validThrough");
  if (truthy(deadline)) deadline = published(deadline).isoformat();
  const locations = entry.req("location_restrictions") as string[];
  const excluded = locations.length > 0 && !locations.some((x) => BROAD.has(pyLower(x)));
  const url = canonical(entry.req("url"));
  const job = PyDict.of({
    source: "justremote", external_id: pyStr(entry.req("id")), title, description: body,
    url, canonical_url: url, attribution: "JustRemote", kind,
    published_at: date, received_at: date, deadline, employment_types: types,
    location_evidence: locations, category_evidence: entry.req("category"),
    remote_evidence: get(data, "jobLocationType") === "TELECOMMUTE",
    active_evidence: entry.req("is_active"), weekly_hours: null, taiwan_eligible: excluded ? false : null,
    timezone_compatible: null, currency: null, budget_min: null, budget_max: null,
    language: "en", complete: false, body_available: true,
  });
  return job.update({ receipt_id: "justremote:" + identityHash(job) });
}

/** justremote.fetch */
export async function fetchJustRemote(s: FetchSeams = {}): Promise<PyDict> {
  const { request, pause, monotonic } = seams(s);
  const deadline = monotonic() + SOURCE_BUDGET_MS;
  const get_ = pageReader(request, monotonic, deadline);
  const read = (url: string) => {
    if (url !== INDEX) canonical(url);
    return get_(url);
  };
  const index = parseIndex(await read(INDEX));
  let rejected = index.rejected;
  // Read every contract and technical detail, including full-time updates to previously known jobs.
  const selected = index.entries.filter((e) => e.at("job_type") === "contract" || TECH.has(e.str("category")));
  const jobs: PyDict[] = [];
  for (const [i, entry] of selected.entries()) {
    if (deadline - monotonic() <= 1000) {
      rejected += BigInt(selected.length - i);
      break;
    }
    try {
      await pause(600);
      jobs.push(parseArticle(await read(entry.str("url")), entry));
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "TypeError", "KeyError", "OSError")) throw e;
      rejected++;
    }
  }
  return PyDict.of({
    jobs, seen: BigInt(index.entries.length), rejected_count: rejected, details_read: BigInt(jobs.length),
    listing_metadata: index.entries, complete_scan: false, scope: "public_html_listing_window",
  });
}

export type JobsReader = () => Promise<PyDict>;

/**
 * justremote.sync minus its first line (runSource marks the source failed). Throws where Python
 * returns {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncJustRemote(db: Db, reader: JobsReader = () => fetchJustRemote()): Promise<PyDict> {
  const result = await reader();
  const now = PyDateTime.now();
  const nowUs = now.utcMicros();
  const rejected = truthy(result.req("rejected_count"));
  const count = await sourceBatch(db, "justremote", now, async (batch) => {
    const old = await batch.existingIds();
    let n = 0n;
    for (const job of result.req("jobs") as PyDict[]) {
      const at = published(job.req("published_at")).utcMicros();
      const recent = nowUs - 90n * DAY_US <= at && at <= nowUs;
      if (old.has(job.str("external_id")) || (recent && truthy(job.at("active_evidence")) && truthy(job.at("remote_evidence"))
        && job.at("kind") === "contract" && TECH.has(job.str("category_evidence")) && qualifyForIntake(job, now).at("status") !== "excluded")) {
        await batch.ingest(job, job.at("receipt_id"));
        n++;
      }
    }
    await batch.finish(rejected ? "failed" : "ok");
    return n;
  });
  const out = new PyDict([...result].filter(([k]) => k !== "jobs" && k !== "listing_metadata"));
  return out.update({ jobs: count, status: rejected ? "partial" : "ok" });
}
