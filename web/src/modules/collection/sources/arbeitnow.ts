import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { loadsBytes, raiseForUrllibStatus, urlopenRead } from "@/platform/http";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch } from "@/platform/py/re";
import { pyLen, pyLower, pyRstrip, pyStrip } from "@/platform/py/unicode";
import { urlsplit, urlunsplit } from "@/platform/py/url";
import { isDict, isList, PyDict, PyError, pyGet, pySorted, type PyValue } from "@/platform/py/value";
import { sourceBatch } from "../ingest";
import { text } from "./text";

// Port of collection/arbeitnow.py: a bounded read of Arbeitnow's official free job-board API;
// discovery only.

export const ENDPOINT = "https://www.arbeitnow.com/api/job-board-api";
const MAX_BYTES = 8_000_000;
export const MAX_PAGE_ENTRIES = 10_000; // Resource bound, not the provider's page-size contract.
export const PROMOTIONAL_FOOTERS = [
  '<p>Find more <a href="https://www.arbeitnow.com/english-speaking-jobs">English Speaking Jobs in Germany</a> on Arbeitnow</a>',
  '<p>Find <a href="https://www.arbeitnow.com">Jobs in Germany</a> on Arbeitnow</a>',
];
const DAY_US = 86_400_000_000n;

const get = pyGet;

export function descriptionText(value: PyValue): string {
  // These exact terminal fragments were observed varying on identical jobs. Keep all other content;
  // attribution and the canonical link remain separate.
  if (typeof value === "string") {
    value = pyRstrip(value);
    for (const footer of PROMOTIONAL_FOOTERS) {
      if (value.endsWith(footer)) {
        value = value.slice(0, -footer.length);
        break;
      }
    }
  }
  return text(value);
}

/** arbeitnow.fetch(url, timeout=...): the response body. */
export type Reader = (url: string, timeoutMs: number) => Promise<Uint8Array>;
/** One GET with urlopen(timeout=timeoutMs): the timeout bounds the connect and each read, not the whole read. */
export type Get = (url: string, timeoutMs: number) => Promise<{ status: number; body: Uint8Array }>;
const httpGet: Get = (url, timeoutMs) =>
  urlopenRead(url, { "User-Agent": "freelance-agent/0.1 personal-job-discovery", Accept: "application/json" }, MAX_BYTES, timeoutMs, timeoutMs, Infinity);

/** arbeitnow.fetch over a GET: urllib's status semantics with public_feeds.NoRedirect, then the 8 MB cap. */
export const readerOver = (request: Get): Reader => async (url, timeoutMs) => {
  const r = await request(url, timeoutMs);
  raiseForUrllibStatus(r.status);
  if (r.status !== 200) throw new PyError("ValueError", "Arbeitnow unavailable");
  if (r.body.length > MAX_BYTES) throw new PyError("ValueError", "Arbeitnow response too large");
  return r.body;
};
export const fetchPage = readerOver(httpGet);

const HOSTS = new Set(["www.arbeitnow.com", "www.arbeitnow.co.uk", "www.arbeitnow.fr", "www.arbeitnow.ch"]);

export function normalize(entry: PyValue): PyDict {
  if (!isDict(entry)) throw new PyError("ValueError", "Invalid listing");
  const slug = get(entry, "slug"), url = get(entry, "url");
  if (typeof slug !== "string" || !pyFullmatch("[A-Za-z0-9_-]{1,200}", slug)) throw new PyError("ValueError", "Invalid slug");
  const parsed = typeof url === "string" ? urlsplit(url) : null;
  if (parsed === null || parsed.scheme !== "https" || !HOSTS.has(parsed.netloc) || !parsed.path.startsWith("/jobs/companies/") || parsed.path.replace(/\/+$/, "").split("/").at(-1) !== slug) {
    throw new PyError("ValueError", "Invalid canonical URL");
  }
  const canonical = urlunsplit({ ...parsed, query: "", fragment: "" });
  const stamp = get(entry, "created_at");
  if (typeof stamp !== "bigint" || stamp <= 0n) throw new PyError("ValueError", "Invalid publication time");
  const published = PyDateTime.fromTimestamp(stamp);
  const types = get(entry, "job_types");
  if (!isList(types) || types.some((item) => typeof item !== "string")) throw new PyError("ValueError", "Invalid job types");
  const normalizedTypes = new Set((types as string[]).map((item) => pyLower(pyStrip(item)).replaceAll("-", " ")));
  const kind = [...normalizedTypes].some((item) => item.includes("fulltime") || item.includes("full time")) ? "full_time"
    : ["part time", "parttime", "freelance", "contract"].some((t) => normalizedTypes.has(t)) ? "contract" : null;
  const location = get(entry, "location");
  if (location !== null && typeof location !== "string") throw new PyError("ValueError", "Invalid location");
  const title = text(get(entry, "title")), description = descriptionText(get(entry, "description"));
  if (pyLen(title) > 500 || pyLen(description) > 100_000) throw new PyError("ValueError", "Listing too long");
  const job = PyDict.of({
    source: "arbeitnow", external_id: slug, title, description,
    url: canonical, canonical_url: canonical, attribution: "Arbeitnow",
    kind, remote_evidence: get(entry, "remote") === true,
    employment_types: pySorted(normalizedTypes), location_evidence: location,
    published_at: published.isoformat(), received_at: published.isoformat(),
    weekly_hours: null, taiwan_eligible: null, timezone_compatible: null, deadline: null,
    currency: null, budget_min: null, budget_max: null, free_apply: null,
    language: "en", complete: false, body_available: true,
  });
  return job.update({ receipt_id: "arbeitnow:" + slug + ":" + identityHash(job) });
}

/** parse_batch's result, plus the envelope's meta and row count that scan checks (Python decodes the page twice). */
export type Batch = { jobs: PyDict[]; rejected: bigint; next: string | null; meta: PyDict; count: bigint };

export function parseBatch(raw: Uint8Array, page = 1): Batch {
  if (!raw.length || raw.length > MAX_BYTES) throw new PyError("ValueError", "Invalid API response");
  const data = loadsBytes(raw);
  const entries = isDict(data) ? get(data, "data") : null;
  if (!isDict(data) || !isList(entries) || entries.length > MAX_PAGE_ENTRIES) throw new PyError("ValueError", "Invalid API envelope");
  const meta = get(data, "meta");
  if (!isDict(meta) || typeof get(meta, "current_page") !== "bigint" || get(meta, "current_page") !== BigInt(page)) throw new PyError("ValueError", "Unexpected pagination");
  const jobs: PyDict[] = [];
  let rejected = 0n;
  for (const entry of entries) {
    try {
      jobs.push(normalize(entry));
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "TypeError", "OverflowError")) throw e;
      rejected++;
    }
  }
  const links = get(data, "links");
  if (!isDict(links) || !links.has("next")) throw new PyError("ValueError", "Missing pagination evidence");
  let next = links.at("next");
  if (next !== null) {
    if (typeof next !== "string" || !entries.length) throw new PyError("ValueError", "Invalid next page");
    const parsed = urlsplit(next);
    // parse_qs(query) == {'page': [str(page + 1)]} holds whenever the query is exactly 'page=<n>'.
    if (parsed.scheme !== "https" || (parsed.netloc !== "www.arbeitnow.com" && parsed.netloc !== "www.arbeitnow.nl")
        || parsed.path !== "/api/job-board-api" || parsed.fragment || parsed.query !== "page=" + (page + 1)) {
      throw new PyError("ValueError", "Unsupported next page URL");
    }
    // Official API responses may carry the observed regional alias; requests stay pinned.
    next = ENDPOINT + "?page=" + (page + 1);
  }
  return { jobs, rejected, next, meta, count: BigInt(entries.length) };
}

export type ScanOptions = {
  reader?: Reader; maxPages?: number; maxSeconds?: number;
  /** time.monotonic in seconds */
  monotonic?: () => number;
  pause?: (ms: number) => Promise<unknown>;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** arbeitnow.scan: the jobs and the coverage dict. */
export async function scan(o: ScanOptions = {}): Promise<[PyDict[], PyDict]> {
  const { reader = fetchPage, maxPages = 20, maxSeconds = 120, monotonic = () => performance.now() / 1000, pause = sleep } = o;
  if (!Number.isInteger(maxPages) || !(maxPages >= 1 && maxPages <= 100) || !(maxSeconds > 0 && maxSeconds <= 300)) throw new PyError("ValueError", "Invalid scan limits");
  const end = monotonic() + maxSeconds;
  let url: string | null = ENDPOINT, page = 1, rejected = 0n, seen = 0n;
  const jobs = new Map<string, PyDict>();
  let pageSize: bigint | null = null;
  let paginationConsistent = true;
  while (url && page <= maxPages) {
    let remaining = end - monotonic();
    if (remaining <= 0) break;
    if (page > 1) {
      if (remaining <= 3) break;
      await pause(3000);
      remaining = end - monotonic();
      if (remaining <= 0) break;
    }
    const raw = await reader(url, Math.min(25, remaining) * 1000);
    const { jobs: batch, rejected: bad, next, meta, count } = parseBatch(raw, page);
    const size = get(meta, "per_page");
    const validSize = typeof size === "bigint" && size > 0n && size <= BigInt(MAX_PAGE_ENTRIES);
    if (pageSize === null && validSize) pageSize = size;
    const expectedFrom = validSize ? BigInt(page - 1) * size + 1n : null;
    const from = get(meta, "from"), to = get(meta, "to");
    const validRange = validSize && size === pageSize && count <= size
      && ((count === 0n && from === null && to === null)
        || (count > 0n && typeof from === "bigint" && typeof to === "bigint" && from === expectedFrom && to === expectedFrom! + count - 1n))
      && (next === null || count === size);
    paginationConsistent = paginationConsistent && validRange;
    seen += BigInt(batch.length) + bad;
    rejected += bad;
    for (const job of batch) {
      const previous = jobs.get(job.str("external_id"));
      if (previous && previous.at("receipt_id") !== job.at("receipt_id")) throw new PyError("ValueError", "Listing changed during pagination");
      jobs.set(job.str("external_id"), job);
    }
    url = next;
    page += 1;
  }
  return [[...jobs.values()], PyDict.of({
    seen, pages: BigInt(page - 1), rejected_count: rejected, truncated: Boolean(url), pagination_consistent: paginationConsistent,
    complete_scan: !url && !rejected && paginationConsistent, scope: "official_public_api_pages",
  })];
}

/**
 * arbeitnow.sync minus its first line: runSource has already marked the source failed. Throws where
 * Python returns {'status': 'failed'}; the whole page set is read before the batch opens.
 */
export async function syncArbeitnow(db: Db, o: ScanOptions = {}): Promise<PyDict> {
  const [jobs, coverage] = await scan(o);
  const incomplete = !coverage.at("complete_scan");
  const now = PyDateTime.now();
  const oldest = PyDateTime.fromUtcMicros(now.utcMicros() - 90n * DAY_US);
  const selected = await sourceBatch(db, "arbeitnow", now, async (batch) => {
    const existing = await batch.existingIds();
    const out: PyDict[] = [];
    for (const job of jobs) {
      const published = fromisoformat(job.at("published_at")).utcMicros();
      const fresh = oldest.utcMicros() <= published && published <= now.utcMicros();
      const evaluation = qualifyForIntake(job, now);
      if (existing.has(job.str("external_id")) || (fresh && job.at("remote_evidence") === true
          && job.at("kind") === "contract" && evaluation.at("status") !== "excluded" && (evaluation.at("score") as bigint) > 0n)) {
        await batch.ingest(job, job.at("receipt_id"));
        out.push(job);
      }
    }
    await batch.finish(incomplete ? "failed" : "ok");
    return out;
  });
  return new PyDict([["status", incomplete ? "partial" : "ok"], ["jobs", BigInt(selected.length)], ...coverage]);
}
