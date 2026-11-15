import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints, isObject, truthy } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { pyStrip, visibleLines } from "../shared/text";
import { pubDateInstant } from "../shared/time";
import { childText, children, parseXmlText } from "../shared/xml-feed";
import { SourceError, type Collected, type SourceSettings } from "../types";

// Official public feeds read as configuration (plan step 5b; old collection/public_feeds.py,
// web/src/modules/collection/sources/public-feeds.ts until step 11): Remote OK and Working Nomads
// answer a JSON list, Real Work From Anywhere and We Work Remotely an RSS feed. One request per run;
// the latest 200 entries are read, and a feed with more is truncated (old partial). A feed that is
// empty, oversize, not the expected shape, or declares a DTD fails the source. An entry without its
// identity (its job URL on the board, Remote OK's numeric id, a title and description with text,
// a title within 500 characters) is set aside and counted in `rejected`; more than half set aside
// fails the source (services/collect, Will 2026-11-15). Other fields the connector cannot read are
// unknown (plan D8): a publication time, tags or a location the old reader refused the entry for.
// The source's own rule keeps contract or part-time jobs published in the last 90 days; a job with
// an unknown publication time is not kept, since its age cannot be shown.

const MAX_BYTES = 8_000_000;
const MAX_ITEMS = 200;
const DAY_MS = 86_400_000;
const FRESH_DAYS = 90;

export type FeedName = "remoteok" | "realworkfromanywhere" | "weworkremotely" | "workingnomads";

/** What differs between the four feeds; everything else is one reader. */
type Feed = {
  endpoint: string;
  format: "json" | "rss";
  /** The board's job URLs: https on this host, a path starting with `prefix` and longer than it. */
  host: string;
  prefix: string;
  /** A stricter whole-path rule, when the board has one. */
  path?: RegExp;
  /** Remote OK names its jobs by a numeric id; the others by their canonical job URL. */
  idField?: string;
  titleField: string;
  dateField: string;
  /** Working Nomads sends tags as one comma-separated string. */
  csvTags?: boolean;
};

export const FEEDS: Record<FeedName, Feed> = {
  remoteok: { endpoint: "https://remoteok.com/api", format: "json", host: "remoteok.com", prefix: "/remote-jobs/", idField: "id", titleField: "position", dateField: "date" },
  realworkfromanywhere: { endpoint: "https://www.realworkfromanywhere.com/rss.xml", format: "rss", host: "www.realworkfromanywhere.com", prefix: "/jobs/", titleField: "title", dateField: "date" },
  weworkremotely: { endpoint: "https://weworkremotely.com/remote-jobs.rss", format: "rss", host: "weworkremotely.com", prefix: "/remote-jobs/", titleField: "title", dateField: "date" },
  workingnomads: { endpoint: "https://www.workingnomads.com/api/exposed_jobs/", format: "json", host: "www.workingnomads.com", prefix: "/job/go/", path: /^\/job\/go\/[0-9]+\/$/, titleField: "title", dateField: "pub_date", csvTags: true },
};

/** Old public-feeds.ts:159-172: one GET per run per feed, without redirects. */
const settings = (name: FeedName): Omit<SourceSettings, "order"> => ({
  name, connector: (fetcher, now) => publicFeedConnector(name, fetcher, now), maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
});
export const REMOTEOK_SETTINGS = settings("remoteok");
export const REALWORKFROMANYWHERE_SETTINGS = settings("realworkfromanywhere");
export const WEWORKREMOTELY_SETTINGS = settings("weworkremotely");
export const WORKINGNOMADS_SETTINGS = settings("workingnomads");

// Python's Unicode \b and IGNORECASE (where "i" also matched "İ" and "ı"), as the old patterns read.
const W = String.raw`[\p{L}\p{N}_]`;
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const re = (pattern: string, flags = "iu") => new RegExp(pattern.replace(/[iI]/g, "[iIİı]").replaceAll("\\b", B), flags);
// Body evidence must describe employment, not e.g. smart-contract development.
const EXPLICIT_TYPE = re(String.raw`(?:employment|job|work|position)\s*type\s*[:：]\s*([^\n.;]+)`, "giu");
const EXPLICIT_BASIS = re(String.raw`(?:position|role|job)\s+(?:is\s+)?(?:offered\s+)?(?:on\s+)?(?:a\s+)?(?:part[ -]time|freelance|contract(?:or)?)(?:\s+basis)?\b`, "giu");
const SMART_CONTRACT = re(String.raw`\bsmart[ -]+contracts?\b`, "giu");
const FULL_TIME = re(String.raw`\bfull[\s_-]*time\b`);
const CONTRACT = re(String.raw`\b(?:part[\s_-]*time|freelance|contract(?:or)?)\b`);
const CLOSED = re(String.raw`\b(?:position|job|listing)\s+(?:is\s+)?(?:closed|filled|expired)\b`);

/** Visible text of a feed field, keeping its lines; throws SourceError when it is missing, blank, over 200,000 characters or shows nothing. */
function feedText(name: FeedName, value: unknown, what: string): string {
  if (typeof value !== "string" || !pyStrip(value) || codePoints(value) > 200_000) throw new SourceError(`${name}: ${what} required`);
  const text = visibleLines(value);
  if (!text) throw new SourceError(`${name}: empty ${what}`);
  return text;
}

/**
 * The job's canonical URL, `https://<host><path>` without query or fragment, or null when it is not one
 * of the board's job URLs. Read with the standard URL parser (plan D10), so the host's case, a default
 * port or surrounding spaces name the same job.
 */
export function canonicalJobUrl(name: FeedName, value: unknown): string | null {
  const f = FEEDS[name];
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const u = new URL(value);
  if (u.protocol !== "https:" || u.host !== f.host || u.username || u.password) return null;
  if (!u.pathname.startsWith(f.prefix) || u.pathname.length <= f.prefix.length || (f.path && !f.path.test(u.pathname))) return null;
  return `https://${f.host}${u.pathname}`;
}

/** The entry's tags as text, or null when they are not a list of text (unknown, plan D8). */
function tagsOf(feed: Feed, raw: unknown): string[] | null {
  let tags = raw ?? [];
  if (feed.csvTags && typeof tags === "string") tags = tags.split(",").map(pyStrip).filter(Boolean);
  return Array.isArray(tags) && tags.every((t) => typeof t === "string") ? tags : null;
}

/** One entry of a feed (a JSON object, or an RSS item read into the same shape) in the contract; throws SourceError when its identity is missing. */
export function normalize(name: FeedName, entry: unknown): ListingInput {
  const feed = FEEDS[name];
  if (!isObject(entry)) throw new SourceError(`${name}: a listing is not an object`);
  const title = feedText(name, entry[feed.titleField], "title");
  if (codePoints(title) > 500) throw new SourceError(`${name}: title over 500 characters`);
  const body = feedText(name, entry.description, "description");
  const canonical = canonicalJobUrl(name, entry.url);
  if (canonical === null) throw new SourceError(`${name}: invalid job URL`);
  let id = canonical;
  if (feed.idField) {
    const raw = entry[feed.idField];
    // A JSON number past 2^53 cannot be held exactly; refusing it keeps two jobs from sharing an id.
    if (typeof raw === "number" ? !Number.isSafeInteger(raw) || raw < 0 : typeof raw !== "string" || !/^[0-9]+$/.test(raw)) throw new SourceError(`${name}: invalid listing id`);
    id = String(raw);
  }
  const evidence = entry[feed.dateField];
  const tags = tagsOf(feed, entry.tags);
  const employmentType = entry.employment_type;
  // Old public-feeds.ts:79-85: title, tags, the stated employment type and explicit body statements decide.
  let employment = [title, ...(tags ?? []), truthy(employmentType) ? String(employmentType) : ""].join(" ");
  const explicit = [...[...body.matchAll(EXPLICIT_TYPE)].map((m) => m[1]), ...[...body.matchAll(EXPLICIT_BASIS)].map((m) => m[0])];
  employment = (employment + " " + explicit.join(" ")).replace(SMART_CONTRACT, "");
  // Tags the connector cannot read leave the employment type unknown rather than judged without them.
  const kind = tags === null ? null : FULL_TIME.test(employment + "\n" + body) ? "full_time" : CONTRACT.test(employment) ? "contract" : null;
  const status = entry.status;
  const closed = entry.closed === true || (typeof status === "string" && ["closed", "expired", "filled"].includes(status)) || CLOSED.test(title + "\n" + body);
  const location = typeof entry.location === "string" ? entry.location || null : null;
  const salary = (k: string) => (truthy(entry[k]) ? entry[k] : null);
  return parseListingInput({
    external_id: id, title, description: body, url: canonical, canonical_url: canonical, location, kind, listing_closed: closed, complete: false,
    published_at: typeof evidence === "string" ? pubDateInstant(evidence) : null,
    extra: {
      publication_evidence: evidence ?? null, employment_evidence: pyStrip(employment),
      salary_evidence: { min: salary("salary_min"), max: salary("salary_max"), period: salary("salary_period") },
    },
  });
}

const ASCII_SPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
// Python's Unicode \s and \b, IGNORECASE: a declaration anywhere refuses the feed.
const DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)(?![\p{L}\p{N}_])/iu;
// Official RSS emits naked query separators in enclosure URL attributes. Only this observed defect is
// repaired; CDATA, comments and all other XML stay intact (old public-feeds.ts:106-110).
const UNTOUCHED = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/;
const ENCLOSURE_URL = /(<enclosure\b[^>]*\burl=")([^"]*)(")/g;
const NAKED_AMPERSAND = /&(?=[A-Za-z_][A-Za-z0-9_.-]*=)/g;

/** The feed's entries (at most 200) and whether it had more; throws SourceError on a feed-level refusal. */
export function entries(name: FeedName, raw: Uint8Array): { entries: unknown[]; truncated: boolean } {
  if (!raw.some((b) => !ASCII_SPACE.has(b)) || raw.length > MAX_BYTES) throw new SourceError(`${name}: empty or oversize feed`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new SourceError(`${name}: feed is not UTF-8`);
  }
  let list: unknown[];
  if (FEEDS[name].format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
    } catch {
      throw new SourceError(`${name}: feed is not JSON`);
    }
    if (!Array.isArray(data)) throw new SourceError(`${name}: feed is not a list`);
    list = data;
    // Remote OK leads with a legal notice, not a job.
    if (name === "remoteok" && isObject(list[0]) && "legal" in list[0] && !("id" in list[0])) list = list.slice(1);
  } else {
    if (DECLARATION.test(text)) throw new SourceError(`${name}: XML declarations forbidden`);
    const tokens = text.split(UNTOUCHED);
    for (let i = 0; i < tokens.length; i += 2) {
      tokens[i] = tokens[i].replace(ENCLOSURE_URL, (_, a: string, url: string, b: string) => a + url.replace(NAKED_AMPERSAND, "&amp;") + b);
    }
    let root;
    try {
      root = parseXmlText(tokens.join(""));
    } catch {
      throw new SourceError(`${name}: feed is not well-formed XML`);
    }
    const channel = root.tag === "rss" ? children(root, "channel")[0] : undefined;
    if (!channel) throw new SourceError(`${name}: expected an RSS channel`);
    list = children(channel, "item").map((item) => ({
      title: childText(item, "title"), description: childText(item, "description"), url: childText(item, "link"),
      date: childText(item, "pubDate"), location: childText(item, "region"), tags: children(item, "category").map((c) => c.text),
    }));
  }
  if (!list.length) throw new SourceError(`${name}: empty listing feed`);
  return { entries: list.slice(0, MAX_ITEMS), truncated: list.length > MAX_ITEMS };
}

/** Every entry read in the contract (an id listed twice keeps its last entry), without the source's rule. */
export function parseItems(name: FeedName, raw: Uint8Array): Omit<Collected, "sourceKept"> {
  const { entries: list, truncated } = entries(name, raw);
  const { listings, rejected, examined } = setAside(list, (e) => normalize(name, e));
  return { seen: list.length, listings: [...new Map(listings.map((l) => [l.external_id, l])).values()], truncated, rejected, examined };
}

/** The source's rule: a contract or part-time job published in the last 90 days, not in the future. */
export function kept(l: ListingInput, now: Date): boolean {
  if (l.kind !== "contract" || l.published_at === null) return false;
  const at = Date.parse(l.published_at);
  return now.getTime() - FRESH_DAYS * DAY_MS <= at && at <= now.getTime();
}

export function parseFeed(name: FeedName, raw: Uint8Array, now: Date): Collected {
  return { ...parseItems(name, raw), sourceKept: (l) => kept(l, now) };
}

export async function publicFeedConnector(name: FeedName, fetcher: Fetcher, now: Date): Promise<Collected> {
  const r = await fetcher.get({
    url: FEEDS[name].endpoint, maxBytes: MAX_BYTES, timeoutMs: 25_000,
    headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: FEEDS[name].format === "json" ? "application/json" : "application/rss+xml, application/xml" },
  });
  return parseFeed(name, r.body, now);
}
