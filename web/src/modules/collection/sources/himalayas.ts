import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { getCapped, loadsBytes } from "@/platform/http";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { asciiHash } from "@/platform/py/json";
import { pyFloat, pyIntToFloat, pyLen, pyLower, pySplit, pyStrip } from "@/platform/py/unicode";
import { urlsplitValue, urlunsplit } from "@/platform/py/url";
import { isDict, isList, or, PyDict, PyError, pyGet, type PyValue } from "@/platform/py/value";
import { ingest, setSourceHealth } from "../ingest";
import { htmlText } from "./text";

// Port of collection/himalayas.py: bounded, daily public Himalayas searches; listings remain
// manual-review candidates.

export const QUERIES = ["AI agent", "automation", "backend", "full stack"];
const LIMIT = 8_000_000;

const get = (p: PyValue | undefined, key: string) => pyGet(p, key);

/** himalayas.timestamp: epoch seconds or milliseconds, or an aware ISO time kept in its own offset. */
export function timestamp(value: PyValue): string {
  if (typeof value === "bigint" || typeof value === "number") {
    // Python's int / 1000 is correctly rounded; Number(value) / 1000 is too up to 2**53 ms, and
    // beyond that every value is past year 9999 and fails either way.
    const big = typeof value === "bigint" ? value > 100_000_000_000n : value > 100_000_000_000;
    const t = big ? Number(value) / 1000 : value;
    return PyDateTime.fromTimestamp(t).isoformat();
  }
  if (typeof value !== "string") throw new PyError("ValueError", "Invalid timestamp");
  const parsed = fromisoformat(value.replaceAll("Z", "+00:00"));
  if (!parsed.aware) throw new PyError("ValueError", "Timestamp timezone required");
  return parsed.isoformat();
}

/** float(offset) for a JSON value, before the bool check that follows it. */
function floatOf(v: PyValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return pyIntToFloat(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return pyFloat(v);
  throw new PyError("TypeError", "float() argument must be a string or a real number");
}

const TAIWAN = new Set(["tw", "taiwan", "taiwan, province of china"]);

export function normalize(p: PyValue): PyDict {
  const title = get(p, "title"), body = get(p, "description"), guid = get(p, "guid");
  if (typeof title !== "string" || !(pyLen(title) >= 1 && pyLen(title) <= 500) || typeof body !== "string" || !(pyLen(body) >= 1 && pyLen(body) <= 100000)) {
    throw new PyError("ValueError", "Full listing required");
  }
  if (typeof guid !== "string" || !(pyLen(guid) >= 1 && pyLen(guid) <= 2000)) throw new PyError("ValueError", "Identifier required");
  const u = urlsplitValue(get(p, "applicationLink"));
  if (u.scheme !== "https" || u.netloc !== "himalayas.app" || !u.path.startsWith("/companies/") || !u.path.includes("/jobs/")) {
    throw new PyError("ValueError", "Invalid application URL");
  }
  const url = urlunsplit({ ...u, query: "", fragment: "" });
  const description = pySplit(htmlText(body)).join(" ");
  if (!description) throw new PyError("ValueError", "Empty description");
  const locations = get(p, "locationRestrictions"), offsets = get(p, "timezoneRestrictions");
  if (!isList(locations) || !isList(offsets)) throw new PyError("ValueError", "Location evidence required");
  const countries: string[] = [];
  for (const location of locations) {
    const country = isDict(location) ? or(get(location, "alpha2"), get(location, "name")) : location;
    if (typeof country !== "string" || !pyStrip(country)) throw new PyError("ValueError", "Invalid country");
    countries.push(pyLower(pyStrip(country)));
  }
  let zones: number[];
  try {
    zones = offsets.map(floatOf);
    if (offsets.some((o) => typeof o === "boolean") || zones.some((z) => !(-12 <= z && z <= 14))) throw new PyError("ValueError", "");
  } catch (e) {
    if (e instanceof PyError && (e.pyType === "TypeError" || e.pyType === "ValueError")) throw new PyError("ValueError", "Invalid timezone evidence");
    throw e;
  }
  const employment = get(p, "employmentType");
  if (typeof employment !== "string") throw new PyError("ValueError", "Employment type required");
  const kind = employment === "Contractor" || employment === "Part Time" ? "contract" : employment === "Full Time" ? "full_time" : null;
  const received = timestamp(get(p, "pubDate"));
  const expiry = get(p, "expiryDate");
  const job = PyDict.of({
    source: "himalayas", external_id: guid, title, description, url, canonical_url: url, kind, employment_types: [employment],
    location_evidence: locations, timezone_evidence: offsets,
    taiwan_eligible: countries.length && !countries.some((c) => TAIWAN.has(c)) ? false : null,
    timezone_compatible: zones.length && !zones.includes(8) ? false : null,
    weekly_hours: null, deadline: expiry !== null ? timestamp(expiry) : null,
    currency: null, budget_min: null, budget_max: null, language: "en", complete: false,
  });
  const fingerprint = asciiHash(job);
  return job.update({ received_at: received, receipt_id: "himalayas:" + fingerprint });
}

export type ListingReader = () => Promise<PyValue[]>;

export type Get = (url: string) => Promise<{ status: number; body: Uint8Array }>;
const httpGet: Get = (url) => getCapped(url, { "User-Agent": "freelance-agent/0.1 personal-job-discovery", Accept: "application/json" }, LIMIT, 25_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** himalayas.fetch; `request` and `pause` are seams for tests. */
export async function fetchListings(request: Get = httpGet, pause: (ms: number) => Promise<unknown> = sleep): Promise<PyValue[]> {
  const jobs = new Map<string, PyValue>();
  // 8 fixed searches, one page each; daily caller owns frequency. Never follow feed URLs.
  for (const query of QUERIES) {
    for (const employment of ["Contractor", "Part Time"]) {
      const params = new URLSearchParams({ q: query, employment_type: employment, country: "TW", sort: "recent", page: "1" });
      const r = await request("https://himalayas.app/jobs/api/search?" + params);
      if (r.status !== 200) throw new PyError("ValueError", "Feed unavailable");
      if (r.body.length > LIMIT) throw new PyError("ValueError", "Feed too large");
      const page = get(loadsBytes(r.body), "jobs");
      if (!isList(page) || page.length > 20) throw new PyError("ValueError", "Invalid feed");
      for (const job of page) {
        // jobs[job['guid']]: a non-str guid fails normalize later, which fails the whole sync anyway.
        const guid = isDict(job) && job.has("guid") ? job.at("guid") : undefined;
        if (typeof guid !== "string") throw new PyError("ValueError", "Identifier required");
        jobs.set(guid, job);
      }
      await pause(600);
    }
  }
  return [...jobs.values()];
}

/**
 * himalayas.sync minus its first line: runSource has already marked the source failed. Throws where
 * Python returns {'status': 'failed'}; every listing is normalized before anything is ingested.
 */
export async function syncHimalayas(db: Db, reader: ListingReader = () => fetchListings()): Promise<PyDict> {
  const jobs = (await reader()).map(normalize);
  const selected = jobs.filter((j) => j.at("kind") === "contract" && qualifyForIntake(j, PyDateTime.now()).at("status") !== "excluded");
  for (const job of selected) await ingest(db, job, job.at("receipt_id"), PyDateTime.now());
  await setSourceHealth(db, "himalayas", "ok");
  return PyDict.of({ status: "ok", seen: BigInt(jobs.length), jobs: BigInt(selected.length), scope: "8_searches_first_page_max_160" });
}
