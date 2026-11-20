import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { boardUrl, employmentTypes, jobPostings, kindOf, pageHtml, PAGE_BYTES, PAGE_TIMEOUT_MS, readDetails, USER_AGENT } from "../shared/job-pages";
import { codePoints, truthy } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { pyStrip, visibleLines } from "../shared/text";
import { parseIsoTime, pubDateInstant } from "../shared/time";
import { childText, children, parseXmlText } from "../shared/xml-feed";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// NoDesk (plan step 5c; old collection/nodesk.py, web/src/modules/collection/sources/nodesk.ts at
// ce1254d): the board's advertised RSS feed, then each recent job's public page and its JobPosting
// metadata, without account access. One feed request plus at most 20 job pages per run.
//
// Feed: empty, over 2 MB, not UTF-8, declaring a DTD or entity, not well-formed XML (after repairing
// only the two HTML entities the feed was seen to send outside CDATA), without an RSS channel, or
// without items fails the source. The first 20 items are read (more: truncated). An item whose link is
// not a NoDesk job URL or whose pubDate has no readable zoned time is set aside and counted; the
// publication time is needed because only jobs of the last 90 days get a page request. A job listed
// twice keeps its last item.
//
// Job page: one listing each. It is set aside when the page is empty, oversize, not UTF-8, has a
// metadata script that is not JSON, has not exactly one JobPosting, has no title or description text,
// a title over 500 or a description over 100,000 characters, or an employmentType that is not text or a
// list of text (the source's rule reads it). An access challenge or HTTP 401/403/429 fails the source
// (shared readDetails). validThrough that is not text is an invalid deadline, not a refusal (plan D8).
// Times in the feed carry their zone; a time without one is unknown, so the item is set aside.
//
// The source's rule (old sync, D9 sourceKept): a remote (TELECOMMUTE) contract job.

export const FEED = "https://nodesk.co/remote-jobs/index.xml";
const ORIGIN = "https://nodesk.co";
const HOST = "nodesk.co";
const ARTICLE = /^\/remote-jobs\/[a-z0-9][a-z0-9-]+\/$/;
const MAX_ITEMS = 20;
const DAY_MS = 86_400_000;
const FRESH_DAYS = 90;

/** Old nodesk.fetch: the feed plus up to 20 job pages, one second apart. */
export const NODESK_SETTINGS: Omit<PageSourceSettings, "order"> = {
  name: "nodesk", label: "NoDesk", connector: (fetcher, now) => nodeskConnector(fetcher, now), maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1 + MAX_ITEMS, completeRead: false, disabled: null,
};

/** A NoDesk job URL as `https://nodesk.co/remote-jobs/<slug>/` (the listing's id), or null when it is not one. */
export const jobUrl = (value: unknown): string | null => boardUrl(ORIGIN, HOST, ARTICLE, value);

/** One feed item: its job URL and its publication time (RFC 3339), with the pubDate as the feed wrote it. */
export type Entry = { url: string; published_at: string; pubDate: string };

// Python's Unicode \b and IGNORECASE (old DECLARATIONS): a declaration anywhere refuses the feed.
const DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)(?![\p{L}\p{N}_])/iu;
// The advertised feed contains these two HTML entities outside CDATA; only that observed defect is repaired.
const UNTOUCHED = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/;

/** The feed's first 20 items (an id listed twice keeps its last item), what was set aside, and whether it had more. */
export function parseFeed(raw: Uint8Array): { entries: Entry[]; seen: number; rejected: number; examined: number; truncated: boolean } {
  // Size, strict UTF-8 and an access challenge (a challenge page fails the source as itself, not as bad XML).
  const xml = pageHtml("nodesk", raw);
  if (DECLARATION.test(xml)) throw new SourceError("nodesk: XML declarations forbidden");
  const parts = xml.split(UNTOUCHED);
  for (let i = 0; i < parts.length; i += 2) parts[i] = parts[i].replaceAll("&ndash;", "&#8211;").replaceAll("&rsquo;", "&#8217;");
  let root;
  try {
    root = parseXmlText(parts.join(""));
  } catch {
    throw new SourceError("nodesk: feed is not well-formed XML");
  }
  const channels = root.tag === "rss" ? children(root, "channel") : [];
  if (!channels.length) throw new SourceError("nodesk: expected an RSS channel");
  // Old findall("./channel/item"): the items of every channel.
  const items = channels.flatMap((c) => children(c, "item"));
  if (!items.length) throw new SourceError("nodesk: empty feed");
  const read = items.slice(0, MAX_ITEMS);
  const { listings, rejected, examined } = setAside(read, (item): Entry => {
    const url = jobUrl(childText(item, "link"));
    if (url === null) throw new SourceError("nodesk: invalid job URL");
    const pubDate = childText(item, "pubDate");
    const at = pubDate === null ? null : pubDateInstant(pubDate);
    if (at === null) throw new SourceError("nodesk: publication time with a zone required");
    return { url, published_at: at, pubDate: pubDate! };
  });
  const entries = [...new Map(listings.map((e) => [e.url, e])).values()];
  return { entries, seen: entries.length + rejected, rejected, examined, truncated: items.length > MAX_ITEMS };
}

/** Visible text of a metadata field, keeping its lines; SourceError when it is not text, blank, over 200,000 characters or shows nothing (old text). */
function fieldText(value: unknown, what: string): string {
  if (typeof value !== "string" || !pyStrip(value) || codePoints(value) > 200_000) throw new SourceError(`nodesk: ${what} required`);
  const text = visibleLines(value);
  if (!text) throw new SourceError(`nodesk: empty ${what}`);
  return text;
}

/** validThrough in the contract's deadline shapes (old deadline kept the raw text; empty means none). */
function deadlineOf(value: unknown): ListingInput["deadline"] {
  if (!truthy(value)) return null;
  if (typeof value !== "string") return { kind: "invalid", text: JSON.stringify(value) };
  const t = parseIsoTime(value);
  if (t === null) return { kind: "invalid", text: value };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "date", date: value };
  if (t.kind === "aware") {
    const y = t.instant.getUTCFullYear();
    return Number.isFinite(t.instant.getTime()) && y >= 1 && y <= 9999 ? { kind: "instant", at: t.instant.toISOString() } : { kind: "invalid", text: value };
  }
  return { kind: "no_timezone", text: value };
}

/** One job page in the contract, for the feed item it was read for; throws SourceError when it is set aside. */
export function parseArticle(raw: Uint8Array, entry: Pick<Entry, "url" | "published_at">): ListingInput {
  const url = jobUrl(entry.url);
  if (url === null) throw new SourceError("nodesk: invalid job URL");
  const jobs = jobPostings("nodesk", pageHtml("nodesk", raw));
  if (jobs.length !== 1) throw new SourceError("nodesk: expected one JobPosting");
  const data = jobs[0];
  const title = fieldText(data.title, "title"), body = fieldText(data.description, "description");
  if (codePoints(title) > 500 || codePoints(body) > 100_000) throw new SourceError("nodesk: oversize listing");
  const types = [...new Set(employmentTypes("nodesk", data.employmentType, false).map((t) => t.toUpperCase()))].sort();
  return parseListingInput({
    external_id: url, title, description: body, url, canonical_url: url, kind: kindOf(types), complete: false,
    published_at: entry.published_at, deadline: deadlineOf(data.validThrough),
    extra: {
      employment_types: types, remote_evidence: data.jobLocationType === "TELECOMMUTE",
      location_evidence: data.applicantLocationRequirements ?? null, publication_evidence: data.datePosted ?? null,
    },
  });
}

/** The source's rule: a remote contract job (old sync: remote_evidence and kind contract). */
export const kept = (l: ListingInput): boolean => l.kind === "contract" && l.extra.remote_evidence === true;

/** Published in the last 90 days and not in the future: the old read scope for job pages (it bounds the requests, so it stays). */
const recent = (e: Entry, now: Date) => {
  const at = Date.parse(e.published_at);
  return now.getTime() - FRESH_DAYS * DAY_MS <= at && at <= now.getTime();
};

const page = (fetcher: Fetcher, url: string) => fetcher.get({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

export async function nodeskConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const feed = parseFeed((await page(fetcher, FEED)).body);
  const details = await readDetails(feed.entries.filter((e) => recent(e, now)), async (e) => parseArticle((await page(fetcher, e.url)).body, e));
  // The threshold counts what could become a listing (checklist §2), as the other page sources do: items set
  // aside in the feed plus the job pages read. Items outside the read scope (older than 90 days) are not
  // counted, so a broken job page layout is not diluted by them.
  return {
    seen: feed.seen, listings: details.listings, sourceKept: kept, truncated: feed.truncated || details.truncated,
    rejected: feed.rejected + details.rejected, examined: feed.rejected + details.examined,
  };
}
