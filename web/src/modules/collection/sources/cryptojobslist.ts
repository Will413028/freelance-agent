import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { getCapped } from "@/platform/http";
import { PyDateTime } from "@/platform/py/datetime";
import { htmlFeed } from "@/platform/py/html";
import { identityHash } from "@/platform/py/json";
import { wordsIgnoreCase } from "@/platform/py/re";
import { pyLen, pyStrip } from "@/platform/py/unicode";
import { urlsplit, urlunsplit } from "@/platform/py/url";
import { cmpStr, PyDict, PyError } from "@/platform/py/value";
import { xmlFind, xmlFindAll, xmlFindText, xmlFromBytes, type XmlElement } from "@/platform/py/xml";
import { sourceBatch } from "../ingest";
import { published, text } from "./text";

// Port of collection/cryptojobslist.py: the official advertised RSS, without API keys or account access.

export const FEED = "https://api.cryptojobslist.com/jobs.rss";
const MEDIA = "{http://search.yahoo.com/mrss/}";
const LIMIT = 2_000_000;

export function canonical(value: unknown): string {
  if (typeof value !== "string") throw new PyError("ValueError", "Missing job URL");
  const url = urlsplit(value);
  if (url.scheme !== "https" || url.netloc !== "cryptojobslist.com" || !/^\/jobs\/[a-z0-9][a-z0-9-]+$/.test(url.path)) {
    throw new PyError("ValueError", "Invalid job URL");
  }
  return urlunsplit({ ...url, query: "", fragment: "" });
}

/** Tags: only the feed's initial Tags paragraph, not links inside employer text. */
export function tags(html: string): string[] {
  let paragraph = false, started = false, done = false, label = false;
  const found = new Set<string>();
  htmlFeed(html, {
    starttag(tag, attrs) {
      if (tag === "p" && !started) started = paragraph = true;
      if (tag === "h2" || tag === "h3" || (tag === "p" && done)) paragraph = false;
      if (tag === "a" && paragraph && label) {
        let href: string | null = "";
        for (const [name, value] of attrs) if (name === "href") href = value; // dict(attrs): the last one wins
        if (href === null) return; // urlsplit(None) splits to empty bytes
        const url = urlsplit(href);
        if (url.scheme === "https" && url.netloc === "cryptojobslist.com") found.add(url.path.replace(/^\/+|\/+$/g, ""));
      }
    },
    data(data) {
      if (paragraph && pyStrip(data).startsWith("Tags:")) label = true;
    },
    endtag(tag) {
      if (tag === "p") paragraph = false, done = true;
    },
  }, true);
  return [...found].sort(cmpStr);
}

const REGIONAL = wordsIgnoreCase(["US only", "USA only", "United States", "Europe only", "UK only"]);
const REMOTE = wordsIgnoreCase(["remote"]);

export function normalize(item: XmlElement, observedAt: PyDateTime): PyDict {
  const url = canonical(xmlFindText(item, "link"));
  const advertised = xmlFindText(item, MEDIA + "canonical");
  if (advertised && canonical(advertised) !== url) throw new PyError("ValueError", "Canonical mismatch");
  const title = text(xmlFindText(item, "title"));
  const html = xmlFindText(item, "description");
  const body = text(html);
  if (pyLen(title) > 500 || pyLen(body) > 100_000) throw new PyError("ValueError", "Oversize listing");
  const tagList = tags(html!);
  // "contract" is also used for smart-contract engineering; it is not an employment type.
  const kind = tagList.includes("full-time") ? "full_time" : tagList.some((t) => t === "part-time" || t === "freelance") ? "contract" : null;
  const location = pyStrip(xmlFindText(item, MEDIA + "location") ?? "") || null;
  const regional = REGIONAL.test(location ?? "");
  const publication = xmlFindText(item, "pubDate");
  const date = publication ? published(publication).isoformat() : null;
  const job = PyDict.of({
    source: "cryptojobslist", external_id: url, title, description: body, url, canonical_url: url,
    attribution: "CryptoJobsList", kind, employment_tags: tagList, published_at: date,
    publication_evidence: date ? "RSS pubDate" : "RSS omits job publication date",
    location_evidence: location, remote_evidence: tagList.includes("remote") || REMOTE.test(location ?? ""),
    taiwan_eligible: regional ? false : null, timezone_compatible: null, weekly_hours: null,
    deadline: null, currency: null, budget_min: null, budget_max: null, free_apply: null,
    language: "en", complete: false, body_available: true,
  });
  const fingerprint = identityHash(job);
  job.set("received_at", observedAt.isoformat());
  job.set("receipt_id", "cryptojobslist:" + fingerprint);
  return job;
}

export function parse(raw: Uint8Array, now: PyDateTime = PyDateTime.now()): PyDict {
  if (!raw.length || raw.length > LIMIT) throw new PyError("ValueError", "Invalid RSS");
  if (/<![ \t\n\r\f\v]*(?:DOCTYPE|ENTITY)\b/i.test(Buffer.from(raw).toString("latin1"))) throw new PyError("ValueError", "XML declarations forbidden");
  const root = xmlFromBytes(raw);
  if (root.tag !== "rss" || xmlFind(root, "channel") === null) throw new PyError("ValueError", "Expected RSS channel");
  const items = xmlFindAll(root, "./channel/item");
  if (!items.length || items.length > 2000) throw new PyError("ValueError", "Invalid RSS item count");
  const jobs = new Map<string, PyDict>();
  let rejected = 0n;
  for (const item of items) {
    try {
      const job = normalize(item, now);
      jobs.set(job.str("external_id"), job);
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "TypeError", "AttributeError")) throw e;
      rejected++;
    }
  }
  return PyDict.of({
    jobs: [...jobs.values()], seen: BigInt(items.length), rejected_count: rejected, complete_scan: false,
    scope: "official_rss_window_no_job_dates", feed_built_at: xmlFindText(root, "./channel/lastBuildDate"),
  });
}

export type RssReader = () => Promise<PyDict>;

export async function fetchRss(): Promise<PyDict> {
  const r = await getCapped(FEED, { "User-Agent": "freelance-agent/0.1 personal-job-discovery", Accept: "application/rss+xml" }, LIMIT, 25_000);
  if (r.status !== 200) throw new PyError("ValueError", "RSS unavailable");
  if (r.body.length > LIMIT) throw new PyError("ValueError", "Response limit");
  return parse(r.body);
}

/**
 * cryptojobslist.sync minus its first line (runSource marks the source failed). Throws where Python
 * returns {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncCryptoJobsList(db: Db, reader: RssReader = fetchRss): Promise<PyDict> {
  const result = await reader();
  const rejected = result.req("rejected_count") as bigint;
  const count = await sourceBatch(db, "cryptojobslist", PyDateTime.now(), async (batch) => {
    const existing = await batch.existingIds();
    let n = 0n;
    for (const job of result.req("jobs") as PyDict[]) {
      if (existing.has(job.str("external_id"))
        || (job.at("remote_evidence") === true && job.at("kind") === "contract" && qualifyForIntake(job, PyDateTime.now()).at("status") !== "excluded")) {
        await batch.ingest(job, job.at("receipt_id"));
        n++;
      }
    }
    await batch.finish(rejected ? "failed" : "ok");
    return n;
  });
  // feed_built_at is the feed's own date text, which a step's SourceDetail refuses; nothing reads it (D17).
  const out = new PyDict([...result].filter(([k]) => k !== "jobs" && k !== "feed_built_at"));
  out.set("jobs", count);
  out.set("status", rejected ? "partial" : "ok");
  return out;
}
