import { load } from "cheerio";
import { parseJobInput, type JobInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { setAside } from "../shared/set-aside";
import { pubDateInstant } from "../shared/time";

export { pubDateInstant };
import { SourceError, type Collected, type PageSourceSettings } from "../types";
import { childText, children, parseXml, type XmlElement } from "../shared/xml-feed";

// CryptoJobsList: the official advertised RSS feed, without API keys or account access (old
// collection/cryptojobslist.py, web/src/modules/collection/sources/cryptojobslist.ts at ce1254d).
// One request per run. A feed that is empty, oversize, declares a DTD, is not well-formed or is not
// RSS with 1–2000 items is refused. An item without its identity (its job URL on the board, a
// media:canonical that disagrees with it, a title, a description, or one over the size caps) is set
// aside and counted in `rejected`, as the old reader did; more than half set aside fails the source
// (services/collect, Will 2026-11-15). A publication date the connector
// cannot read is unknown (plan D8). The source's own rule keeps remote part-time or freelance jobs.

export const FEED = "https://api.cryptojobslist.com/jobs.rss";
const LIMIT = 2_000_000;
const MEDIA = "{http://search.yahoo.com/mrss/}";

/** Old cryptojobslist.ts:117 sends one GET per run. */
export const CRYPTOJOBSLIST_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  label: "CryptoJobsList", name: "cryptojobslist", connector: cryptojobslistConnector, maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

/**
 * The job's canonical URL, which is its external_id: `https://cryptojobslist.com/jobs/<slug>` without
 * query or fragment, or null. Read with the standard URL parser (plan D10: no stored ids to match), so
 * a default port or surrounding spaces name the same job.
 */
export function canonicalJobUrl(value: string | null): string | null {
  if (value === null || !URL.canParse(value)) return null;
  const u = new URL(value);
  return u.protocol === "https:" && u.host === "cryptojobslist.com" && !u.username && !u.password && /^\/jobs\/[a-z0-9][a-z0-9-]+$/.test(u.pathname)
    ? `https://cryptojobslist.com${u.pathname}` : null;
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
          const u = URL.canParse(n.attribs.href) ? new URL(n.attribs.href) : null;
          if (u?.protocol === "https:" && u.host === "cryptojobslist.com") found.add(u.pathname.replace(/^\/+|\/+$/g, ""));
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

/** One RSS item in the contract; throws SourceError when its identity is missing (`setAside` sets that one listing aside). */
export function normalizeItem(item: XmlElement): JobInput {
  const link = childText(item, "link");
  const id = canonicalJobUrl(link);
  if (id === null) throw new SourceError("cryptojobslist: invalid job URL");
  const advertised = childText(item, MEDIA + "canonical");
  if (advertised && canonicalJobUrl(advertised) !== id) throw new SourceError("cryptojobslist: canonical URL disagrees with the link");
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
  return parseJobInput({
    // The shown URLs are the job's canonical URL too, as the old connector stored them (fixture cases 34, 41).
    external_id: id, title, description, url: id, canonical_url: id, location, kind,
    taiwan_eligible: REGIONAL.test(location ?? "") ? false : null, complete: false,
    published_at: publication ? pubDateInstant(publication) : null,
    extra: { employment_tags: tagList, remote_evidence: tagList.includes("remote") || REMOTE.test(location ?? "") },
  });
}

/** Every item of the feed in the contract (an id listed twice keeps its last entry) and the item count. */
export function parseItems(body: Uint8Array): Omit<Collected<JobInput>, "sourceKept"> {
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
  // Old cryptojobslist.ts:99-107: an item that fails to normalize is set aside and counted, the rest kept.
  const { listings, rejected, examined } = setAside(items, (i) => normalizeItem(i));
  const byId = new Map(listings.map((l) => [l.external_id, l]));
  return { seen: items.length, listings: [...byId.values()], rejected, examined };
}

/** The feed's items, marked by the source's rule: remote, part-time or freelance. */
export function parseFeed(body: Uint8Array): Collected<JobInput> {
  const all = parseItems(body);
  return { seen: all.seen, listings: all.listings, sourceKept: (l) => l.extra.remote_evidence === true && l.kind === "contract", rejected: all.rejected, examined: all.examined };
}

export async function cryptojobslistConnector(fetcher: Fetcher): Promise<Collected<JobInput>> {
  const r = await fetcher.get({
    url: FEED, maxBytes: LIMIT, timeoutMs: 25_000,
    headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/rss+xml" },
  });
  return parseFeed(r.body);
}
