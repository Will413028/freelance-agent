import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { getCapped, loadsBytes } from "@/platform/http";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { asciiHash } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { codePoints, pyLen, pySplit, pyStr, pyStrip } from "@/platform/py/unicode";
import { urlsplitValue, urlunsplit } from "@/platform/py/url";
import { isDict, isInt, isList, PyDict, PyError, pyEq, pyGet, pySubscript, truthy, type PyValue } from "@/platform/py/value";
import { xmlFindAll, xmlFindText, xmlFromBytes, xmlGet } from "@/platform/py/xml";
import { ingest, setSourceHealth } from "../ingest";
import { htmlText } from "./text";

// Port of collection/community_jobs.py: public community hiring leads. No accounts, messaging, or
// employer-link fetching.

export const COMMUNITY_SOURCES = ["hackernews", "v2ex"] as const;
const LIMIT = 2_000_000;
const DAY_US = 86_400_000_000n;

const plain = (body: string) => pySplit(htmlText(body)).join(" ");
/** s[:n] in code points. */
const head = (s: string, n: number) => codePoints(s).slice(0, n).map((c) => String.fromCodePoint(c)).join("");

function job(source: string, externalId: PyValue, title: string, body: string, url: string, published: string, evidence: Record<string, PyValue>): PyDict {
  if (!pyStrip(title) || pyLen(body) > 100000) throw new PyError("ValueError", "Invalid listing");
  const result = PyDict.of({
    source, external_id: pyStr(externalId), title: head(title, 500), description: body,
    url, canonical_url: url, kind: "contract", taiwan_eligible: null,
    timezone_compatible: null, weekly_hours: null, deadline: null, currency: null,
    budget_min: null, budget_max: null, complete: false, language: source === "v2ex" ? "zh-TW" : "en",
  });
  result.update(evidence);
  const digest = asciiHash(result);
  return new PyDict(result).update({ received_at: published, receipt_id: source + ":" + digest });
}

const get = (p: PyDict, key: string) => pyGet(p, key);

const SEEKING = pyRe(String.raw`^(seeking work|for hire|looking for work)\b`, true);
const NO_CONTRACT = pyRe(String.raw`\b(no contractors?|no freelance|full[ -]?time only|part[ -]?time not available)\b`, true);
const CONTRACT = pyRe(String.raw`\b(part[ -]?time|contract(?:or|ing)?|freelance|fractional)\b`, true);
const RESTRICTED = pyRe(String.raw`\b(?:USA?|UK|EU|Europe|Canada|Australia)\s+only\b|REMOTE\s*\((?:EU|US|USA|UK|Europe)\)|\b(?:Poland|Romania|Romanian)(?: or (?:Poland|Romania|Romanian))? residents only`, true);

export function hnJob(p: PyValue, parent: PyValue): PyDict | null {
  if (!isDict(p)) throw new PyError("ValueError", "Missing comment");
  if (truthy(get(p, "deleted")) || truthy(get(p, "dead"))) return null;
  if (!pyEq(get(p, "type"), "comment") || !pyEq(get(p, "parent"), parent)) return null;
  const body = get(p, "text");
  if (typeof body !== "string") throw new PyError("ValueError", "Missing comment text");
  const text = plain(body);
  if (text.startsWith("Location:") && text.includes("Willing to relocate:")) return null;
  if (SEEKING.test(text)) return null;
  if (NO_CONTRACT.test(text)) return null;
  if (!CONTRACT.test(text)) return null;
  const id = get(p, "id"), time = get(p, "time");
  if (!isInt(id) || !isInt(time)) throw new PyError("ValueError", "Invalid comment metadata");
  const restricted = RESTRICTED.test(text);
  return job("hackernews", id, head(text, 160), text, "https://news.ycombinator.com/item?id=" + id, PyDateTime.fromTimestamp(time).isoformat(),
    { thread_id: parent, body_available: true, taiwan_eligible: restricted ? false : null });
}

const ATOM = "{http://www.w3.org/2005/Atom}";
const SKIP = pyRe("承接|接单|接單|接活|自荐|自薦|作品展示|出售|广告联盟|廣告聯盟|假如|如果");
const WANTED = pyRe("招聘|寻找|尋找|求助|需求|外包|找.{0,20}(开发|開發|工程师|工程師|大佬)|有.{0,20}项目");

/** bytes.upper(): ASCII letters only. */
function asciiUpper(raw: Uint8Array): string {
  let out = "";
  for (const b of raw) out += String.fromCharCode(b >= 0x61 && b <= 0x7a ? b - 0x20 : b);
  return out;
}

export function v2exJobs(raw: Uint8Array, now: PyDateTime = PyDateTime.now()): PyDict[] {
  if (raw.length > LIMIT) throw new PyError("ValueError", "Unsupported XML");
  const upper = asciiUpper(raw);
  if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) throw new PyError("ValueError", "Unsupported XML");
  let r;
  try {
    r = xmlFromBytes(raw);
  } catch (e) {
    if (pyIsInstance(e, "ParseError")) throw new PyError("ValueError", "Invalid feed");
    throw e;
  }
  if (r.tag !== ATOM + "feed") throw new PyError("ValueError", "Expected Atom");
  const entries = xmlFindAll(r, ATOM + "entry");
  if (entries.length > 100) throw new PyError("ValueError", "Feed limit");
  const jobs: PyDict[] = [];
  const cutoff = now.utcMicros() - 90n * DAY_US;
  for (const e of entries) {
    const title = xmlFindText(e, ATOM + "title") || "";
    if (SKIP.test(title)) continue;
    if (!WANTED.test(title)) continue;
    const links = xmlFindAll(e, ATOM + "link").filter((x) => xmlGet(x, "rel") === "alternate").map((x) => xmlGet(x, "href"));
    if (links.length !== 1) throw new PyError("ValueError", "Missing canonical link");
    // urlsplit(None) splits to bytes, and a str pattern cannot match bytes.
    if (links[0] === null) throw new PyError("TypeError", "cannot use a string pattern on a bytes-like object");
    const u = urlsplitValue(links[0]), match = pyFullmatch(String.raw`/t/(\d+)`, u.path);
    if (u.scheme !== "https" || u.netloc !== "www.v2ex.com" || !match) throw new PyError("ValueError", "Invalid canonical link");
    const published = fromisoformat((xmlFindText(e, ATOM + "published") || "").replaceAll("Z", "+00:00"));
    if (!published.aware) throw new PyError("ValueError", "Missing timezone");
    if (published.utcMicros() < cutoff) continue;
    const body = plain(xmlFindText(e, ATOM + "content") || "");
    jobs.push(job("v2ex", match[1], title, body || title, urlunsplit({ ...u, query: "", fragment: "" }), published.isoformat(),
      { body_available: Boolean(body), feed_evidence: "outsourcing" }));
  }
  return jobs;
}

/** pool.map with max_workers: results in input order; any failure fails the whole call. */
async function mapPool<T, R>(items: T[], workers: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run));
  return out;
}

/** One GET: the URL and the time left on the source deadline. */
export type Get = (url: string, remainingMs: number) => Promise<{ status: number; body: Uint8Array }>;
const httpGet: Get = (url, remainingMs) => getCapped(url, { "User-Agent": "freelance-agent/0.1 personal-job-discovery" }, LIMIT, Math.min(8_000, remainingMs));

/** community_jobs.fetch; `request` is a seam for tests. */
export async function fetchCommunity(source: string, request: Get = httpGet, now: PyDateTime = PyDateTime.now()): Promise<PyDict[]> {
  const deadline = performance.now() + 90_000;
  const read = async (url: string) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new PyError("ValueError", "Source time budget exceeded");
    const r = await request(url, remaining);
    if (r.status !== 200) throw new PyError("ValueError", "Feed unavailable");
    if (r.body.length > LIMIT) throw new PyError("ValueError", "Response limit");
    return r.body;
  };
  if (source === "v2ex") return v2exJobs(await read("https://www.v2ex.com/feed/outsourcing.xml"), now);
  if (source !== "hackernews") throw new PyError("ValueError", "Unsupported source");
  const getJson = async (path: string) => loadsBytes(await read("https://hacker-news.firebaseio.com/v0/" + path + ".json"));
  const item = async (i: PyValue) => {
    if (!isInt(i) || i <= 0n) throw new PyError("ValueError", "Invalid id");
    return getJson("item/" + i);
  };
  const user = await getJson("user/whoishiring");
  if (!isDict(user)) throw new PyError("AttributeError", "object has no attribute 'get'");
  const ids = get(user, "submitted");
  if (!isList(ids)) throw new PyError("ValueError", "Missing submissions");
  const cutoff = now.utcMicros() - 62n * DAY_US;
  const threads = await mapPool(ids.slice(0, 6), 8, item);
  const title = (t: PyDict) => {
    const v = t.has("title") ? t.at("title") : "";
    if (typeof v !== "string") throw new PyError("AttributeError", "object has no attribute 'startswith'");
    return v;
  };
  const selected = threads.filter((t): t is PyDict => isDict(t) && pyEq(get(t, "by"), "whoishiring")
    && pyEq(get(t, "type"), "story") && !truthy(get(t, "deleted")) && !truthy(get(t, "dead"))
    && (title(t).startsWith("Ask HN: Who is hiring?") || title(t).startsWith("Ask HN: Freelancer?"))
    && PyDateTime.fromTimestampValue(pySubscript(t, "time")).utcMicros() >= cutoff).slice(0, 2);
  if (!selected.length) throw new PyError("ValueError", "No recent hiring thread");
  const result: PyDict[] = [];
  for (const thread of selected) {
    const children = thread.has("kids") ? thread.at("kids") : [];
    if (!isList(children)) throw new PyError("ValueError", "Invalid comments");
    for (const p of await mapPool(children.slice(0, 100), 8, item)) {
      const j = hnJob(p, pySubscript(thread, "id"));
      if (j) result.push(j);
    }
  }
  return result;
}

export type CommunityReader = (source: string) => Promise<PyDict[]>;

/**
 * community_jobs.sync minus its first line: runSource has already marked the source failed. Throws
 * where Python returns {'status': 'failed'}; jobs ingested before a failure stay, as in Python.
 */
export async function syncCommunity(db: Db, source: string, reader: CommunityReader = (s) => fetchCommunity(s)): Promise<PyDict> {
  const jobs = await reader(source);
  const selected = jobs.filter((j) => qualifyForIntake(j, PyDateTime.now()).at("status") !== "excluded");
  for (const j of selected) await ingest(db, j, j.at("receipt_id"), PyDateTime.now());
  await setSourceHealth(db, source, "ok");
  return PyDict.of({ status: "ok", seen: BigInt(jobs.length), jobs: BigInt(selected.length), scope: "bounded_public_hiring_leads", complete_scan: false });
}
