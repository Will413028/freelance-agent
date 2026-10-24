import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { decodeStrict } from "@/platform/py/codecs";
import { getCapped, loadsBytes } from "@/platform/http";
import { PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { pyFindall, pyFullmatch, pyRe, pyReSplit, pySub } from "@/platform/py/re";
import { codePoints, pyIsDigit, pyLen, pyLower, pyStr, pyStrip } from "@/platform/py/unicode";
import { urlsplit, urlunsplit } from "@/platform/py/url";
import { isDict, isList, or, PyDict, PyError, pyGet, truthy, type PyValue } from "@/platform/py/value";
import { xmlFind, xmlFindAll, xmlFindText, xmlFromString } from "@/platform/py/xml";
import { sourceBatch } from "../ingest";
import { published, text } from "./text";

// Port of collection/public_feeds.py: bounded official public feeds, with source attribution and
// manual application only. public_feeds.parse (every listing must be valid) has no production
// caller and is not ported.

export const ENDPOINTS = {
  remoteok: "https://remoteok.com/api",
  realworkfromanywhere: "https://www.realworkfromanywhere.com/rss.xml",
  weworkremotely: "https://weworkremotely.com/remote-jobs.rss",
  workingnomads: "https://www.workingnomads.com/api/exposed_jobs/",
} as const;
export type FeedSource = keyof typeof ENDPOINTS;
export const isFeedSource = (source: string): source is FeedSource => Object.hasOwn(ENDPOINTS, source);

const ATTRIBUTION: Record<FeedSource, string> = {
  remoteok: "Remote OK", realworkfromanywhere: "Real Work From Anywhere", weworkremotely: "We Work Remotely", workingnomads: "Working Nomads",
};
const HOST: Record<FeedSource, string> = {
  remoteok: "remoteok.com", realworkfromanywhere: "www.realworkfromanywhere.com", weworkremotely: "weworkremotely.com", workingnomads: "www.workingnomads.com",
};
const PREFIX: Record<FeedSource, string> = { remoteok: "/remote-jobs/", realworkfromanywhere: "/jobs/", weworkremotely: "/remote-jobs/", workingnomads: "/job/go/" };
const MAX_BYTES = 8_000_000;
const MAX_ITEMS = 200;
const DAY_US = 86_400_000_000n;
const JSON_FEEDS = new Set<string>(["remoteok", "workingnomads"]);

const get = pyGet;

// Body evidence must describe employment, not e.g. smart-contract development.
const EXPLICIT_TYPE = pyRe(String.raw`(?:employment|job|work|position)\s*type\s*[:：]\s*([^\n.;]+)`, true);
const EXPLICIT_BASIS = pyRe(String.raw`(?:position|role|job)\s+(?:is\s+)?(?:offered\s+)?(?:on\s+)?(?:a\s+)?(?:part[ -]time|freelance|contract(?:or)?)(?:\s+basis)?\b`, true);
const SMART_CONTRACT = pyRe(String.raw`\bsmart[ -]+contracts?\b`, true);
const FULL_TIME = pyRe(String.raw`\bfull[\s_-]*time\b`, true);
const CONTRACT = pyRe(String.raw`\b(?:part[\s_-]*time|freelance|contract(?:or)?)\b`, true);
const CLOSED = pyRe(String.raw`\b(?:position|job|listing)\s+(?:is\s+)?(?:closed|filled|expired)\b`, true);

/** Every regex above and below, so the golden test runs the production objects, flags included. */
export const regexes = () => ({ EXPLICIT_TYPE, EXPLICIT_BASIS, SMART_CONTRACT, FULL_TIME, CONTRACT, CLOSED, DECLARATIONS, UNTOUCHED, ENCLOSURE_URL, NAKED_AMPERSAND });

/** str(value).isdigit() */
const isDigits = (s: string) => s !== "" && codePoints(s).every(pyIsDigit);

export function normalize(source: FeedSource, entry: PyValue): PyDict {
  if (!isDict(entry)) throw new PyError("ValueError", "Invalid listing");
  const title = text(get(entry, source === "remoteok" ? "position" : "title"));
  if (pyLen(title) > 500) throw new PyError("ValueError", "Invalid title");
  const body = text(get(entry, "description"));
  const url = get(entry, "url");
  if (typeof url !== "string") throw new PyError("ValueError", "Missing canonical URL");
  const parsed = urlsplit(url);
  const host = HOST[source], prefix = PREFIX[source];
  if (parsed.scheme !== "https" || pyLower(parsed.netloc) !== host || !parsed.path.startsWith(prefix) || pyLen(parsed.path) <= pyLen(prefix)) {
    throw new PyError("ValueError", "Invalid canonical URL");
  }
  if (source === "workingnomads" && !pyFullmatch(String.raw`/job/go/\d+/`, parsed.path)) throw new PyError("ValueError", "Invalid Working Nomads listing URL");
  const canonical = urlunsplit({ ...parsed, netloc: host, query: "", fragment: "" });
  const identity = source === "remoteok" ? get(entry, "id") : canonical;
  if (source === "remoteok" && (typeof identity === "boolean" || !isDigits(pyStr(identity)))) throw new PyError("ValueError", "Invalid listing ID");
  const evidence = get(entry, source === "workingnomads" ? "pub_date" : "date");
  const date = published(evidence);
  let tags = get(entry, "tags", []);
  if (source === "workingnomads" && typeof tags === "string") tags = tags.split(",").map(pyStrip).filter((x) => x);
  if (!isList(tags) || tags.some((tag) => typeof tag !== "string")) throw new PyError("ValueError", "Invalid tags");
  const employmentType = get(entry, "employment_type");
  let employment = [title, ...(tags as string[]), truthy(employmentType) ? pyStr(employmentType) : ""].join(" ");
  const explicit = [...pyFindall(EXPLICIT_TYPE, body), ...pyFindall(EXPLICIT_BASIS, body)];
  employment += " " + explicit.join(" ");
  employment = pySub(SMART_CONTRACT, employment, () => "");
  const fulltime = FULL_TIME.test(employment + "\n" + body);
  const contract = CONTRACT.test(employment);
  const kind = fulltime ? "full_time" : contract ? "contract" : null;
  const status = get(entry, "status");
  const closed = get(entry, "closed") === true || (typeof status === "string" && ["closed", "expired", "filled"].includes(status)) || CLOSED.test(title + "\n" + body);
  const geo = or(get(entry, "location"), null);
  if (geo !== null && typeof geo !== "string") throw new PyError("ValueError", "Invalid location");
  const job = PyDict.of({
    source, external_id: pyStr(identity), title, description: body,
    url: canonical, canonical_url: canonical, attribution: ATTRIBUTION[source],
    kind, listing_closed: closed, published_at: date.isoformat(), received_at: date.isoformat(),
    publication_evidence: evidence, employment_evidence: pyStrip(employment), location_evidence: geo,
    weekly_hours: null, taiwan_eligible: null, timezone_compatible: null, deadline: null,
    currency: null, budget_min: null, budget_max: null, free_apply: null,
    salary_evidence: PyDict.of({ min: or(get(entry, "salary_min"), null), max: or(get(entry, "salary_max"), null), period: or(get(entry, "salary_period"), null) }),
    language: "en", complete: false, body_available: true,
  });
  const fingerprint = identityHash(job);
  return job.update({ receipt_id: source + ":" + pyStr(identity) + ":" + fingerprint });
}

const ASCII_SPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
const DECLARATIONS = pyRe(String.raw`<!\s*(?:DOCTYPE|ENTITY)\b`, true);
// Official RSS emits naked query separators in enclosure URL attributes.
// Only repair this observed defect; CDATA/content and all other XML stay intact.
const UNTOUCHED = pyRe(String.raw`(<!\[CDATA\[.*?\]\]>|<!--.*?-->)`, false, false, true);
const ENCLOSURE_URL = pyRe(String.raw`(<enclosure\b[^>]*\burl=")([^"]*)(")`);
const NAKED_AMPERSAND = pyRe(String.raw`&(?=[A-Za-z_][A-Za-z0-9_.-]*=)`);

/** public_feeds._entries: at most 200 listings and whether there were more. */
export function entries(source: string, raw: Uint8Array): { entries: PyValue[]; truncated: boolean } {
  if (!isFeedSource(source) || !raw.some((b) => !ASCII_SPACE.has(b)) || raw.length > MAX_BYTES) throw new PyError("ValueError", "Unsupported or empty public feed");
  let list: PyValue[];
  if (JSON_FEEDS.has(source)) {
    const data = loadsBytes(raw);
    if (!isList(data)) throw new PyError("ValueError", "Unsupported JSON feed");
    list = data;
    const first = list[0];
    if (source === "remoteok" && isDict(first) && first.has("legal") && !first.has("id")) list = list.slice(1);
  } else {
    const xml = decodeStrict("utf-8", raw);
    if (DECLARATIONS.test(xml)) throw new PyError("ValueError", "XML declarations forbidden");
    const tokens = pyReSplit(UNTOUCHED, xml) as string[];
    for (let i = 0; i < tokens.length; i += 2) {
      tokens[i] = pySub(ENCLOSURE_URL, tokens[i], (m) => m[1] + pySub(NAKED_AMPERSAND, m[2], () => "&amp;") + m[3]);
    }
    const root = xmlFromString(tokens.join(""));
    const channel = xmlFind(root, "channel");
    if (root.tag !== "rss" || channel === null) throw new PyError("ValueError", "Unsupported RSS structure");
    list = xmlFindAll(channel, "item").map((item) => PyDict.of({
      title: xmlFindText(item, "title"), description: xmlFindText(item, "description"),
      url: xmlFindText(item, "link"), date: xmlFindText(item, "pubDate"),
      location: xmlFindText(item, "region"),
      tags: xmlFindAll(item, "category").map((c) => c.text ?? ""),
    }));
  }
  if (!list.length) throw new PyError("ValueError", "Empty listing feed");
  return { entries: list.slice(0, MAX_ITEMS), truncated: list.length > MAX_ITEMS };
}

/** public_feeds.parse_batch: invalid individual listings are counted; envelope failures still propagate. */
export function parseBatch(source: FeedSource, raw: Uint8Array): { jobs: PyDict[]; truncated: boolean; rejected: bigint } {
  const { entries: list, truncated } = entries(source, raw);
  const jobs: PyDict[] = [];
  let rejected = 0n;
  for (const entry of list) {
    try {
      jobs.push(normalize(source, entry));
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "TypeError")) throw e;
      rejected++;
    }
  }
  return { jobs, truncated, rejected };
}

/** One GET with the source's headers; a seam for tests. */
export type Get = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: Uint8Array }>;
const httpGet: Get = (url, headers) => getCapped(url, headers, MAX_BYTES, 25_000);

/** public_feeds.fetch: one GET without redirects, 8 MB and 25 s for the whole request. */
export async function fetchFeed(source: string, request: Get = httpGet): Promise<Uint8Array> {
  if (!isFeedSource(source)) throw new PyError("ValueError", "Unsupported public source");
  const r = await request(ENDPOINTS[source], {
    "User-Agent": "freelance-agent/0.1 personal-job-discovery",
    Accept: JSON_FEEDS.has(source) ? "application/json" : "application/rss+xml, application/xml",
  });
  if (r.status !== 200) throw new PyError("ValueError", "Public feed unavailable");
  if (r.body.length > MAX_BYTES) throw new PyError("ValueError", "Public feed size limit");
  return r.body;
}

export type FeedReader = (source: FeedSource) => Promise<Uint8Array>;

/**
 * public_feeds.sync minus its first line (runSource marks the source failed). Throws where Python
 * returns {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncPublicFeed(db: Db, source: FeedSource, reader: FeedReader = (s) => fetchFeed(s)): Promise<PyDict> {
  const { jobs, truncated, rejected } = parseBatch(source, await reader(source));
  const now = PyDateTime.now();
  const nowUs = now.utcMicros();
  const selected = await sourceBatch(db, source, now, async (batch) => {
    const existing = await batch.existingIds();
    let n = 0n;
    for (const job of jobs) {
      const at = published(job.req("published_at")).utcMicros();
      const fresh = nowUs - 90n * DAY_US <= at && at <= nowUs;
      if (existing.has(job.str("external_id")) || (fresh && job.at("kind") === "contract" && qualifyForIntake(job, now).at("status") !== "excluded")) {
        await batch.ingest(job, job.at("receipt_id"));
        n++;
      }
    }
    await batch.finish(rejected ? "failed" : "ok");
    return n;
  });
  const result = PyDict.of({
    status: rejected ? "partial" : "ok", seen: BigInt(jobs.length) + rejected, jobs: selected, truncated,
    rejected_count: rejected, scope: "latest_200_public_listings_within_90_days",
  });
  if (rejected) result.set("reason", "invalid_individual_listings_rejected");
  return result;
}
