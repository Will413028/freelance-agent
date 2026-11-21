import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import { parseIsoTime } from "../shared/time";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";
import { childText, children, parseXml } from "../shared/xml-feed";
import { isObject, truthy, type Json } from "../shared/json";

// Public community hiring leads: Hacker News "Who is hiring?" and "Freelancer?" threads, and V2EX's
// outsourcing node (old collection/community_jobs.py, web/src/modules/collection/sources/community-jobs.ts
// at ce1254d). No accounts, messaging or employer-link fetching. A response that is not the expected
// shape refuses the whole source run, so a format change is a failed source and never an empty success.
// A lead without its identity (id, text, its own link, a zoned publication time on V2EX) is set aside
// and counted in `rejected`; more than half set aside fails the source (services/collect, Will
// 2026-11-15; the old reader refused the run for one lead). Other fields the connector cannot read
// are unknown (plan D8). Each source's own rules pick the leads: contract or part-time HN comments in
// the two latest recent hiring threads, V2EX posts asking for help from the last 90 days.
// seen counts the leads the source's rules picked, as the old daily run reported it; examined counts
// every entry checked (picked, skipped by the rules or set aside), the threshold's denominator.

const LIMIT = 2_000_000;
const DAY_MS = 86_400_000;
const HEADERS = { "User-Agent": "side-income/0.1 personal-job-discovery" };

/**
 * Old community-jobs.ts:142-167: the user, its first 6 submissions, then up to 100 comments in each of at most 2 threads.
 * The old 90 s budget for the whole source (:131) is not carried over: the old connector read 8 at a time, while the
 * Fetcher serves one request at a time at least a second apart, so the full read takes up to about 207 s and a 90 s
 * budget would fail every run. The request cap bounds what is read exactly as before.
 */

/** Neither board has a per-listing rule of its own: every listing read passes it. */
const keepAll = () => true;

export const HACKERNEWS_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  label: "Hacker News", name: "hackernews", connector: hackernewsConnector, maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1 + 6 + 2 * 100, completeRead: false, disabled: null,
};
/** Old community-jobs.ts:140: one feed request. */
export const V2EX_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  label: "V2EX", name: "v2ex", connector: v2exConnector, maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

/** The first n code points. */
const head = (s: string, n: number) => [...s].slice(0, n).join("");
const rfc3339 = (d: Date) => (Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1 && d.getUTCFullYear() <= 9999 ? d.toISOString() : null);
/** The listing's checks shared by both boards: a title with text, a description of at most 100,000 code points. */
function checked(source: string, title: string, description: string) {
  if (!title.trim() || [...description].length > 100_000) throw new SourceError(`${source}: invalid listing`);
  return head(title, 500);
}

// Hacker News. Patterns as the old Python ones (IGNORECASE; \b on Unicode word characters).
const W = String.raw`[\p{L}\p{N}_]`;
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
// Python's IGNORECASE also matched "İ" and "ı" for "i"; JavaScript's case folding does not.
const re = (pattern: string) => new RegExp(pattern.replace(/[iI]/g, "[iIİı]").replaceAll("\\b", B), "iu");
const SEEKING = re(String.raw`^(seeking work|for hire|looking for work)\b`);
const NO_CONTRACT = re(String.raw`\b(no contractors?|no freelance|full[ -]?time only|part[ -]?time not available)\b`);
const CONTRACT = re(String.raw`\b(part[ -]?time|contract(?:or|ing)?|freelance|fractional)\b`);
const RESTRICTED = re(String.raw`\b(?:USA?|UK|EU|Europe|Canada|Australia)\s+only\b|REMOTE\s*\((?:EU|US|USA|UK|Europe)\)|\b(?:Poland|Romania|Romanian)(?: or (?:Poland|Romania|Romanian))? residents only`);

/** One HN comment as a lead, or null when the source's rules skip it; throws SourceError when it is not a comment object or lacks its identity (`setAside` sets that one listing aside). */
export function hnListing(p: unknown, parent: Json): ListingInput | null {
  if (!isObject<Json>(p)) throw new SourceError("hackernews: a comment is not an object");
  if (truthy(p.deleted) || truthy(p.dead)) return null;
  if (p.type !== "comment" || (p.parent ?? null) !== parent) return null;
  if (typeof p.text !== "string") throw new SourceError("hackernews: comment without text");
  const text = htmlText(p.text);
  if (text.startsWith("Location:") && text.includes("Willing to relocate:")) return null;
  if (SEEKING.test(text) || NO_CONTRACT.test(text) || !CONTRACT.test(text)) return null;
  if (typeof p.id !== "number" || !Number.isSafeInteger(p.id)) throw new SourceError("hackernews: invalid comment id");
  const url = `https://news.ycombinator.com/item?id=${p.id}`;
  return parseListingInput({
    external_id: String(p.id), title: checked("hackernews", head(text, 160), text), description: text, url, canonical_url: url,
    kind: "contract", taiwan_eligible: RESTRICTED.test(text) ? false : null, complete: false,
    // HN times are Unix seconds; one that is not a whole number in range is unknown (plan D8).
    published_at: typeof p.time === "number" && Number.isSafeInteger(p.time) ? rfc3339(new Date(p.time * 1000)) : null,
    extra: { thread_id: parent },
  });
}

async function getJson(fetcher: Fetcher, path: string): Promise<Json> {
  const r = await fetcher.get({ url: `https://hacker-news.firebaseio.com/v0/${path}.json`, maxBytes: LIMIT, timeoutMs: 8_000, headers: HEADERS });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(r.body)) as Json;
  } catch {
    throw new SourceError("hackernews: response is not JSON");
  }
}

const item = (fetcher: Fetcher, id: Json) => {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new SourceError("hackernews: invalid item id");
  return getJson(fetcher, `item/${id}`);
};

/** Is this one of whoishiring's recent hiring threads? Reads title and time, so a thread missing them refuses the run. */
function hiringThread(t: Json, cutoffMs: number): t is Record<string, Json> {
  if (!isObject<Json>(t) || t.by !== "whoishiring" || t.type !== "story" || truthy(t.deleted) || truthy(t.dead)) return false;
  const title = t.title ?? "";
  if (typeof title !== "string") throw new SourceError("hackernews: thread title is not text");
  if (!title.startsWith("Ask HN: Who is hiring?") && !title.startsWith("Ask HN: Freelancer?")) return false;
  if (typeof t.time !== "number" || !Number.isFinite(t.time)) throw new SourceError("hackernews: thread without a time");
  return t.time * 1000 >= cutoffMs;
}

export async function hackernewsConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const user = await getJson(fetcher, "user/whoishiring");
  if (!isObject<Json>(user) || !Array.isArray(user.submitted)) throw new SourceError("hackernews: user without submissions");
  const threads: Json[] = [];
  for (const id of user.submitted.slice(0, 6)) threads.push(await item(fetcher, id));
  const cutoff = now.getTime() - 62 * DAY_MS;
  const selected = threads.filter((t) => hiringThread(t, cutoff)).slice(0, 2);
  if (!selected.length) throw new SourceError("hackernews: no recent hiring thread");
  const all: ListingInput[] = [];
  let rejected = 0, examined = 0;
  for (const thread of selected) {
    const kids = "kids" in thread ? thread.kids : [];
    if (!Array.isArray(kids)) throw new SourceError("hackernews: comments are not a list");
    const comments: Json[] = [];
    for (const id of kids.slice(0, 100)) comments.push(await item(fetcher, id));
    if (comments.length && !("id" in thread)) throw new SourceError("hackernews: thread without id");
    // One comment without its identity is set aside (Will 2026-11-15); the old run refused the source.
    const kept = setAside(comments, (p) => hnListing(p, thread.id));
    for (const l of kept.listings) if (l) all.push(l);
    rejected += kept.rejected;
    examined += kept.examined;
  }
  return { seen: all.length, listings: [...new Map(all.map((l) => [l.external_id, l])).values()], sourceKept: keepAll, rejected, examined };
}

// V2EX: the outsourcing node's Atom feed.
const ATOM = "{http://www.w3.org/2005/Atom}";
const SKIP = /承接|接单|接單|接活|自荐|自薦|作品展示|出售|广告联盟|廣告聯盟|假如|如果/u;
// "." as in Python: anything but a newline.
const WANTED = /招聘|寻找|尋找|求助|需求|外包|找[^\n]{0,20}(开发|開發|工程师|工程師|大佬)|有[^\n]{0,20}项目/u;

/** bytes.upper(): ASCII letters only, so the DTD check cannot be dodged by a non-ASCII case mapping. */
const asciiUpper = (raw: Uint8Array) => Buffer.from(raw.map((b) => (b >= 0x61 && b <= 0x7a ? b - 0x20 : b))).toString("latin1");

/**
 * The topic number of a V2EX link, which is the external_id, or null. Read with the standard URL
 * parser (plan D10: no stored ids to match): ASCII digits only, the host in any case.
 */
export function v2exTopicId(href: string): string | null {
  if (!URL.canParse(href)) return null;
  const u = new URL(href), m = /^\/t\/([0-9]+)$/.exec(u.pathname);
  return u.protocol === "https:" && u.host === "www.v2ex.com" && !u.username && !u.password && m ? m[1] : null;
}

/** The feed's leads the source's rule keeps: titles asking for help, published in the last 90 days. */
export function parseV2ex(raw: Uint8Array, now: Date): Collected {
  if (raw.length > LIMIT) throw new SourceError("v2ex: oversize feed");
  const upper = asciiUpper(raw);
  if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) throw new SourceError("v2ex: XML declarations forbidden");
  let root;
  try {
    root = parseXml(raw);
  } catch {
    throw new SourceError("v2ex: feed is not well-formed XML");
  }
  if (root.tag !== ATOM + "feed") throw new SourceError("v2ex: expected an Atom feed");
  const entries = children(root, ATOM + "entry");
  if (entries.length > 100) throw new SourceError("v2ex: over 100 entries");
  const cutoff = now.getTime() - 90 * DAY_MS;
  // One entry without its identity is set aside (Will 2026-11-15); the old run refused the source.
  const picked = setAside(entries, (e): ListingInput | null => {
    const title = childText(e, ATOM + "title") || "";
    if (SKIP.test(title) || !WANTED.test(title)) return null;
    const links = children(e, ATOM + "link").filter((x) => x.attrs.get("rel") === "alternate").map((x) => x.attrs.get("href"));
    if (links.length !== 1 || links[0] === undefined) throw new SourceError("v2ex: entry without one canonical link");
    const id = v2exTopicId(links[0]);
    if (id === null) throw new SourceError("v2ex: invalid canonical link");
    // The age rule reads the publication time, so an entry without a time zone is set aside.
    const published = parseIsoTime(childText(e, ATOM + "published") || "");
    if (published?.kind !== "aware") throw new SourceError("v2ex: entry without a publication time with zone");
    if (published.instant.getTime() < cutoff) return null;
    const body = htmlText(childText(e, ATOM + "content") || "");
    const url = `https://www.v2ex.com/t/${id}`;
    return parseListingInput({
      external_id: id, title: checked("v2ex", title, body || title), description: body || title, url, canonical_url: url,
      kind: "contract", complete: false, published_at: rfc3339(published.instant), extra: { body_available: Boolean(body) },
    });
  });
  const all = picked.listings.filter((l): l is ListingInput => l !== null);
  return { seen: all.length, listings: [...new Map(all.map((l) => [l.external_id, l])).values()], sourceKept: keepAll, rejected: picked.rejected, examined: picked.examined };
}

export async function v2exConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const r = await fetcher.get({ url: "https://www.v2ex.com/feed/outsourcing.xml", maxBytes: LIMIT, timeoutMs: 8_000, headers: HEADERS });
  return parseV2ex(r.body, now);
}
