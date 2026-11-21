import { load } from "cheerio";
import { parseJobInput, type JobInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints, isObject, truthy } from "../shared/json";
import { boardUrl, employmentTypes, jobPostings, kindOf, PAGE_BYTES, PAGE_TIMEOUT_MS, pageHtml, readDetails, USER_AGENT } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { pyRstrip, pyStrip, visibleLines } from "../shared/text";
import { parseIsoTime, pubDateInstant } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// JustRemote's public listing page and its JobPosting detail pages (plan step 5c; old
// collection/justremote.py and web/src/modules/collection/sources/justremote.ts at ce1254d). One index
// page carries the listing state as literal JSON in an inline script (never executed); a state that is
// missing, twice present, not JSON, not complete, empty or over 2,000 entries fails the source. An index
// entry without its identity (a positive integer id, a known job_type, a text category, a boolean
// is_active, a job URL on the board, a title with text, an id not already listed) is set aside and
// counted; the first of a repeated id is kept, as the old reader did. Read scope (unchanged, it bounds
// the requests): only contract or technical entries get their detail page read, in index order. A detail
// page must hold exactly one JobPosting whose title matches the entry's, within 500 / 100,000 characters,
// with readable employment types (a permanent entry must say FULL_TIME) and a publication time with a
// zone; otherwise that listing is set aside (shared readDetails). The id is JustRemote's own numeric job
// id (stable for the job; the slug in its URL is not the identity). Location restrictions that are not
// a list of text, and a deadline that cannot be read, are unknown (plan D8). The source's own rule keeps
// active, remote (TELECOMMUTE) contract jobs in a technical category published in the last 90 days.

const ORIGIN = "https://justremote.co/";
const HOST = "justremote.co";
export const INDEX = "https://justremote.co/remote-jobs";
const ARTICLE = /^\/remote-[a-z-]+-jobs\/[a-z0-9][a-z0-9-]+$/;
const TECH = new Set(["developer", "devopsandsysadmin"]);
const BROAD = new Set(["worldwide", "anywhere", "asia", "apac", "global", "taiwan", "taiwan, province of china"]);
const PREFIX = "window.__PRELOADED_STATE__ = ";
const MAX_ENTRIES = 2000;
/** The old reader paused 0.6 s per detail inside a 90 s source budget: at most about 150 details after the index. */
const MAX_DETAILS = 150;
const DAY_MS = 86_400_000;
const FRESH_DAYS = 90;

/** Old justremote.ts: one index page, then detail pages 0.6 s apart (raised to the fetcher's 1 s floor). */
export const JUSTREMOTE_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  name: "justremote", label: "JustRemote", connector: (fetcher, now) => justRemoteConnector(fetcher, now),
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1 + MAX_DETAILS, completeRead: false, disabled: null,
};

/** One valid index entry: what the detail page is checked against. */
export type Entry = {
  id: string; title: string; jobType: "permanent" | "contract"; category: string; active: boolean;
  /** null when the board's restrictions are not a list of non-blank text (unknown, plan D8). */
  locations: string[] | null;
  url: string;
};

/** Visible text of a field (old public_feeds.text); throws SourceError when missing, blank, over 200,000 characters or showing nothing. */
function fieldText(value: unknown, what: string): string {
  if (typeof value !== "string" || !pyStrip(value) || codePoints(value) > 200_000) throw new SourceError(`justremote: ${what} required`);
  const text = visibleLines(value);
  if (!text) throw new SourceError(`justremote: empty ${what}`);
  return text;
}

/** The job's URL on the board, or null (shared boardUrl: the host's case, a default port or a relative link name the same job). */
export const jobUrl = (value: unknown) => boardUrl(ORIGIN, HOST, ARTICLE, value);

/** Every inline script that assigns the preloaded state, as literal JSON; anything after the value but one ";" refuses the page. */
function states(html: string): unknown[] {
  const $ = load(html, { scriptingEnabled: false });
  const found: unknown[] = [];
  $("script").each((_, el) => {
    const raw = pyStrip($(el).text());
    if (!raw.startsWith(PREFIX)) return;
    let body = raw.slice(PREFIX.length);
    if (body.endsWith(";")) body = pyRstrip(body.slice(0, -1));
    // The old raw_decode read the value from its first character: leading space was not JSON.
    if (/^\s/.test(body)) throw new SourceError("justremote: listing state is not JSON");
    try {
      found.push(JSON.parse(body));
    } catch {
      throw new SourceError("justremote: listing state is not JSON");
    }
  });
  return found;
}

/** One index entry checked (old parse_index loop body); throws SourceError when its identity is missing. */
export function indexEntry(entry: unknown, seen?: Set<string>): Entry {
  if (!isObject(entry)) throw new SourceError("justremote: an entry is not an object");
  const raw = entry.id;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) throw new SourceError("justremote: invalid id");
  const jobType = entry.job_type;
  if (jobType !== "permanent" && jobType !== "contract") throw new SourceError("justremote: unknown employment type");
  const list = entry.location_restrictions;
  const locations = Array.isArray(list) && list.every((x) => typeof x === "string" && pyStrip(x)) ? (list as string[]) : null;
  if (typeof entry.category !== "string" || typeof entry.is_active !== "boolean") throw new SourceError("justremote: invalid category or status");
  const url = jobUrl(entry.href);
  if (url === null) throw new SourceError("justremote: invalid job URL");
  const title = fieldText(entry.title, "title");
  const id = String(raw);
  if (seen?.has(id)) throw new SourceError("justremote: duplicate id");
  seen?.add(id);
  return { id, title, jobType, category: entry.category, active: entry.is_active, locations, url };
}

/** The index page's valid entries; throws SourceError on a page-level refusal. */
export function parseIndex(raw: Uint8Array): { entries: Entry[]; rejected: number; examined: number } {
  const found = states(pageHtml("justremote", raw));
  if (found.length !== 1) throw new SourceError("justremote: missing listing state");
  const state = isObject(found[0]) ? found[0].jobsState : undefined;
  const entity = isObject(state) ? state.entity : undefined;
  const list = isObject(entity) ? entity.all : undefined;
  const meta = isObject(state) ? state.meta : undefined;
  if (!isObject(meta) || meta.status !== "success" || !Array.isArray(list) || !list.length) throw new SourceError("justremote: incomplete listing state");
  if (list.length > MAX_ENTRIES) throw new SourceError("justremote: oversize listing state");
  const ids = new Set<string>();
  const { listings: entries, rejected, examined } = setAside(list, (e) => indexEntry(e, ids));
  return { entries, rejected, examined };
}

const rfc3339 = (d: Date) => {
  const y = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && y >= 1 && y <= 9999 ? d.toISOString() : null;
};

/** validThrough in the contract's deadline shapes; absent or empty (old falsy) is none, unreadable is `invalid` (plan D8). */
function deadlineOf(value: unknown): JobInput["deadline"] {
  if (!truthy(value)) return null;
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

/** A detail page with its index entry, in the contract (old parse_article); throws SourceError when the listing must be set aside. */
export function parseArticle(raw: Uint8Array, entry: Entry): JobInput {
  const jobs = jobPostings("justremote", pageHtml("justremote", raw));
  if (jobs.length !== 1) throw new SourceError("justremote: expected one JobPosting");
  const data = jobs[0];
  const title = fieldText(data.title, "title"), body = fieldText(data.description, "description");
  if (title !== entry.title || codePoints(title) > 500 || codePoints(body) > 100_000) throw new SourceError("justremote: mismatched or oversize job");
  // The source's rule reads the kind and the publication time: either unreadable sets the listing aside.
  const types = employmentTypes("justremote", data.employmentType, false);
  const kind = kindOf(types);
  // Explicit detail metadata wins; a permanent entry the page does not call full-time is not silently accepted.
  if (entry.jobType === "permanent" && kind !== "full_time") throw new SourceError("justremote: employment mismatch");
  const evidence = data.datePosted;
  const published = typeof evidence === "string" ? pubDateInstant(evidence) : null;
  if (published === null) throw new SourceError("justremote: publication time with a zone required");
  const loc = entry.locations;
  // Restrictions that name none of the broad regions or Taiwan exclude Taiwan; none, or unreadable ones, say nothing.
  const excluded = loc !== null && loc.length > 0 && !loc.some((x) => BROAD.has(x.toLowerCase()));
  return parseJobInput({
    external_id: entry.id, title, description: body, url: entry.url, canonical_url: entry.url,
    location: loc?.join(", ") || null, kind, taiwan_eligible: excluded ? false : null,
    listing_closed: !entry.active, complete: false, published_at: published, deadline: deadlineOf(data.validThrough),
    extra: {
      category: entry.category, job_type: entry.jobType, employment_types: types, location_restrictions: loc,
      remote: data.jobLocationType === "TELECOMMUTE", publication_evidence: evidence,
    },
  });
}

/** The source's rule (old sync): active, remote, contract, technical, published in the last 90 days and not in the future. */
export function kept(l: JobInput, now: Date): boolean {
  if (l.kind !== "contract" || l.listing_closed !== false || l.extra.remote !== true || !TECH.has(l.extra.category as string) || l.published_at === null) return false;
  const at = Date.parse(l.published_at);
  return now.getTime() - FRESH_DAYS * DAY_MS <= at && at <= now.getTime();
}

const get = (fetcher: Fetcher, url: string) => fetcher.get({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

export async function justRemoteConnector(fetcher: Fetcher, now: Date): Promise<Collected<JobInput>> {
  const index = parseIndex((await get(fetcher, INDEX)).body);
  // Read scope kept from the old reader: contract or technical entries only (it bounds the requests).
  const selected = index.entries.filter((e) => e.jobType === "contract" || TECH.has(e.category));
  const details = await readDetails(selected, async (e) => parseArticle((await get(fetcher, e.url)).body, e));
  // One level for the threshold: each listing attempted counts once, refused at the index or read in detail.
  // Valid entries outside the read scope never become listings and are not counted.
  return {
    seen: index.entries.length, listings: details.listings, sourceKept: (l) => kept(l, now), truncated: details.truncated,
    rejected: index.rejected + details.rejected, examined: index.rejected + details.examined,
  };
}
