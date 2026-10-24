import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { getCapped, loadsBytes } from "@/platform/http";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { pyLen, pyStr } from "@/platform/py/unicode";
import { urlsplitValue, urlunsplit } from "@/platform/py/url";
import { isDict, isInt, isList, PyDict, PyError, pyEq, pyGet, pySubscript, truthy, type PyValue } from "@/platform/py/value";
import { sourceBatch } from "../ingest";
import { text } from "./text";

// Port of collection/getonboard.py: the official public Get on Board API; paginated remote
// discovery, never applications.

export const ROOT = "https://www.getonbrd.com/api/v0/";
const TECH = new Set(["Programming", "Machine Learning & AI", "Mobile Development", "Data Science / Analytics", "SysAdmin / DevOps / QA"]);
const LIMIT = 2_000_000;
const DAY_US = 86_400_000_000n;

const get = pyGet;
const EMPTY = () => new PyDict();

// A platform's worldwide flag is not evidence of payroll/work eligibility.
// Explicit regional requirements in the title still exclude Taiwan.
const REGIONAL = pyRe(String.raw`\b(?:LATAM|Latin America|US[- ]only|EU[- ]only)\b`, true);

export function normalize(item: PyValue, modalities: Map<string, PyValue>): PyDict {
  const identity = get(item, "id"), attrs = get(item, "attributes");
  if (typeof identity !== "string" || !pyFullmatch("[a-z0-9_-]{1,250}", identity) || !isDict(attrs)) throw new PyError("ValueError", "Invalid job identity");
  const parsed = urlsplitValue(get(get(item, "links", EMPTY()), "public_url", ""));
  if (parsed.scheme !== "https" || parsed.netloc !== "www.getonbrd.com" || parsed.path !== "/jobs/" + identity) throw new PyError("ValueError", "Invalid canonical job URL");
  const url = urlunsplit({ ...parsed, query: "", fragment: "" });
  const title = text(get(attrs, "title"));
  let body = text(get(attrs, "description"));
  for (const field of ["projects", "functions", "desirable", "benefits"]) if (truthy(get(attrs, field))) body += "\n" + text(attrs.at(field));
  if (pyLen(title) > 500 || pyLen(body) > 100_000) throw new PyError("ValueError", "Oversize listing");
  const stamp = get(attrs, "published_at");
  if (!isInt(stamp) || stamp <= 0n) throw new PyError("ValueError", "Invalid publication");
  const published = PyDateTime.fromTimestamp(stamp).isoformat();
  const modality = modalities.get(pyStr(get(get(get(attrs, "modality", EMPTY()), "data", EMPTY()), "id"))) ?? null;
  if (modality === null) throw new PyError("ValueError", "Unknown modality");
  const kind = modality === "full_time" ? "full_time" : modality === "part_time" || modality === "freelance" ? "contract" : null;
  const countries = get(attrs, "countries");
  if (!isList(countries) || countries.some((c) => typeof c !== "string")) throw new PyError("ValueError", "Invalid countries");
  const excluded = REGIONAL.test(title);
  const job = PyDict.of({
    source: "getonboard", external_id: identity, title, description: body,
    canonical_url: url, url, attribution: "Get on Board", kind,
    published_at: published, received_at: published, employment_evidence: modality,
    remote_evidence: get(attrs, "remote") === true, remote_modality: get(attrs, "remote_modality"),
    location_evidence: countries, category_evidence: get(attrs, "category_name"),
    weekly_hours: null, taiwan_eligible: excluded ? false : null,
    timezone_compatible: null, deadline: null, currency: null, budget_min: null, budget_max: null,
    salary_evidence: PyDict.of({ min: get(attrs, "min_salary"), max: get(attrs, "max_salary"), period: null }),
    language: get(attrs, "lang"), complete: false, body_available: true,
  });
  const fingerprint = identityHash(job);
  return job.update({ receipt_id: "getonboard:" + identity + ":" + fingerprint });
}

/** One GET: the URL and the time left on the source deadline. */
export type Get = (url: string, remainingMs: number) => Promise<{ status: number; body: Uint8Array }>;
const httpGet: Get = (url, remainingMs) => getCapped(url, { "User-Agent": "freelance-agent/0.1", Accept: "application/json" }, LIMIT, Math.min(15_000, remainingMs));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** getonboard.fetch; `request` and `pause` are seams for tests. */
export async function fetchJobs(request: Get = httpGet, pause: (ms: number) => Promise<unknown> = sleep): Promise<PyDict> {
  const deadline = performance.now() + 90_000;
  const get_ = async (path: string, params: Record<string, string>): Promise<PyDict> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new PyError("TimeoutError", "Source deadline");
    const r = await request(ROOT + path + "?" + new URLSearchParams(params), remaining);
    if (r.status !== 200) throw new PyError("ValueError", "API unavailable");
    if (r.body.length > LIMIT) throw new PyError("ValueError", "Response limit");
    if (performance.now() > deadline) throw new PyError("ValueError", "Source time budget exceeded");
    const data = loadsBytes(r.body);
    if (!isDict(data) || !isList(data.at("data") ?? null) || (data.at("data") as PyValue[]).length > 120) throw new PyError("ValueError", "Invalid API envelope");
    return data;
  };
  const taxonomy = await get_("modalities", { per_page: "120", page: "1" });
  if (!pyEq(get(get(taxonomy, "meta", EMPTY()), "total_pages"), 1n)) throw new PyError("ValueError", "Incomplete modality taxonomy");
  const modalities = new Map<string, PyValue>();
  for (const entry of taxonomy.at("data") as PyValue[]) modalities.set(pyStr(pySubscript(entry, "id")), pySubscript(pySubscript(entry, "attributes"), "locale_key"));
  const jobs = new Map<string, PyDict>();
  let seen = 0n, rejected = 0n, totalPages: PyValue = 1n, page = 1;
  for (page = 1; page <= 10; page++) {
    await pause(600);
    const data = await get_("search/jobs", { remote: "true", per_page: "120", page: String(page) });
    const meta = get(data, "meta", EMPTY());
    totalPages = get(meta, "total_pages");
    if (!pyEq(get(meta, "page"), BigInt(page)) || !isInt(totalPages) || totalPages < 0n) throw new PyError("ValueError", "Invalid pagination");
    const entries = data.at("data") as PyValue[];
    seen += BigInt(entries.length);
    for (const entry of entries) {
      try {
        const job = normalize(entry, modalities);
        jobs.set(job.str("external_id"), job);
      } catch (e) {
        if (!pyIsInstance(e, "ValueError", "TypeError", "AttributeError", "OverflowError")) throw e;
        rejected++;
      }
    }
    if (BigInt(page) >= totalPages) break;
  }
  if (page > 10) page = 10;
  return PyDict.of({ jobs: [...jobs.values()], seen, rejected_count: rejected, pages: BigInt(page), truncated: BigInt(page) < (totalPages as bigint) });
}

/** category in TECH: a list or dict is unhashable, which fails the batch in Python. */
function inTech(category: PyValue): boolean {
  if (isList(category) || isDict(category)) throw new PyError("TypeError", "unhashable type");
  return typeof category === "string" && TECH.has(category);
}

export type JobsReader = () => Promise<PyDict>;

/**
 * getonboard.sync minus its first line (runSource marks the source failed). Throws where Python
 * returns {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncGetOnBoard(db: Db, reader: JobsReader = () => fetchJobs()): Promise<PyDict> {
  const result = await reader();
  const now = PyDateTime.now();
  const partial = truthy(result.req("rejected_count")) || truthy(result.req("truncated"));
  const selected = await sourceBatch(db, "getonboard", now, async (batch) => {
    const old = await batch.existingIds();
    let n = 0n;
    for (const job of result.req("jobs") as PyDict[]) {
      const at = fromisoformat(job.req("published_at")).utcMicros(), nowUs = now.utcMicros();
      const fresh = nowUs - 90n * DAY_US <= at && at <= nowUs;
      if (old.has(job.str("external_id")) || (fresh && truthy(job.at("remote_evidence")) && job.at("kind") === "contract"
        && inTech(job.at("category_evidence")) && qualifyForIntake(job, now).at("status") !== "excluded")) {
        await batch.ingest(job, job.at("receipt_id"));
        n++;
      }
    }
    await batch.finish(partial ? "failed" : "ok");
    return n;
  });
  const out = new PyDict([...result].filter(([k]) => k !== "jobs"));
  return out.update({ status: partial ? "partial" : "ok", jobs: selected, scope: "public_remote_search_max_10_pages_120_each_90_days" });
}
