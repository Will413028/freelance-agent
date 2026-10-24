import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { getCapped, loadsBytes } from "@/platform/http";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { asciiHash } from "@/platform/py/json";
import { pyLen, pyLower, pySplit, pyStrip } from "@/platform/py/unicode";
import { urlsplitValue, urlunsplit } from "@/platform/py/url";
import { cmpStr, isInt, isList, PyDict, PyError, pyGet, truthy, type PyValue } from "@/platform/py/value";
import { ingest, setSourceHealth } from "../ingest";
import { htmlText } from "./text";

// Port of collection/free_jobs.py: free public job-board discovery, preserving attribution and
// manual application links.

export const ENDPOINTS: Record<string, string> = {
  remotive: "https://remotive.com/api/remote-jobs?category=software-dev&limit=200",
  jobicy: "https://jobicy.com/api/v2/remote-jobs?count=200",
};

const get = pyGet;

// Generic worldwide labels do not establish citizenship, payroll or timezone eligibility.
const EXCLUDED_GEO = new Set(["usa", "us", "united states", "uk", "united kingdom", "canada", "europe", "eu", "australia"]);

export function normalize(source: string, p: PyValue, now: PyDateTime = PyDateTime.now()): PyDict {
  const remotive = source === "remotive";
  const id = Object.hasOwn(ENDPOINTS, source) ? get(p, "id") : null;
  if (!Object.hasOwn(ENDPOINTS, source) || !isInt(id) || id <= 0n) throw new PyError("ValueError", "Invalid source/id");
  const title = get(p, remotive ? "title" : "jobTitle");
  let description = get(p, remotive ? "description" : "jobDescription");
  if (typeof title !== "string" || !(pyLen(title) >= 1 && pyLen(title) <= 500) || typeof description !== "string" || !(pyLen(description) >= 1 && pyLen(description) <= 100000)) {
    throw new PyError("ValueError", "Full description required");
  }
  description = pySplit(htmlText(description)).join(" ");
  if (!description) throw new PyError("ValueError", "Empty description");
  const u = urlsplitValue(get(p, "url"));
  if (u.scheme !== "https" || u.netloc !== source + ".com" || !u.path.startsWith(remotive ? "/remote-jobs/" : "/jobs/")) {
    throw new PyError("ValueError", "Invalid job URL");
  }
  const url = urlunsplit({ ...u, query: "", fragment: "" });
  const rawTypes = remotive ? [get(p, "job_type", "")] : get(p, "jobType", []);
  if (!isList(rawTypes) || rawTypes.some((t) => typeof t !== "string")) throw new PyError("ValueError", "Invalid employment type");
  const types = new Set((rawTypes as string[]).map((t) => pyLower(t).replaceAll("-", "_").replaceAll(" ", "_")));
  const kind = types.has("full_time") ? "full_time" : ["contract", "part_time", "freelance"].some((t) => types.has(t)) ? "contract" : null;
  let geo = get(p, remotive ? "candidate_required_location" : "jobGeo");
  if (!truthy(geo)) geo = "";
  if (typeof geo !== "string") throw new PyError("ValueError", "Invalid geography");
  const taiwan = EXCLUDED_GEO.has(pyLower(pyStrip(geo))) ? false : null;
  const published = get(p, remotive ? "publication_date" : "pubDate");
  if (typeof published !== "string") throw new PyError("ValueError", "Publication evidence required");
  const parsed = fromisoformat(published.replaceAll("Z", "+00:00"));
  const received = parsed.aware ? parsed : now;
  const job = PyDict.of({
    source, external_id: id.toString(), title, description, url, canonical_url: url,
    kind, employment_types: [...types].sort(cmpStr), location_evidence: geo, publication_evidence: published,
    taiwan_eligible: taiwan, timezone_compatible: null, weekly_hours: null, deadline: null,
    currency: null, budget_min: null, budget_max: null, language: "en", complete: false,
  });
  const receipt = asciiHash(job);
  return job.update({ received_at: received.isoformat(), receipt_id: `${source}:${id}:${receipt}` });
}

export async function fetchFeed(source: string): Promise<PyDict> {
  if (!Object.hasOwn(ENDPOINTS, source)) throw new PyError("ValueError", "Unsupported source");
  try {
    const r = await getCapped(ENDPOINTS[source], { "User-Agent": "freelance-agent/0.1 personal-job-discovery", Accept: "application/json" }, 8_000_000, 25_000);
    if (r.status !== 200 || r.body.length > 8_000_000) throw new Error();
    const d = loadsBytes(r.body);
    const jobs = get(d, "jobs");
    if (!isList(jobs) || jobs.length > 200) throw new Error();
    return d as PyDict;
  } catch {
    throw new PyError("ValueError", "Public job feed unavailable");
  }
}

export type FeedReader = (source: string) => Promise<PyDict>;

/**
 * free_jobs.sync minus its first line: runSource has already marked the source failed. Throws where
 * Python returns {'status': 'failed'}; jobs already ingested before a failure stay, as in Python.
 */
export async function syncFreeJobs(db: Db, source: string, reader: FeedReader = fetchFeed): Promise<PyDict> {
  const data = await reader(source);
  const now = PyDateTime.now();
  const jobs = (data.req("jobs") as PyValue[]).map((p) => normalize(source, p, now));
  const selected = jobs.filter((j) => j.at("kind") === "contract" && qualifyForIntake(j, PyDateTime.now()).at("status") !== "excluded");
  for (const job of selected) await ingest(db, job, job.at("receipt_id"), PyDateTime.now());
  await setSourceHealth(db, source, "ok");
  return PyDict.of({ status: "ok", seen: BigInt(jobs.length), jobs: BigInt(selected.length), scope: "latest_200_public_listings" });
}
