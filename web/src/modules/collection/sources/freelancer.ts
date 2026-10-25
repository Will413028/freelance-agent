import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { loadsBytes, raiseForUrllibStatus, urlopenRead } from "@/platform/http";
import { PyDateTime } from "@/platform/py/datetime";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { pyIntToFloat, pyLen, pyStr } from "@/platform/py/unicode";
import { isDict, isList, PyDict, pyEq, PyError, pyGet, pySubscript, truthy, type PyValue } from "@/platform/py/value";
import { ingest, setSourceHealth } from "../ingest";

// Port of collection/freelancer.py: the public official Freelancer active-project search; bounded
// discovery, never bids.

export const QUERIES = ["AI agent", "API integration", "MVP web development"];
const TITLE_SIGNAL = pyRe(String.raw`\b(?:ai|agent|api|backend|back.end|full.stack|mvp|website|web\s+app|web\s+development|software\s+development|app\s+development|automation|integration|chatbot|bot)\b`, true);
const OUT_OF_SCOPE = pyRe(String.raw`\b(?:copywriting|seo|link\s+building|lead\s+generation|sales|commission|testing|vapt|scraping|data\s+entry|logo|graphic\s+design)\b`, true);
/** Every regex above, for the golden test. */
export const regexes = () => ({ TITLE_SIGNAL, OUT_OF_SCOPE });
const LIMIT = 2_000_000;

const get = pyGet;

/** int or float, not bool: type(v) in (int, float). */
const isNum = (v: PyValue): v is bigint | number => typeof v === "bigint" || typeof v === "number";
/** math.isfinite(v): a huge int is an OverflowError, as float(v) is. */
const isFinite = (v: bigint | number) => (typeof v === "bigint" ? (pyIntToFloat(v), true) : Number.isFinite(v));

export function normalize(p: PyValue): PyDict {
  const id = get(p, "id");
  if (typeof id !== "bigint" || id <= 0n || get(p, "status") !== "active" || truthy(get(p, "deleted")) || truthy(get(p, "nonpublic"))) {
    throw new PyError("ValueError", "Non-public or inactive project");
  }
  const title = get(p, "title"), description = get(p, "description");
  if (typeof title !== "string" || !(pyLen(title) >= 1 && pyLen(title) <= 500) || typeof description !== "string" || !(pyLen(description) >= 1 && pyLen(description) <= 50000)) {
    throw new PyError("ValueError", "Full description required");
  }
  const stamp = get(p, "time_updated");
  if (!isNum(stamp) || !isFinite(stamp) || stamp <= 0) throw new PyError("ValueError", "Invalid timestamp");
  const timestamp = PyDateTime.fromTimestamp(stamp).isoformat();
  const currency = get(get(p, "currency", new PyDict()), "code"), budget = get(p, "budget", new PyDict());
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || !isDict(budget)) throw new PyError("ValueError", "Invalid budget");
  const amounts = ["minimum", "maximum"].map((k) => get(budget, k));
  if (amounts.some((v) => v !== null && (!isNum(v) || !isFinite(v) || v < 0))) throw new PyError("ValueError", "Invalid amount");
  if (amounts.every((v) => v !== null) && (amounts[0] as bigint | number) > (amounts[1] as bigint | number)) throw new PyError("ValueError", "Invalid range");
  const slug = get(p, "seo_url");
  if (typeof slug !== "string" || !pyFullmatch("[A-Za-z0-9_-]+/[A-Za-z0-9_-]+", slug)) throw new PyError("ValueError", "Invalid project URL");
  const kind = get(p, "type");
  if (kind !== "fixed" && kind !== "hourly") throw new PyError("ValueError", "Unknown project type");
  const url = "https://www.freelancer.com/projects/" + slug;
  return PyDict.of({
    source: "freelancer", external_id: id.toString(), title, description,
    received_at: timestamp, receipt_id: `freelancer:${id}:${pyStr(stamp)}`, url, canonical_url: url,
    kind, currency, budget_min: amounts[0], budget_max: amounts[1],
    weekly_hours: null, taiwan_eligible: null, timezone_compatible: null, deadline: null,
    language: "en", complete: false,
  });
}

/** One GET with urlopen(timeout=timeoutMs): the timeout bounds the connect and each read, not the whole read. */
export type Get = (url: string, timeoutMs: number) => Promise<{ status: number; body: Uint8Array }>;
const httpGet: Get = async (url, timeoutMs) => {
  const r = await urlopenRead(url, { "User-Agent": "freelance-agent/0.1", Accept: "application/json" }, LIMIT, timeoutMs, timeoutMs, Infinity);
  raiseForUrllibStatus(r.status);
  return r;
};

export type SearchOptions = {
  limit?: number; maxPages?: number; maxSeconds?: number;
  request?: Get; pause?: (ms: number) => Promise<unknown>;
  /** time.monotonic in seconds */
  monotonic?: () => number;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** freelancer.search; every failure is the one ValueError Python raises. */
export async function search(query: string, o: SearchOptions = {}): Promise<PyDict> {
  const { limit = 20, maxPages = 20, maxSeconds = 30, request = httpGet, pause = sleep, monotonic = () => performance.now() / 1000 } = o;
  if (!QUERIES.includes(query) || !Number.isInteger(limit) || !(limit >= 1 && limit <= 100) || !Number.isInteger(maxPages) || !(maxPages >= 1 && maxPages <= 100)
      || !Number.isFinite(maxSeconds) || !(maxSeconds > 0 && maxSeconds <= 120)) {
    throw new PyError("ValueError", "Unsupported search bounds");
  }
  const deadline = monotonic() + maxSeconds;
  const jobs = new Map<string, PyDict>();
  let offset = 0, pages = 0, total: bigint | null = null, limited = true, rejected = 0n;
  try {
    for (let n = 0; n < maxPages; n++) {
      if (pages) {
        const remaining = deadline - monotonic();
        if (remaining <= 0.6) break;
        await pause(600);
      }
      const remaining = deadline - monotonic();
      if (remaining <= 0) break;
      // urlencode and URLSearchParams agree on these values (fixed queries and integers).
      const url = "https://www.freelancer.com/api/projects/0.1/projects/active/?" + new URLSearchParams({
        query, limit: String(limit), offset: String(offset), full_description: "true" });
      const r = await request(url, Math.min(20, remaining) * 1000);
      if (r.status !== 200) throw new PyError("ValueError", "");
      if (r.body.length > LIMIT) throw new PyError("ValueError", "");
      const data = loadsBytes(r.body);
      if (pySubscript(data, "status") !== "success") throw new PyError("ValueError", "");
      const result = pySubscript(data, "result");
      const projects = pySubscript(result, "projects"), reported = pySubscript(result, "total_count");
      if (!isList(projects) || projects.length > limit || typeof reported !== "bigint" || reported < BigInt(projects.length)) throw new PyError("ValueError", "");
      total = reported;
      const pageJobs: PyDict[] = [];
      for (const project of projects) {
        try {
          pageJobs.push(normalize(project));
        } catch (e) {
          if (!pyIsInstance(e, "ValueError", "TypeError", "AttributeError", "OverflowError")) throw e;
          rejected++;
        }
      }
      pages++;
      let newIds = 0;
      for (const job of pageJobs) {
        const prior = jobs.get(job.str("external_id"));
        if (prior === undefined) newIds++;
        else if (prior.at("received_at") === job.at("received_at") && !pyEq(prior, job)) throw new PyError("ValueError", "Conflicting project version");
        if (prior === undefined || job.str("received_at") > prior.str("received_at")) jobs.set(job.str("external_id"), job);
      }
      // The API may return fewer rows than requested before the end of the result set. Its offset
      // still advances by the requested page.
      offset += limit;
      if (BigInt(offset) >= total) {
        // Offset results can move while a query runs. Duplicates must not be counted as coverage of
        // projects we never actually received.
        limited = BigInt(jobs.size) < total;
        break;
      }
      if (!projects.length || (pageJobs.length && !newIds)) break;
    }
    return PyDict.of({ jobs: [...jobs.values()], limited, pages: BigInt(pages), reported_total: total, rejected_count: rejected, scope: "active_query_results" });
  } catch {
    throw new PyError("ValueError", "Freelancer search unavailable or unsupported");
  }
}

export type Searcher = (query: string, limit: number) => Promise<PyDict>;

/**
 * freelancer.sync minus its first line: runSource has already marked the source failed. Throws where
 * Python returns {'status': 'failed'}. Like Python, each listing is ingested on its own (no batch).
 */
export async function syncFreelancer(db: Db, searcher: Searcher = (q, limit) => search(q, { limit }), pause: (ms: number) => Promise<unknown> = sleep): Promise<PyDict> {
  const jobs = new Map<string, PyDict>();
  let limited = false, rejected = 0n, pages = 0n;
  for (const [index, query] of QUERIES.entries()) {
    if (index) await pause(600);
    const result = await searcher(query, 100);
    limited ||= pySubscript(result, "limited") === true;
    rejected += get(result, "rejected_count", 0n) as bigint;
    pages += get(result, "pages", 0n) as bigint;
    for (const job of result.at("jobs") as PyDict[]) {
      const prior = jobs.get(job.str("external_id"));
      if (prior === undefined || job.str("received_at") > prior.str("received_at")) jobs.set(job.str("external_id"), job);
    }
  }
  const selected = [...jobs.values()].filter((job) => {
    if (!TITLE_SIGNAL.test(job.str("title")) || OUT_OF_SCOPE.test(job.str("title"))) return false;
    const evaluation = qualifyForIntake(job, PyDateTime.now());
    return evaluation.at("status") !== "excluded" && (evaluation.at("score") as bigint) > 0n;
  });
  for (const job of selected) await ingest(db, job, job.at("receipt_id"), PyDateTime.now());
  const partial = limited || rejected > 0n;
  await setSourceHealth(db, "freelancer", partial ? "failed" : "ok");
  return PyDict.of({ status: partial ? "partial" : "ok", seen: BigInt(jobs.size), jobs: BigInt(selected.length), limited, rejected_count: rejected, pages, scope: "3_active_queries_paginated" });
}
