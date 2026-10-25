import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { htmlFeed } from "@/platform/py/html";
import { pyFullmatch, pyMatch } from "@/platform/py/re";
import { codePoints, pyInt, pyIsDigit, pyLen, pySplit, pyStrip } from "@/platform/py/unicode";
import { urlsplit } from "@/platform/py/url";
import { PyDict, PyError, truthy, type PyValue } from "@/platform/py/value";
import { sourceBatch } from "../ingest";
import { attr, canonicalOn, pageReader, pageText, rejectsDetail, seams, SOURCE_BUDGET_MS, type FetchSeams } from "./job-pages";

// Port of collection/chickpt.py: the public computer-task category and visible task sections; no
// private API or login.

const ORIGIN = "https://www.chickpt.com.tw";
export const INDEX = ORIGIN + "/cases?categories=105";
const ARTICLE = String.raw`/job-([A-Za-z0-9]{12})\Z`;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BODY_PREFIX = "任務內容";
// Preserve the visible asking amount; an hourly rate must never become a fixed total.
export const MONEY = String.raw`單次\$([\d,]+)(?:\s*[~～]\s*\$?([\d,]+))?(?=\s|/|$)`;

export const canonical = (value: PyValue | undefined) => canonicalOn(ORIGIN, "www.chickpt.com.tw", ARTICLE, value);

type Frame = { tag: string; attrs: Map<string, string | null>; key: string | null };

/** chickpt.Page fed one page: the keyed sections' text, the job-list links and og:url. */
function parsePage(raw: Uint8Array) {
  // page_text's checks, inlined in Python's parse_page.
  const html = pageText(raw);
  let stack: Frame[] = [];
  const parts = new Map<string, string[]>(), links: string[] = [];
  let ogUrl: string | null | undefined = null;
  htmlFeed(html, {
    starttag(tag, list) {
      const attrs = new Map(list);
      const cls = attr(list, "class", "");
      // attrs.get('class', '').split(): a bare class attribute is None, which has no split().
      if (cls === null) throw new PyError("AttributeError", "'NoneType' object has no attribute 'split'");
      const classes = pySplit(cls!);
      let key: string | null = null;
      if (tag === "meta" && attrs.get("property") === "og:url") ogUrl = attrs.has("content") ? attrs.get("content")! : null;
      if (tag === "a" && stack.some((f) => f.attrs.get("id") === "job-list")) links.push(canonical(attrs.has("href") ? attrs.get("href")! : null));
      if (tag === "h1") key = "title";
      else if (attrs.get("id") === "job-count") key = "count";
      else if (tag === "section" && classes.includes("job-content")) key = "body";
      else if (classes.includes("job_salary_address-block")) key = "salary";
      else if (tag === "section" && classes.includes("job-work_time")) key = "work_time";
      else if (tag === "section" && classes.includes("job-address")) key = "location";
      if (key && !parts.has(key)) parts.set(key, []);
      if (!VOID.has(tag)) stack.push({ tag, attrs, key });
    },
    endtag(tag) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack = stack.slice(0, i);
          break;
        }
      }
    },
    data(data) {
      if (stack.some((f) => f.tag === "script" || f.tag === "style")) return;
      for (const f of stack) if (f.key) parts.get(f.key)!.push(data);
    },
  }, true);
  const value = (key: string) => pySplit((parts.get(key) ?? []).join(" ")).join(" ");
  return { value, links, ogUrl };
}

const isDigits = (s: string) => s !== "" && codePoints(s).every(pyIsDigit);

/** chickpt.parse_index: the distinct listing links and the reported result count. */
export function parseIndex(raw: Uint8Array): { urls: string[]; total: bigint } {
  const page = parsePage(raw);
  if (page.value("title").replaceAll(" ", "") !== "電腦接案任務" || !isDigits(page.value("count"))) throw new PyError("ValueError", "Wrong category or missing result count");
  const total = pyInt(page.value("count")), urls = [...new Set(page.links)];
  if (urls.length > 200 || BigInt(urls.length) > total || (total && !urls.length)) throw new PyError("ValueError", "Invalid listing/count");
  return { urls, total };
}

export function parseArticle(raw: Uint8Array, pageUrl: string, observedAt: PyDateTime = PyDateTime.now()): PyDict {
  const url = canonical(pageUrl), page = parsePage(raw);
  if (canonical(page.ogUrl) !== url) throw new PyError("ValueError", "Mismatched task URL");
  const title = page.value("title"), salary = page.value("salary");
  let body = page.value("body");
  if (!title || !body.startsWith(BODY_PREFIX) || pyLen(title) > 500 || pyLen(body) > 100_000) throw new PyError("ValueError", "Missing task content");
  body = pyStrip(body.slice(BODY_PREFIX.length));
  if (!body) throw new PyError("ValueError", "Empty task content");
  const money = pyMatch(MONEY, salary);
  const low = money ? pyInt(money[1].replaceAll(",", "")) : null;
  const high = money ? pyInt((money[2] ?? money[1]).replaceAll(",", "")) : null;
  if (money && (low! <= 0n || high! < low!)) throw new PyError("ValueError", "Invalid task budget");
  const kind = money ? "fixed" : salary.startsWith("時薪$") ? "hourly" : null;
  const job = PyDict.of({
    source: "chickpt", external_id: pyFullmatch(ARTICLE, urlsplit(url).path)![1],
    title, description: body, url, canonical_url: url, attribution: "小雞上工",
    kind, currency: money ? "TWD" : null, budget_min: low, budget_max: high,
    salary_evidence: salary, location_evidence: page.value("location") || null,
    work_time_evidence: page.value("work_time") || null,
    published_at: null, deadline: null, weekly_hours: null, taiwan_eligible: null,
    timezone_compatible: null, free_apply: null, complete: false, body_available: true,
    language: "zh-TW", category_evidence: "電腦接案任務",
  });
  const fingerprint = identityHash(job);
  return job.update({ received_at: observedAt.isoformat(), receipt_id: "chickpt:" + fingerprint });
}

/** chickpt.fetch */
export async function fetchChickpt(s: FetchSeams = {}): Promise<PyDict> {
  const { request, pause, monotonic, now } = seams(s);
  const deadline = monotonic() + SOURCE_BUDGET_MS;
  const get_ = pageReader(request, monotonic, deadline);
  const read = (url: string) => {
    if (url !== INDEX) canonical(url);
    return get_(url);
  };
  const { urls, total } = parseIndex(await read(INDEX));
  const jobs: PyDict[] = [];
  let rejected = 0n, attempted = 0;
  for (const url of urls) {
    if (deadline - monotonic() < 1000) break;
    await pause(600);
    attempted++;
    try {
      jobs.push(parseArticle(await read(url), url, now()));
    } catch (e) {
      if (!rejectsDetail(e, "ValueError", "TypeError", "OSError")) throw e;
      rejected++;
    }
  }
  return PyDict.of({
    jobs, seen: BigInt(urls.length), reported_total: total, details_read: BigInt(jobs.length),
    rejected_count: rejected, truncated: attempted < urls.length || total > BigInt(urls.length),
    complete_scan: false, scope: "public_computer_task_category_first_page",
  });
}

export type JobsReader = () => Promise<PyDict>;

/**
 * chickpt.sync minus its first line (runSource marks the source failed). Throws where Python returns
 * {'status': 'failed'}; the batch commits ingests and final health together or not at all.
 */
export async function syncChickpt(db: Db, reader: JobsReader = () => fetchChickpt()): Promise<PyDict> {
  const result = await reader();
  const partial = truthy(result.req("rejected_count")) || truthy(result.req("truncated"));
  const count = await sourceBatch(db, "chickpt", PyDateTime.now(), async (batch) => {
    const old = await batch.existingIds();
    let n = 0n;
    for (const job of result.req("jobs") as PyDict[]) {
      if (old.has(job.str("external_id")) || qualifyForIntake(job, PyDateTime.now()).at("status") !== "excluded") {
        await batch.ingest(job, job.at("receipt_id"));
        n++;
      }
    }
    await batch.finish(partial ? "failed" : "ok");
    return n;
  });
  const out = new PyDict([...result].filter(([k]) => k !== "jobs"));
  return out.update({ jobs: count, status: partial ? "partial" : "ok" });
}
