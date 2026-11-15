import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type SourceSettings } from "../types";

// Arbeitnow: the official free job-board API, read page by page (old collection/arbeitnow.py,
// web/src/modules/collection/sources/arbeitnow.ts until step 11). A listing without its identity
// (slug, title, description, the board's own job URL) or without the fields the source's own rule
// reads (job types, publication time) is set aside and counted in `rejected`, as the old connector
// did (Will 2026-11-15; more than half set aside fails the source). A page whose envelope or
// pagination evidence does not hold refuses the whole run; a scan cut short by the page cap is
// written and marked truncated. Any other field the connector cannot read is unknown (plan D8). The
// source's own rule keeps remote contract listings published in the last 90 days.

export const ENDPOINT = "https://www.arbeitnow.com/api/job-board-api";
const MAX_BYTES = 8_000_000;
/** A resource bound, not the provider's page size. */
export const MAX_PAGE_ENTRIES = 10_000;
/** The old scan's default page cap (old arbeitnow.ts:146): the requests of one run. */
export const MAX_PAGES = 20;
const FRESH_MS = 90 * 86_400_000;
/** 9999-12-31T23:59:59Z, the last second Python's datetime held. */
const LAST_SECOND = 253_402_300_799;

export const PROMOTIONAL_FOOTERS = [
  '<p>Find more <a href="https://www.arbeitnow.com/english-speaking-jobs">English Speaking Jobs in Germany</a> on Arbeitnow</a>',
  '<p>Find <a href="https://www.arbeitnow.com">Jobs in Germany</a> on Arbeitnow</a>',
];
// The board's job hosts. www.arbeitnow.nl is new (2026-11-15 VM run: 50 of 300 listings; the old
// connector set them aside every day and the source ran partial).
const HOSTS = new Set(["www.arbeitnow.com", "www.arbeitnow.co.uk", "www.arbeitnow.fr", "www.arbeitnow.ch", "www.arbeitnow.nl"]);
const NEXT_HOSTS = new Set(["www.arbeitnow.com", "www.arbeitnow.nl"]);

/** Python's str.strip() whitespace (it differs from JavaScript's \s: U+001C–U+001F yes, BOM no). */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const pyRstrip = (s: string) => s.replace(new RegExp(`[${PY_SPACE}]+$`, "u"), "");
const pyStrip = (s: string) => pyRstrip(s.replace(new RegExp(`^[${PY_SPACE}]+`, "u"), ""));
const codePoints = (s: string) => [...s].length;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Visible text with its lines (old text.ts `text`: block tags as line breaks, empty lines dropped, spaces
 * collapsed within a line); refuses empty input or text over 200 000 characters as the old one did.
 */
export function visibleText(value: unknown, what: string): string {
  if (typeof value !== "string" || !pyStrip(value) || codePoints(value) > 200_000) throw new SourceError(`arbeitnow: invalid ${what}`);
  const $ = load(value.replace(/<\/(?:p|div|li|br|h1|h2|h3|tr)\s*>/gi, (m) => `\n${m}\n`), { scriptingEnabled: false }, false);
  $("script, style").remove();
  $("p, div, li, h1, h2, h3, tr").before("\n").after("\n");
  $("br").replaceWith("\n");
  const result = $.root().text().split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)
    .map((line) => line.split(/\s+/u).filter(Boolean).join(" ")).filter(Boolean).join("\n");
  if (!result) throw new SourceError(`arbeitnow: empty ${what}`);
  return result;
}

/** The description without the board's promotional footer, which was observed varying on identical jobs (old arbeitnow.ts:28). */
export function descriptionText(value: unknown): string {
  if (typeof value === "string") {
    value = pyRstrip(value);
    const footer = PROMOTIONAL_FOOTERS.find((f) => (value as string).endsWith(f));
    if (footer) value = (value as string).slice(0, -footer.length);
  }
  return visibleText(value, "description");
}

/**
 * A URL split as Python's urlsplit reads it (leading controls and spaces trimmed, tabs and newlines
 * removed, scheme in any case), keeping the source's spelling of host and path; null when not https.
 */
function splitHttps(raw: unknown): { host: string; path: string; query: string | null; fragment: string | null } | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/^[\x00-\x20]+/, "").replace(/[\t\n\r]/g, "");
  const m = /^https:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/is.exec(s);
  if (!m || !m[0].slice(0, 8).toLowerCase().startsWith("https://")) return null;
  return { host: m[1], path: m[2], query: m[3] ?? null, fragment: m[4] ?? null };
}

/** The board's own job URL without query and fragment, or null when it is not the job page of `slug`. */
export function canonicalJobUrl(raw: unknown, slug: string): string | null {
  const p = splitHttps(raw);
  if (!p || !HOSTS.has(p.host) || !p.path.startsWith("/jobs/companies/") || p.path.replace(/\/+$/, "").split("/").at(-1) !== slug) return null;
  const link = `https://${p.host}${p.path}`;
  return URL.canParse(link) ? link : null;
}

/** The source's job types: stripped, lower case, `-` as a space; null when the field is not a list of text. */
function employmentTypes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) return null;
  return [...new Set((raw as string[]).map((t) => pyStrip(t).toLowerCase().replaceAll("-", " ")))].sort();
}

function kindOf(types: string[]): ListingInput["kind"] {
  if (types.some((t) => t.includes("fulltime") || t.includes("full time"))) return "full_time";
  return ["part time", "parttime", "freelance", "contract"].some((t) => types.includes(t)) ? "contract" : null;
}

/** One API entry in the contract; throws SourceError when its identity or a field the source's rule reads is missing (`setAside` sets that one listing aside). */
export function normalize(entry: unknown): ListingInput {
  if (!isObject(entry)) throw new SourceError("arbeitnow: a listing is not an object");
  const slug = entry.slug;
  if (typeof slug !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(slug)) throw new SourceError("arbeitnow: invalid slug");
  const link = canonicalJobUrl(entry.url, slug);
  if (link === null) throw new SourceError("arbeitnow: invalid canonical URL");
  // A Unix time in seconds; the freshness rule reads it, so a listing with an unreadable one is set aside.
  const stamp = entry.created_at;
  if (typeof stamp !== "number" || !Number.isSafeInteger(stamp) || stamp <= 0 || stamp > LAST_SECOND) throw new SourceError("arbeitnow: invalid publication time");
  const types = employmentTypes(entry.job_types);
  if (types === null) throw new SourceError("arbeitnow: invalid job types");
  const title = visibleText(entry.title, "title"), description = descriptionText(entry.description);
  if (codePoints(title) > 500 || codePoints(description) > 100_000) throw new SourceError("arbeitnow: listing too long");
  const location = typeof entry.location === "string" ? entry.location : null;
  return parseListingInput({
    external_id: slug, title, description, url: link, canonical_url: link,
    location: location || null, kind: kindOf(types), complete: false,
    published_at: new Date(stamp * 1000).toISOString(),
    extra: { employment_types: types, remote_evidence: entry.remote === true },
  });
}

export type Page = { listings: ListingInput[]; rejected: number; examined: number; count: number; next: string | null; meta: Record<string, unknown> };

/** One API page (`page` counts from 1): its listings and the pinned URL of the next page, or null. */
export function parsePage(body: Uint8Array, page: number): Page {
  let data: unknown;
  try {
    if (!body.length) throw new Error("empty");
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError("arbeitnow: page is not JSON");
  }
  if (!isObject(data) || !Array.isArray(data.data) || data.data.length > MAX_PAGE_ENTRIES) throw new SourceError("arbeitnow: invalid API envelope");
  const meta = data.meta, entries = data.data as unknown[];
  if (!isObject(meta) || meta.current_page !== page) throw new SourceError("arbeitnow: unexpected pagination");
  // Old arbeitnow.ts:108-115: a listing that fails to normalize is set aside and counted.
  const { listings, rejected, examined } = setAside(entries, (e) => normalize(e));
  const links = data.links;
  if (!isObject(links) || !("next" in links)) throw new SourceError("arbeitnow: missing pagination evidence");
  let next: string | null = null;
  if (links.next !== null) {
    if (typeof links.next !== "string" || !entries.length) throw new SourceError("arbeitnow: invalid next page");
    const p = splitHttps(links.next);
    if (!p || !NEXT_HOSTS.has(p.host) || p.path !== "/api/job-board-api" || p.fragment || p.query !== `page=${page + 1}`) {
      throw new SourceError("arbeitnow: unsupported next page URL");
    }
    // The API may answer with a regional alias; requests stay pinned to the endpoint.
    next = `${ENDPOINT}?page=${page + 1}`;
  }
  return { listings, rejected, examined, count: entries.length, next, meta };
}

const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** Whether a page's meta agrees with the pages before it (old arbeitnow.ts:161-167). */
function consistent(p: Page, page: number, pageSize: number | null): boolean {
  const size = p.meta.per_page, from = p.meta.from, to = p.meta.to;
  if (!int(size) || size <= 0 || size > MAX_PAGE_ENTRIES || (pageSize !== null && size !== pageSize) || p.count > size) return false;
  const expectedFrom = (page - 1) * size + 1;
  const range = p.count === 0 ? from === null && to === null : from === expectedFrom && to === expectedFrom + p.count - 1;
  return range && (p.next === null || p.count === size);
}

/** Every page of the API: the listings seen (a job listed twice with the same content kept once, as its last entry). */
/** Every page of the API up to the page cap; `truncated` when a next page remained (old: partial, what was read still written). */
export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ListingInput[]; truncated: boolean; rejected: number; examined: number }> {
  const byId = new Map<string, ListingInput>();
  let url: string | null = ENDPOINT, page = 1, seen = 0, rejected = 0, examined = 0, pageSize: number | null = null;
  while (url && page <= MAX_PAGES) {
    const r = await fetcher.get({
      url, maxBytes: MAX_BYTES, timeoutMs: 25_000,
      headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/json" },
    });
    const p = parsePage(r.body, page);
    if (!consistent(p, page, pageSize)) throw new SourceError(`arbeitnow: inconsistent pagination on page ${page}`);
    pageSize ??= p.meta.per_page as number;
    seen += p.count;
    rejected += p.rejected;
    examined += p.examined;
    for (const l of p.listings) {
      const previous = byId.get(l.external_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(l)) throw new SourceError("arbeitnow: listing changed during pagination");
      byId.set(l.external_id, l);
    }
    url = p.next;
    page++;
  }
  return { seen, listings: [...byId.values()], truncated: url !== null, rejected, examined };
}

/**
 * The source's own rule (old arbeitnow.ts:196-201): remote contract listings published in the last 90 days, none in the future.
 * The old `score > 0` is the shared screen's: evaluate excludes category score 0 ("不在目前接案專長範圍").
 */
export function keep(l: ListingInput, now: Date): boolean {
  const at = Date.parse(l.published_at!);
  return l.extra.remote_evidence === true && l.kind === "contract" && now.getTime() - FRESH_MS <= at && at <= now.getTime();
}

export async function arbeitnowConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const { seen, listings, truncated, rejected, examined } = await scan(fetcher);
  // Old arbeitnow.ts:200 `exists ||`: stored listings are refreshed whatever the rule says.
  const kept = listings.filter((l) => keep(l, now));
  return { seen, listings: kept, others: listings.filter((l) => !kept.includes(l)), truncated, rejected, examined };
}

/** Catalog entry without its order (the orchestrator wires it): up to 20 pages, 3 s apart (old arbeitnow.ts:146,155). */
export const ARBEITNOW_SETTINGS: Omit<SourceSettings, "order"> = {
  name: "arbeitnow", connector: arbeitnowConnector, maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: MAX_PAGES, disabled: null,
};
