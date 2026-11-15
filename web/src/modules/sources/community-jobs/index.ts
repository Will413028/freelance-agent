import { parseLegacyIsoTime, parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { SourceError, type Collected, type SourceSettings } from "../types";
import { childText, children, parseXml, splitUrl } from "../shared/xml-feed";

// Public community hiring leads: Hacker News "Who is hiring?" and "Freelancer?" threads, and V2EX's
// outsourcing node (old collection/community_jobs.py, web/src/modules/collection/sources/community-jobs.ts
// until step 11). No accounts, messaging or employer-link fetching. A response that is not the expected
// shape, or a lead without its identity (id, text, its own link), refuses the whole source run, so a
// format change is a failed source and never an empty success; other fields the connector cannot read
// are unknown (plan D8). Each source's own rules pick the leads: contract or part-time HN comments in
// the two latest recent hiring threads, V2EX posts asking for help from the last 90 days.
// seen counts the leads the source's rules picked, as the old daily run reported it.

const LIMIT = 2_000_000;
const DAY_MS = 86_400_000;
const HEADERS = { "User-Agent": "side-income/0.1 personal-job-discovery" };

/**
 * Old community-jobs.ts:142-167: the user, its first 6 submissions, then up to 100 comments in each of at most 2 threads.
 * The old 90 s budget for the whole source (:131) is not carried over: the old connector read 8 at a time, while the
 * Fetcher serves one request at a time at least a second apart, so the full read takes up to about 207 s and a 90 s
 * budget would fail every run. The request cap bounds what is read exactly as before.
 */
export const HACKERNEWS_SETTINGS: Omit<SourceSettings, "order"> = {
  name: "hackernews", connector: hackernewsConnector, maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1 + 6 + 2 * 100, disabled: null,
};
/** Old community-jobs.ts:140: one feed request. */
export const V2EX_SETTINGS: Omit<SourceSettings, "order"> = {
  name: "v2ex", connector: v2exConnector, maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, disabled: null,
};

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);
/** Truthiness of a JSON value as the old Python reader judged `deleted` and `dead`. */
const truthy = (v: unknown) => v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && !v.length) && !(isObject(v) && !Object.keys(v).length);
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

/** One HN comment as a lead, or null when the source's rules skip it; throws SourceError when it is not a comment object or lacks its identity. */
export function hnListing(p: unknown, parent: Json): ListingInput | null {
  if (!isObject(p)) throw new SourceError("hackernews: a comment is not an object");
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
  if (!isObject(t) || t.by !== "whoishiring" || t.type !== "story" || truthy(t.deleted) || truthy(t.dead)) return false;
  const title = t.title ?? "";
  if (typeof title !== "string") throw new SourceError("hackernews: thread title is not text");
  if (!title.startsWith("Ask HN: Who is hiring?") && !title.startsWith("Ask HN: Freelancer?")) return false;
  if (typeof t.time !== "number" || !Number.isFinite(t.time)) throw new SourceError("hackernews: thread without a time");
  return t.time * 1000 >= cutoffMs;
}

export async function hackernewsConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const user = await getJson(fetcher, "user/whoishiring");
  if (!isObject(user) || !Array.isArray(user.submitted)) throw new SourceError("hackernews: user without submissions");
  const threads: Json[] = [];
  for (const id of user.submitted.slice(0, 6)) threads.push(await item(fetcher, id));
  const cutoff = now.getTime() - 62 * DAY_MS;
  const selected = threads.filter((t) => hiringThread(t, cutoff)).slice(0, 2);
  if (!selected.length) throw new SourceError("hackernews: no recent hiring thread");
  const all: ListingInput[] = [];
  for (const thread of selected) {
    const kids = "kids" in thread ? thread.kids : [];
    if (!Array.isArray(kids)) throw new SourceError("hackernews: comments are not a list");
    const comments: Json[] = [];
    for (const id of kids.slice(0, 100)) comments.push(await item(fetcher, id));
    for (const p of comments) {
      if (!("id" in thread)) throw new SourceError("hackernews: thread without id");
      const l = hnListing(p, thread.id);
      if (l) all.push(l);
    }
  }
  return { seen: all.length, listings: [...new Map(all.map((l) => [l.external_id, l])).values()] };
}

// V2EX: the outsourcing node's Atom feed.
const ATOM = "{http://www.w3.org/2005/Atom}";
const SKIP = /承接|接单|接單|接活|自荐|自薦|作品展示|出售|广告联盟|廣告聯盟|假如|如果/u;
// "." as in Python: anything but a newline.
const WANTED = /招聘|寻找|尋找|求助|需求|外包|找[^\n]{0,20}(开发|開發|工程师|工程師|大佬)|有[^\n]{0,20}项目/u;

/** bytes.upper(): ASCII letters only, so the DTD check cannot be dodged by a non-ASCII case mapping. */
const asciiUpper = (raw: Uint8Array) => Buffer.from(raw.map((b) => (b >= 0x61 && b <= 0x7a ? b - 0x20 : b))).toString("latin1");

/**
 * The topic number of a V2EX link, which is the external_id, or null. Compatibility function
 * (spikes.md section 3): the stored ids came from Python urlsplit and a Unicode `\d`; WHATWG URL would
 * percent-encode a path of non-ASCII digits (fixture case) and accept another host case.
 */
export function v2exTopicId(href: string): string | null {
  const u = splitUrl(href), m = /^\/t\/(\p{Nd}+)$/u.exec(u.path);
  return u.scheme === "https" && u.netloc === "www.v2ex.com" && m ? m[1] : null;
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
  const all: ListingInput[] = [];
  for (const e of entries) {
    const title = childText(e, ATOM + "title") || "";
    if (SKIP.test(title) || !WANTED.test(title)) continue;
    const links = children(e, ATOM + "link").filter((x) => x.attrs.get("rel") === "alternate").map((x) => x.attrs.get("href"));
    if (links.length !== 1 || links[0] === undefined) throw new SourceError("v2ex: entry without one canonical link");
    const id = v2exTopicId(links[0]);
    if (id === null) throw new SourceError("v2ex: invalid canonical link");
    // The age rule reads the publication time, so an entry without a time zone refuses the run.
    const published = parseLegacyIsoTime((childText(e, ATOM + "published") || "").replaceAll("Z", "+00:00"));
    if (published?.kind !== "aware") throw new SourceError("v2ex: entry without a publication time with zone");
    if (published.instant.getTime() < cutoff) continue;
    const body = htmlText(childText(e, ATOM + "content") || "");
    const url = `https://www.v2ex.com/t/${id}`;
    all.push(parseListingInput({
      external_id: id, title: checked("v2ex", title, body || title), description: body || title, url, canonical_url: url,
      kind: "contract", complete: false, published_at: rfc3339(published.instant), extra: { body_available: Boolean(body) },
    }));
  }
  return { seen: all.length, listings: [...new Map(all.map((l) => [l.external_id, l])).values()] };
}

export async function v2exConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const r = await fetcher.get({ url: "https://www.v2ex.com/feed/outsourcing.xml", maxBytes: LIMIT, timeoutMs: 8_000, headers: HEADERS });
  return parseV2ex(r.body, now);
}
