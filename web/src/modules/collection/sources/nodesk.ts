import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { decodeStrict } from "@/platform/py/codecs";
import { PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch, pyRe, pyReSplit } from "@/platform/py/re";
import { pyLen, pyUpper } from "@/platform/py/unicode";
import { urlsplit, urlunsplit } from "@/platform/py/url";
import { PyDict, PyError, pyGet, pySorted, truthy, type PyValue } from "@/platform/py/value";
import { xmlFind, xmlFindAll, xmlFindText, xmlFromString } from "@/platform/py/xml";
import { sourceBatch } from "../ingest";
import { employmentTypes, jobPostings, kindOf, pageReader, PAGE_LIMIT, seams, SOURCE_BUDGET_MS, type FetchSeams } from "./job-pages";
import { published, text } from "./text";

// Port of collection/nodesk.py: NoDesk's advertised RSS plus public JobPosting metadata, without
// account access.

export const FEED = "https://nodesk.co/remote-jobs/index.xml";
const ARTICLE = String.raw`/remote-jobs/[a-z0-9][a-z0-9-]+/\Z`;
const DAY_US = 86_400_000_000n;

const get = pyGet;

export function canonical(url: PyValue | undefined): string {
  const parsed = typeof url === "string" ? urlsplit(url) : null;
  if (parsed === null || parsed.scheme !== "https" || parsed.netloc !== "nodesk.co" || !pyFullmatch(ARTICLE, parsed.path)) {
    throw new PyError("ValueError", "Invalid NoDesk job URL");
  }
  return urlunsplit({ ...parsed, query: "", fragment: "" });
}

const DECLARATIONS = pyRe(String.raw`<!\s*(?:DOCTYPE|ENTITY)\b`, true);
// The advertised feed contains these two HTML entities outside CDATA.
// Repair only the observed defect, leaving CDATA and other errors intact.
const UNTOUCHED = pyRe(String.raw`(<!\[CDATA\[.*?\]\]>|<!--.*?-->)`, false, false, true);
/** Every regex above, for the golden test. */
export const regexes = () => ({ DECLARATIONS, UNTOUCHED });

export type Entry = { url: string; published_at: string };

/** nodesk.parse_feed: at most 20 entries, the rejected count, and whether the feed had more. */
export function parseFeed(raw: Uint8Array): { entries: Entry[]; rejected: bigint; truncated: boolean } {
  if (!raw.length || raw.length > PAGE_LIMIT) throw new PyError("ValueError", "Invalid NoDesk feed");
  const xml = decodeStrict("utf-8", raw);
  if (DECLARATIONS.test(xml)) throw new PyError("ValueError", "XML declarations forbidden");
  const parts = pyReSplit(UNTOUCHED, xml) as string[];
  for (let i = 0; i < parts.length; i += 2) parts[i] = parts[i].replaceAll("&ndash;", "&#8211;").replaceAll("&rsquo;", "&#8217;");
  let root;
  try {
    root = xmlFromString(parts.join(""));
  } catch (e) {
    if (pyIsInstance(e, "ParseError")) throw new PyError("ValueError", "Malformed NoDesk RSS");
    throw e;
  }
  if (root.tag !== "rss" || xmlFind(root, "channel") === null) throw new PyError("ValueError", "Unsupported NoDesk RSS");
  const items = xmlFindAll(root, "./channel/item");
  if (!items.length) throw new PyError("ValueError", "Empty NoDesk RSS");
  const entries: Entry[] = [], seen = new Set<string>();
  let rejected = 0n;
  for (const item of items.slice(0, 20)) {
    try {
      const url = canonical(xmlFindText(item, "link"));
      const date = published(xmlFindText(item, "pubDate"));
      if (!seen.has(url)) {
        entries.push({ url, published_at: date.isoformat() });
        seen.add(url);
      }
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "TypeError")) throw e;
      rejected++;
    }
  }
  return { entries, rejected, truncated: items.length > 20 };
}

export function parseArticle(raw: Uint8Array, entry: Entry): PyDict {
  const url = canonical(entry.url);
  if (!raw.length || raw.length > PAGE_LIMIT) throw new PyError("ValueError", "Invalid job page");
  const jobs = jobPostings(decodeStrict("utf-8", raw));
  if (jobs.length !== 1) throw new PyError("ValueError", "Expected one JobPosting");
  const data = jobs[0];
  const title = text(get(data, "title")), body = text(get(data, "description"));
  if (pyLen(title) > 500 || pyLen(body) > 100_000) throw new PyError("ValueError", "Oversize listing");
  const types = pySorted(new Set(employmentTypes(get(data, "employmentType"), false).map(pyUpper)));
  const deadline = get(data, "validThrough");
  if (deadline !== null && typeof deadline !== "string") throw new PyError("ValueError", "Invalid deadline");
  const job = PyDict.of({
    source: "nodesk", external_id: url, title, description: body,
    url, canonical_url: url, attribution: "NoDesk", kind: kindOf(types),
    published_at: entry.published_at, received_at: entry.published_at,
    employment_types: types, location_evidence: get(data, "applicantLocationRequirements"),
    remote_evidence: get(data, "jobLocationType") === "TELECOMMUTE",
    publication_evidence: get(data, "datePosted"), deadline,
    weekly_hours: null, taiwan_eligible: null, timezone_compatible: null,
    currency: null, budget_min: null, budget_max: null, free_apply: null,
    language: "en", complete: false, body_available: true,
  });
  return job.update({ receipt_id: "nodesk:" + identityHash(job) });
}

/** nodesk.fetch */
export async function fetchNoDesk(s: FetchSeams = {}): Promise<PyDict> {
  const { request, pause, monotonic, now: clock } = seams(s);
  const deadline = monotonic() + SOURCE_BUDGET_MS;
  const get_ = pageReader(request, monotonic, deadline);
  const read = (url: string) => {
    if (url !== FEED) canonical(url);
    return get_(url);
  };
  const feed = parseFeed(await read(FEED));
  let rejected = feed.rejected;
  const seen = BigInt(feed.entries.length) + rejected;
  const now = clock().utcMicros(), jobs: PyDict[] = [];
  const recent = feed.entries.filter((e) => {
    const at = published(e.published_at).utcMicros();
    return now - 90n * DAY_US <= at && at <= now;
  });
  for (const [index, entry] of recent.entries()) {
    if (deadline - monotonic() <= 1000) {
      rejected += BigInt(recent.length - index);
      break;
    }
    try {
      await pause(1000);
      jobs.push(parseArticle(await read(entry.url), entry));
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "OSError", "TimeoutError")) throw e;
      rejected++;
    }
  }
  return PyDict.of({ jobs, seen, rejected_count: rejected, truncated: feed.truncated });
}

export type JobsReader = () => Promise<PyDict>;

/**
 * nodesk.sync minus its first line (runSource marks the source failed). Throws where Python returns
 * {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncNoDesk(db: Db, reader: JobsReader = () => fetchNoDesk()): Promise<PyDict> {
  const result = await reader();
  const rejected = truthy(result.req("rejected_count"));
  const selected = await sourceBatch(db, "nodesk", PyDateTime.now(), async (batch) => {
    const existing = await batch.existingIds();
    let n = 0n;
    for (const job of result.req("jobs") as PyDict[]) {
      if (existing.has(job.str("external_id")) || (truthy(job.at("remote_evidence")) && job.at("kind") === "contract" && qualifyForIntake(job, PyDateTime.now()).at("status") !== "excluded")) {
        await batch.ingest(job, job.at("receipt_id"));
        n++;
      }
    }
    await batch.finish(rejected ? "failed" : "ok");
    return n;
  });
  const out = new PyDict([...result].filter(([k]) => k !== "jobs"));
  return out.update({ status: rejected ? "partial" : "ok", jobs: selected, scope: "advertised_rss_max_20_public_job_pages_90_days", complete_scan: false });
}
