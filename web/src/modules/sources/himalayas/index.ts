import { z } from "zod";
import { parseJobInput, type JobInput } from "@/modules/listings/public";
import { parseIsoTime } from "../shared/time";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";
import { codePoints, isObject, truthy } from "../shared/json";

// Himalayas: the public search API, 4 fixed queries x 2 employment types, first page each (old
// collection/himalayas.py, web/src/modules/collection/sources/himalayas.ts at ce1254d). A listing
// without its identity (guid, title, description, the board's own job URL) or without a text
// employment type (the source's own rule reads it) is set aside and counted in `rejected`; more than
// half set aside fails the source (services/collect, Will 2026-11-15; the old reader refused the batch
// for one listing). A page that is not JSON or has no list refuses the batch. Any other field the
// connector cannot read is unknown (plan D8). The source's own rule keeps Contractor and Part Time.

export const QUERIES = ["AI agent", "automation", "backend", "full stack"] as const;
export const EMPLOYMENT = ["Contractor", "Part Time"] as const;
const MAX_BYTES = 8_000_000;

export const searchUrl = (q: string, employment: string) =>
  "https://himalayas.app/jobs/api/search?" + new URLSearchParams({ q, employment_type: employment, country: "TW", sort: "recent", page: "1" });

const TAIWAN = new Set(["tw", "taiwan", "taiwan, province of china"]);

const rfc3339 = (d: Date) => {
  const y = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && y >= 1 && y <= 9999 ? d.toISOString() : null;
};

/**
 * The board's time: epoch seconds, or milliseconds past 10^11, or ISO text with an offset. A time
 * without an offset has no rule on this board, so it is unknown (null); so is anything else.
 */
export function boardInstant(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const seconds = value > 100_000_000_000 ? value / 1000 : value;
    // Microseconds as Python rounded them, then milliseconds (the contract's precision) truncated.
    return rfc3339(new Date(Math.floor(Math.round(seconds * 1e6) / 1000)));
  }
  if (typeof value !== "string") return null;
  const t = parseIsoTime(value);
  return t?.kind === "aware" ? rfc3339(t.instant) : null;
}

/** expiryDate in the contract's deadline shapes. */
function deadlineOf(value: unknown): JobInput["deadline"] {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    const at = boardInstant(value);
    return at === null ? { kind: "invalid", text: String(value) } : { kind: "instant", at };
  }
  if (typeof value !== "string") return { kind: "invalid", text: JSON.stringify(value) };
  const t = parseIsoTime(value);
  if (t === null) return { kind: "invalid", text: value };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "date", date: value };
  if (t.kind === "aware") {
    const at = rfc3339(t.instant);
    return at === null ? { kind: "invalid", text: value } : { kind: "instant", at };
  }
  return { kind: "no_timezone", text: value };
}

/** false when every country restriction is read and none is Taiwan; null when there is none or one is unreadable. */
function taiwanEligible(locations: unknown): boolean | null {
  if (!Array.isArray(locations) || !locations.length) return null;
  const countries: string[] = [];
  for (const location of locations) {
    const country = isObject(location) ? (truthy(location.alpha2) ? location.alpha2 : location.name) : location;
    if (typeof country !== "string" || !country.trim()) return null;
    countries.push(country.trim().toLowerCase());
  }
  return countries.some((c) => TAIWAN.has(c)) ? null : false;
}

/** A UTC offset in hours: a JSON number or decimal text, within -12..14; null otherwise. */
function offsetOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= -12 && n <= 14 ? n : null;
}

/** false when every timezone restriction is read and none is UTC+8; null when there is none or one is unreadable. */
function timezoneCompatible(offsets: unknown): boolean | null {
  if (!Array.isArray(offsets) || !offsets.length) return null;
  const zones = offsets.map(offsetOf);
  if (zones.some((z) => z === null)) return null;
  return zones.includes(8) ? null : false;
}

/** The board's own job URL, as both URL parsers read it, spelled as given, without query and fragment. */
function jobUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.replace(/^[\x00-\x20]+/, "").replace(/[\t\n\r]/g, "") : "";
  const rest = raw.slice("https://".length);
  const path = rest.startsWith("himalayas.app/") ? rest.slice("himalayas.app".length).split(/[?#]/, 1)[0] : "";
  if (raw.slice(0, "https://".length).toLowerCase() !== "https://" || !path.startsWith("/companies/") || !path.includes("/jobs/")) {
    throw new SourceError("himalayas: invalid application URL");
  }
  const link = `https://himalayas.app${path}`;
  if (!URL.canParse(link)) throw new SourceError("himalayas: invalid application URL");
  return link;
}

function kindOf(employment: string): JobInput["kind"] {
  if (employment === "Contractor" || employment === "Part Time") return "contract";
  return employment === "Full Time" ? "full_time" : null;
}

/** One listing in the contract; throws SourceError when its identity or employment type is missing (`setAside` sets that one listing aside). */
export function normalize(item: unknown): JobInput {
  if (!isObject(item)) throw new SourceError("himalayas: a listing is not an object");
  const { title, description: body, guid } = item;
  if (typeof title !== "string" || codePoints(title) < 1 || codePoints(title) > 500) throw new SourceError("himalayas: invalid title");
  if (typeof body !== "string" || codePoints(body) < 1 || codePoints(body) > 100_000) throw new SourceError("himalayas: full description required");
  if (typeof guid !== "string" || codePoints(guid) < 1 || codePoints(guid) > 2000) throw new SourceError("himalayas: identifier required");
  const url = jobUrl(item.applicationLink);
  const description = htmlText(body);
  if (!description) throw new SourceError("himalayas: empty description");
  const employment = item.employmentType;
  if (typeof employment !== "string") throw new SourceError("himalayas: employment type required");
  const locations = item.locationRestrictions ?? null, offsets = item.timezoneRestrictions ?? null;
  return parseJobInput({
    external_id: guid, title, description, url, canonical_url: url, kind: kindOf(employment),
    taiwan_eligible: taiwanEligible(locations), timezone_compatible: timezoneCompatible(offsets), complete: false,
    published_at: boardInstant(item.pubDate), deadline: deadlineOf(item.expiryDate),
    extra: { employment_types: [employment], location_evidence: locations, timezone_evidence: offsets },
  });
}

const pageSchema = z.object({ jobs: z.array(z.unknown()).max(20) });

/** One search page's raw listings (each checked by `normalize`, which sets aside one without a text guid). */
export function parsePage(body: Uint8Array): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError("himalayas: search page is not JSON");
  }
  const page = pageSchema.safeParse(data);
  if (!page.success) throw new SourceError("himalayas: search page has no list of at most 20 jobs");
  return page.data.jobs;
}

/**
 * All 8 searches: every listing once by guid (the last entry wins, also when the last entry is set
 * aside), in the contract. Every entry of every page is checked, so `rejected` and `examined` count at
 * the page-entry level: a listing on several searches counts once per search in both.
 */
export async function readAll(fetcher: Fetcher): Promise<{ listings: JobInput[]; rejected: number; examined: number }> {
  const jobs = new Map<string, JobInput | null>();
  let rejected = 0, examined = 0;
  for (const q of QUERIES) {
    for (const employment of EMPLOYMENT) {
      const r = await fetcher.get({
        url: searchUrl(q, employment), maxBytes: MAX_BYTES, timeoutMs: 25_000,
        headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/json" },
      });
      const page = setAside(parsePage(r.body), (job) => {
        // A later entry replaces an earlier one in place (first position kept, as the old map did), even when it is set aside.
        if (isObject(job) && typeof job.guid === "string") jobs.set(job.guid, null);
        const l = normalize(job);
        jobs.set(l.external_id, l);
        return l;
      });
      rejected += page.rejected;
      examined += page.examined;
    }
  }
  return { listings: [...jobs.values()].filter((l): l is JobInput => l !== null), rejected, examined };
}

export async function himalayasConnector(fetcher: Fetcher): Promise<Collected<JobInput>> {
  const { listings: all, rejected, examined } = await readAll(fetcher);
  // seen: the distinct listings read (old himalayas.ts `seen: all.length`).
  return { seen: all.length, listings: all, sourceKept: (l) => l.kind === "contract", rejected, examined };
}

export const HIMALAYAS_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  label: "Himalayas", name: "himalayas", connector: himalayasConnector, maxTier: "plain",
  // Old: 600 ms between searches (collection/sources/himalayas.ts:116), raised to the 1 s floor.
  minIntervalMs: 1000,
  // Old: 4 queries x 2 employment types, one page each (collection/sources/himalayas.ts:15, 102-105).
  maxRequestsPerRun: 8,
  completeRead: false, disabled: null,
};
