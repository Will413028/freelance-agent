import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { pubDateInstant } from "../shared/time";

export { pubDateInstant };
import { SourceError, type Collected, type SourceSettings } from "../types";
import { childText, children, parseXml, splitUrl, type XmlElement } from "../shared/xml-feed";

// CryptoJobsList: the official advertised RSS feed, without API keys or account access (old
// collection/cryptojobslist.py, web/src/modules/collection/sources/cryptojobslist.ts until step 11).
// One request per run. A feed that is empty, oversize, declares a DTD, is not well-formed or is not
// RSS with 1–2000 items is refused; so is any item without its identity (its job URL on the board, a
// media:canonical that disagrees with it, a title, a description, or one over the size caps), so a
// format change is a failed source and never a partial success. A publication date the connector
// cannot read is unknown (plan D8). The source's own rule keeps remote part-time or freelance jobs.

export const FEED = "https://api.cryptojobslist.com/jobs.rss";
const LIMIT = 2_000_000;
const MEDIA = "{http://search.yahoo.com/mrss/}";

/** Old cryptojobslist.ts:117 sends one GET per run. */
export const CRYPTOJOBSLIST_SETTINGS: Omit<SourceSettings, "order"> = {
  name: "cryptojobslist", connector: cryptojobslistConnector, maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, disabled: null,
};

/**
 * The job's canonical URL, which is its external_id: `https://cryptojobslist.com/jobs/<slug>` without
 * query or fragment, or null. Compatibility function (spikes.md section 3): stored ids were made by
 * Python urlsplit, which keeps the host exactly as written; WHATWG URL would also accept a default
 * port (`:443`) or a trailing space, which the old reader refused (fixture cases).
 */
export function canonicalJobUrl(value: string | null): string | null {
  if (value === null) return null;
  const u = splitUrl(value);
  return u.scheme === "https" && u.netloc === "cryptojobslist.com" && /^\/jobs\/[a-z0-9][a-z0-9-]+$/.test(u.path) ? `https://cryptojobslist.com${u.path}` : null;
}

const cmpCodePoints = (a: string, b: string) => {
  const x = [...a].map((c) => c.codePointAt(0)!), y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

/** The part of a cheerio (domhandler) node the tag reader walks. */
type DomNode = { type: string; data?: string; name?: string; attribs?: Record<string, string>; children?: DomNode[] };

/** The board's tags: the links of the feed's first paragraph after its "Tags:" label, not links in employer text. */
export function tags(html: string): string[] {
  const $ = load(html, null, false);
  const first = $("p").first().get(0) as unknown as DomNode | undefined;
  const found = new Set<string>();
  let label = false, stop = false;
  const walk = (node: DomNode) => {
    for (const n of node.children ?? []) {
      if (stop) return;
      if (n.type === "text") {
        if (n.data!.trim().startsWith("Tags:")) label = true;
      } else if (n.type === "tag") {
        if (n.name === "h2" || n.name === "h3") return void (stop = true);
        if (n.name === "a" && label && n.attribs?.href !== undefined) {
          const u = splitUrl(n.attribs.href);
          if (u.scheme === "https" && u.netloc === "cryptojobslist.com") found.add(u.path.replace(/^\/+|\/+$/g, ""));
        }
        walk(n);
      }
    }
  };
  if (first) walk(first);
  return [...found].sort(cmpCodePoints);
}

const W = String.raw`[\p{L}\p{N}_]`;
/** Whole words, ignoring case as the old Python patterns did: there "i" also matched "İ" and "ı". */
const word = (alternatives: string) => new RegExp(`(?<!${W})(?:${alternatives.replace(/i/gi, "[iIİı]")})(?!${W})`, "iu");
const REGIONAL = word("US only|USA only|United States|Europe only|UK only");
const REMOTE = word("remote");

/** Visible text of a feed field, or null when it is missing, blank, over 200,000 characters or shows nothing. */
function feedText(value: string | null): string | null {
  if (value === null || !value.trim() || [...value].length > 200_000) return null;
  return htmlText(value) || null;
}

/** One RSS item in the contract; throws SourceError when its identity is missing. */
export function normalizeItem(item: XmlElement): ListingInput {
  const url = canonicalJobUrl(childText(item, "link"));
  if (url === null) throw new SourceError("cryptojobslist: invalid job URL");
  const advertised = childText(item, MEDIA + "canonical");
  if (advertised && canonicalJobUrl(advertised) !== url) throw new SourceError("cryptojobslist: canonical URL disagrees with the link");
  const title = feedText(childText(item, "title"));
  const html = childText(item, "description");
  const description = feedText(html);
  if (title === null || description === null) throw new SourceError("cryptojobslist: title and full description required");
  if ([...title].length > 500 || [...description].length > 100_000) throw new SourceError("cryptojobslist: oversize listing");
  const tagList = tags(html!);
  // "contract" also names smart-contract engineering on this board; it is not an employment type.
  const kind = tagList.includes("full-time") ? "full_time" : tagList.some((t) => t === "part-time" || t === "freelance") ? "contract" : null;
  const location = (childText(item, MEDIA + "location") ?? "").trim() || null;
  const publication = childText(item, "pubDate");
  return parseListingInput({
    external_id: url, title, description, url, canonical_url: url, location, kind,
    taiwan_eligible: REGIONAL.test(location ?? "") ? false : null, complete: false,
    published_at: publication ? pubDateInstant(publication) : null,
    extra: { employment_tags: tagList, remote_evidence: tagList.includes("remote") || REMOTE.test(location ?? "") },
  });
}

/** Every item of the feed in the contract (an id listed twice keeps its last entry) and the item count. */
export function parseItems(body: Uint8Array): Collected {
  if (!body.length || body.length > LIMIT) throw new SourceError("cryptojobslist: empty or oversize feed");
  if (/<![ \t\n\r\f\v]*(?:DOCTYPE|ENTITY)\b/i.test(Buffer.from(body).toString("latin1"))) throw new SourceError("cryptojobslist: XML declarations forbidden");
  let root: XmlElement;
  try {
    root = parseXml(body);
  } catch {
    throw new SourceError("cryptojobslist: feed is not well-formed XML");
  }
  const channels = root.tag === "rss" ? children(root, "channel") : [];
  if (!channels.length) throw new SourceError("cryptojobslist: expected an RSS channel");
  const items = channels.flatMap((c) => children(c, "item"));
  if (!items.length || items.length > 2000) throw new SourceError("cryptojobslist: feed has no list of 1-2000 items");
  const byId = new Map(items.map((i) => normalizeItem(i)).map((l) => [l.external_id, l]));
  return { seen: items.length, listings: [...byId.values()] };
}

/** The feed's items and the ones the source's rule keeps: remote, part-time or freelance. */
export function parseFeed(body: Uint8Array): Collected {
  const all = parseItems(body);
  // Old cryptojobslist.ts:131 `exists ||`: stored listings are refreshed whatever the rule says.
  const kept = all.listings.filter((l) => l.extra.remote_evidence === true && l.kind === "contract");
  return { seen: all.seen, listings: kept, others: all.listings.filter((l) => !kept.includes(l)) };
}

export async function cryptojobslistConnector(fetcher: Fetcher): Promise<Collected> {
  const r = await fetcher.get({
    url: FEED, maxBytes: LIMIT, timeoutMs: 25_000,
    headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/rss+xml" },
  });
  return parseFeed(r.body);
}
