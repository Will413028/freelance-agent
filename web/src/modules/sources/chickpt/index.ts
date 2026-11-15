import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints } from "../shared/json";
import { boardUrl, PAGE_BYTES, PAGE_TIMEOUT_MS, pageHtml, readDetails, USER_AGENT } from "../shared/job-pages";
import { pyStrip } from "../shared/text";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// 小雞上工 (plan step 5c; old collection/chickpt.py, web/src/modules/collection/sources/chickpt.ts at
// ce1254d): the public computer-task category's first page lists the tasks, and each task's public page
// is read for its visible sections; no private API, no login. Read scope (unchanged from the old
// connector): the first index page and every task it links, at most 200, so one run sends at most 201
// requests; a category with more tasks than the first page shows is marked truncated (old partial).
// An index that is not the category, has no readable result count, or whose links disagree with that
// count fails the source. A task link off the board, or a task page whose identity (its og:url, title,
// task content) is missing or wrong, is set aside and counted (Will 2026-11-15). A budget the page
// does not state readably is unknown (plan D8). The board has no rule of its own beyond its category.

const NAME = "chickpt";
const ORIGIN = "https://www.chickpt.com.tw";
const HOST = "www.chickpt.com.tw";
export const INDEX = ORIGIN + "/cases?categories=105";
const ARTICLE = /^\/job-([A-Za-z0-9]{12})$/;
const MAX_LINKS = 200;
const BODY_PREFIX = "任務內容";
const CATEGORY = "電腦接案任務";
// Preserve the visible asking amount; an hourly rate must never become a fixed total. ASCII digits only
// (old Python \d also read other scripts' digits; such an amount is unknown now).
const MONEY = /^單次\$([0-9,]+)(?:\s*[~～]\s*\$?([0-9,]+))?(?=\s|\/|$)/u;

export const CHICKPT_SETTINGS: Omit<PageSourceSettings, "order"> = {
  name: NAME, label: "小雞上工", connector: (fetcher, now) => chickptConnector(fetcher, now),
  // Old pause was 600 ms between detail pages; the floor here is 1 s. One index page plus up to 200 tasks.
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1 + MAX_LINKS,
  // Only the category's first page is read: a task can drop out of the read while still open.
  completeRead: false, disabled: null,
};

/** A task URL on the board, `https://www.chickpt.com.tw/job-<12 letters or digits>`, or null (the standard URL parser, plan D10). */
export const taskUrl = (value: unknown): string | null => boardUrl(ORIGIN, HOST, ARTICLE, value);

// Python's str.split() whitespace (old pySplit), so a section's text collapses as it did.
const PY_SPACE = new RegExp(`[${[[0x09, 0x0d], [0x1c, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]]
  .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("")}]+`, "u");
const words = (s: string) => s.split(PY_SPACE).filter(Boolean);
// Class names split on HTML's ASCII whitespace (the HTML standard; old split on Python whitespace).
const classesOf = (el: Element) => (el.attribs.class ?? "").split(/[\t\n\f\r ]+/).filter(Boolean);

/** The parts of a cheerio (domhandler) node the walk reads; cheerio does not export the type. */
type Node = { type: string; data?: string; name?: string; attribs?: Record<string, string>; children?: Node[] };
type Element = Node & { name: string; attribs: Record<string, string> };

type Key = "title" | "count" | "body" | "salary" | "work_time" | "location";

/** The one section an element starts, in the old order of checks. */
function keyOf(el: Element): Key | null {
  const tag = el.name, classes = classesOf(el);
  if (tag === "h1") return "title";
  if (el.attribs.id === "job-count") return "count";
  if (tag === "section" && classes.includes("job-content")) return "body";
  if (classes.includes("job_salary_address-block")) return "salary";
  if (tag === "section" && classes.includes("job-work_time")) return "work_time";
  if (tag === "section" && classes.includes("job-address")) return "location";
  return null;
}

/**
 * One page read as the old parser read it: each section's visible text (script and style dropped; text
 * inside two nested sections of one kind counts for each, as before), the hrefs of links inside
 * #job-list, and the last og:url. The page is parsed by the HTML standard (cheerio), so a duplicated
 * attribute keeps its first value and a bare class attribute is an empty class list.
 */
function parsePage(html: string) {
  const $ = load(html, { scriptingEnabled: false });
  const parts = new Map<Key, string[]>();
  const links: unknown[] = [];
  let ogUrl: string | null = null;
  const walk = (node: Node, keys: Key[], inList: boolean) => {
    if (node.type === "text") {
      for (const k of keys) parts.get(k)!.push(node.data ?? "");
      return;
    }
    if (node.type !== "tag" && node.type !== "root") return;
    let nextKeys = keys, nextInList = inList;
    if (node.type === "tag") {
      const el = node as Element;
      if (el.name === "script" || el.name === "style") return;
      if (el.name === "meta" && el.attribs.property === "og:url") ogUrl = el.attribs.content ?? null;
      if (el.name === "a" && inList) links.push(el.attribs.href ?? null);
      const key = keyOf(el);
      if (key) {
        if (!parts.has(key)) parts.set(key, []);
        nextKeys = [...keys, key];
      }
      if (el.attribs.id === "job-list") nextInList = true;
    }
    for (const child of node.children ?? []) walk(child, nextKeys, nextInList);
  };
  walk($.root()[0] as unknown as Node, [], false);
  const value = (key: Key) => words((parts.get(key) ?? []).join(" ")).join(" ");
  return { value, links, ogUrl: ogUrl as string | null };
}

/**
 * The index page: the distinct task URLs, the reported result count, and the links set aside. Fails the
 * source (SourceError) when the page is not the category, the count is not a whole number in ASCII digits,
 * or the accepted links disagree with it (more than 200, more than the count, none when the count is not 0).
 */
export function parseIndex(raw: Uint8Array): { urls: string[]; total: number; rejected: number } {
  const page = parsePage(pageHtml(NAME, raw));
  const count = page.value("count");
  if (page.value("title").replaceAll(" ", "") !== CATEGORY || !/^[0-9]+$/.test(count) || !Number.isSafeInteger(Number(count))) {
    throw new SourceError(`${NAME}: wrong category or missing result count`);
  }
  const total = Number(count);
  // A link that is not a task URL is that one listing's identity being wrong: set aside and counted.
  const seen = new Set<string>(), bad = new Set<unknown>();
  for (const href of page.links) {
    const url = taskUrl(href);
    if (url === null) bad.add(href);
    else seen.add(url);
  }
  const urls = [...seen];
  if (urls.length > MAX_LINKS || urls.length > total || (total && !urls.length)) throw new SourceError(`${NAME}: listing links disagree with the result count`);
  return { urls, total, rejected: bad.size };
}

/** A stated amount in ASCII digits with thousands commas, or null when it is not a positive safe integer. */
function amount(text: string): number | null {
  const digits = text.replaceAll(",", "");
  const n = Number(digits);
  return digits && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** One task page in the contract; throws SourceError (set aside) when its identity is missing or wrong. */
export function parseArticle(pageUrl: string, raw: Uint8Array): ListingInput {
  const url = taskUrl(pageUrl);
  if (url === null) throw new SourceError(`${NAME}: invalid task URL`);
  const page = parsePage(pageHtml(NAME, raw));
  if (taskUrl(page.ogUrl) !== url) throw new SourceError(`${NAME}: mismatched task URL`);
  const title = page.value("title"), salary = page.value("salary"), section = page.value("body");
  if (!title || !section.startsWith(BODY_PREFIX) || codePoints(title) > 500 || codePoints(section) > 100_000) throw new SourceError(`${NAME}: missing task content`);
  const body = pyStrip(section.slice(BODY_PREFIX.length));
  if (!body) throw new SourceError(`${NAME}: empty task content`);
  // A one-off amount the page states; a range that is unreadable, zero or inverted is unknown (D8; old refused the task).
  const money = MONEY.exec(salary);
  let low = money ? amount(money[1]) : null, high = money ? amount(money[2] ?? money[1]) : null;
  if (low === null || high === null || high < low) low = high = null;
  const kind = low !== null ? "fixed" : salary.startsWith("時薪$") ? "hourly" : null;
  return parseListingInput({
    external_id: ARTICLE.exec(new URL(url).pathname)![1], title, description: body, url, canonical_url: url,
    location: page.value("location") || null, kind, currency: low !== null ? "TWD" : null, budget_min: low, budget_max: high,
    compensation_evidence: salary || null, complete: false,
    // Publication time, deadline, hours and eligibility are not on the page: unknown (D8).
    extra: { work_time_evidence: page.value("work_time") || null },
  });
}

const get = (fetcher: Fetcher, url: string) =>
  fetcher.get({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });

export async function chickptConnector(fetcher: Fetcher, _now: Date): Promise<Collected> {
  const index = parseIndex((await get(fetcher, INDEX)).body);
  const details = await readDetails(index.urls, async (url) => parseArticle(url, (await get(fetcher, url)).body));
  return {
    seen: index.urls.length, listings: [...new Map(details.listings.map((l) => [l.external_id, l])).values()],
    // The board has no rule of its own (the old intake test was qualifyForIntake, evaluation's job, checklist §2).
    sourceKept: () => true,
    truncated: details.truncated || index.total > index.urls.length,
    // A set-aside link is examined once at the index; every accepted link once at its task page.
    rejected: index.rejected + details.rejected, examined: index.rejected + details.examined,
  };
}
