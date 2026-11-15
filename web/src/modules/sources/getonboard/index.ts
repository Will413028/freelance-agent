import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type SourceSettings } from "../types";

// Get on Board: the official public API (old collection/getonboard.py,
// web/src/modules/collection/sources/getonboard.ts until step 11): the modality taxonomy, then the
// remote job search, up to 10 pages of 120. A listing without its identity (id, title, description,
// the board's own job URL) or without what the source's own rule reads (a known modality, a
// publication time) is set aside and counted in `rejected`, as the old connector skipped it and marked
// the run partial (Will 2026-11-15; more than half set aside fails the source); any other field the connector cannot read is unknown (plan D8). The source's own
// rule keeps remote part-time and freelance listings in tech categories published in the last 90 days.

export const ROOT = "https://www.getonbrd.com/api/v0/";
export const MAX_PAGES = 10;
const MAX_BYTES = 2_000_000;
const TIME_BUDGET_MS = 90_000;
const DAY_MS = 86_400_000;
const TECH = new Set(["Programming", "Machine Learning & AI", "Mobile Development", "Data Science / Analytics", "SysAdmin / DevOps / QA"]);

// A platform's worldwide flag is not evidence of payroll or work eligibility; explicit regional
// requirements in the title still exclude Taiwan. Word boundaries as Python's Unicode \b reads them.
const REGIONAL = /(?<![\p{L}\p{N}_])(?:LATAM|Latin America|US[- ]only|EU[- ]only)(?![\p{L}\p{N}_])/iu;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const codePoints = (s: string) => [...s].length;
const truthy = (v: unknown) =>
  v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && !v.length) && !(isObject(v) && !Object.keys(v).length);
/** Python's str.splitlines boundaries. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

/** Visible text of an HTML field: block tags as line breaks, script and style dropped, blank lines dropped, spaces collapsed. */
export function fieldText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || codePoints(value) > 200_000) throw new SourceError(`getonboard: ${field} required`);
  const $ = load(value.replace(/<\/(?:p|div|li|h1|h2|h3|tr|br)\s*>/gi, (m) => `\n${m}\n`), { scriptingEnabled: false }, false);
  $("script, style").remove();
  $("p, div, li, h1, h2, h3, tr").before("\n").after("\n");
  $("br").replaceWith("\n");
  const text = $.root().text().split(LINE_BREAK).map((line) => line.split(/\s+/u).filter(Boolean).join(" ")).filter(Boolean).join("\n");
  if (!text) throw new SourceError(`getonboard: empty ${field}`);
  return text;
}

/** The board's own job URL for this id, as both URL parsers read it, spelled as given, without query and fragment. */
function jobUrl(value: unknown, id: string): string {
  const raw = typeof value === "string" ? value.replace(/^[\x00-\x20]+/, "").replace(/[\t\n\r]/g, "") : "";
  const rest = raw.slice("https://".length);
  const path = rest.startsWith("www.getonbrd.com/") ? rest.slice("www.getonbrd.com".length).split(/[?#]/, 1)[0] : "";
  if (raw.slice(0, "https://".length).toLowerCase() !== "https://" || path !== `/jobs/${id}`) throw new SourceError("getonboard: invalid canonical job URL");
  return `https://www.getonbrd.com${path}`;
}

/** Modality id to its locale key, from the taxonomy. */
export type Modalities = Map<string, unknown>;

/** One listing in the contract; throws SourceError when its identity, modality or publication time is missing (`setAside` sets that one listing aside). */
export function normalize(item: unknown, modalities: Modalities): ListingInput {
  if (!isObject(item)) throw new SourceError("getonboard: a listing is not an object");
  const id = item.id, attrs = item.attributes;
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,250}$/.test(id) || !isObject(attrs)) throw new SourceError("getonboard: invalid job identity");
  const url = jobUrl(isObject(item.links) ? item.links.public_url : undefined, id);
  const title = fieldText(attrs.title, "title");
  let description = fieldText(attrs.description, "description");
  for (const field of ["projects", "functions", "desirable", "benefits"]) if (truthy(attrs[field])) description += "\n" + fieldText(attrs[field], field);
  if (codePoints(title) > 500 || codePoints(description) > 100_000) throw new SourceError("getonboard: oversize listing");
  // Epoch seconds; the source's own freshness rule reads it, so a listing with an unreadable time is set aside.
  const stamp = attrs.published_at;
  const published = typeof stamp === "number" && Number.isSafeInteger(stamp) && stamp > 0 && stamp <= 253_402_300_799 ? new Date(stamp * 1000).toISOString() : null;
  if (published === null) throw new SourceError("getonboard: invalid publication time");
  const modalityId = isObject(attrs.modality) && isObject(attrs.modality.data) ? attrs.modality.data.id : undefined;
  const modality = typeof modalityId === "string" || (typeof modalityId === "number" && Number.isFinite(modalityId)) ? modalities.get(String(modalityId)) ?? null : null;
  if (modality === null) throw new SourceError("getonboard: unknown modality");
  const kind = modality === "full_time" ? "full_time" : modality === "part_time" || modality === "freelance" ? "contract" : null;
  const countries = Array.isArray(attrs.countries) && attrs.countries.every((c) => typeof c === "string") ? (attrs.countries as string[]) : null;
  return parseListingInput({
    external_id: id, title, description, url, canonical_url: url, kind,
    location: countries?.join(", ") || null,
    taiwan_eligible: REGIONAL.test(title) ? false : null, complete: false, published_at: published,
    extra: {
      employment_evidence: modality, remote_evidence: attrs.remote === true, remote_modality: attrs.remote_modality ?? null,
      location_evidence: attrs.countries ?? null, category_evidence: attrs.category_name ?? null,
      salary_evidence: { min: attrs.min_salary ?? null, max: attrs.max_salary ?? null, period: null }, language: attrs.lang ?? null,
    },
  });
}

/** One API answer: an object whose data is a list of at most 120. */
function envelope(body: Uint8Array): { data: unknown[]; meta: unknown } {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError("getonboard: answer is not JSON");
  }
  if (!isObject(data) || !Array.isArray(data.data) || data.data.length > 120) throw new SourceError("getonboard: invalid API envelope");
  return { data: data.data, meta: data.meta };
}

/** The modality taxonomy: one complete page of {id, attributes: {locale_key}}. */
export function parseModalities(body: Uint8Array): Modalities {
  const { data, meta } = envelope(body);
  if (!isObject(meta) || meta.total_pages !== 1) throw new SourceError("getonboard: incomplete modality taxonomy");
  const modalities: Modalities = new Map();
  for (const entry of data) {
    if (!isObject(entry) || !("id" in entry) || !isObject(entry.attributes) || !("locale_key" in entry.attributes)) throw new SourceError("getonboard: invalid modality");
    modalities.set(typeof entry.id === "string" ? entry.id : JSON.stringify(entry.id), entry.attributes.locale_key);
  }
  return modalities;
}

export type Read = { seen: number; listings: ListingInput[]; pages: number; truncated: boolean; rejected: number; examined: number };

/** The taxonomy and every search page: each listing once by id (the last entry wins). */
export async function readAll(fetcher: Fetcher, clock: () => number = () => performance.now()): Promise<Read> {
  const deadline = clock() + TIME_BUDGET_MS;
  const get = async (path: string, params: Record<string, string>) => {
    const remaining = deadline - clock();
    if (remaining <= 0) throw new FetchError("timeout", "getonboard: source time budget spent");
    const r = await fetcher.get({
      url: ROOT + path + "?" + new URLSearchParams(params), maxBytes: MAX_BYTES, timeoutMs: Math.min(15_000, remaining),
      headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/json" },
    });
    if (clock() > deadline) throw new FetchError("timeout", "getonboard: source time budget spent");
    return r.body;
  };
  const modalities = parseModalities(await get("modalities", { per_page: "120", page: "1" }));
  const byId = new Map<string, ListingInput>();
  let seen = 0, rejected = 0, examined = 0, page = 1, totalPages = 1;
  for (; page <= MAX_PAGES; page++) {
    const { data, meta } = envelope(await get("search/jobs", { remote: "true", per_page: "120", page: String(page) }));
    const m = isObject(meta) ? meta : {};
    if (m.page !== page || typeof m.total_pages !== "number" || !Number.isSafeInteger(m.total_pages) || m.total_pages < 0) throw new SourceError("getonboard: invalid pagination");
    totalPages = m.total_pages;
    seen += data.length;
    // Old getonboard.ts:97-105: a listing that fails to normalize is skipped and counted.
    const got = setAside(data, (entry) => normalize(entry, modalities));
    rejected += got.rejected;
    examined += got.examined;
    for (const l of got.listings) byId.set(l.external_id, l);
    if (page >= totalPages) break;
  }
  page = Math.min(page, MAX_PAGES);
  return { seen, listings: [...byId.values()], pages: page, truncated: page < totalPages, rejected, examined };
}

/** The source's own rule: remote, part-time or freelance, a tech category, published in the 90 days up to now. */
export function keeps(l: ListingInput, now: Date): boolean {
  const at = Date.parse(l.published_at!), category = l.extra.category_evidence;
  // The category is read last, as the old rule short-circuited (getonboard.ts:129-132): a listing the
  // other conditions drop never refuses the batch for its category. Unlike the old `exists ||`, a stored
  // listing with a list or object category refuses the batch too: the connector cannot know it is stored,
  // and a field the rule reads changing format is a failed source (checklist §2; step 5a review round 2).
  if (!(now.getTime() - 90 * DAY_MS <= at && at <= now.getTime() && l.extra.remote_evidence === true && l.kind === "contract")) return false;
  if (Array.isArray(category) || isObject(category)) throw new SourceError("getonboard: category is not text");
  return typeof category === "string" && TECH.has(category);
}

export async function getonboardConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const read = await readAll(fetcher);
  // Old: a scan stopped by the page cap was partial (truncated); stored listings were refreshed whatever the rule said (:131 `exists ||`).
  const kept = read.listings.filter((l) => keeps(l, now));
  return { seen: read.seen, listings: kept, others: read.listings.filter((l) => !kept.includes(l)), truncated: read.truncated, rejected: read.rejected, examined: read.examined };
}

export const GETONBOARD_SETTINGS: Omit<SourceSettings, "order"> = {
  name: "getonboard", connector: getonboardConnector, maxTier: "plain",
  // Old: 600 ms before each search page (collection/sources/getonboard.ts:90), raised to the 1 s floor.
  minIntervalMs: 1000,
  // Old: the modality taxonomy plus up to 10 search pages (collection/sources/getonboard.ts:83, 89).
  maxRequestsPerRun: 1 + MAX_PAGES,
  disabled: null,
};
