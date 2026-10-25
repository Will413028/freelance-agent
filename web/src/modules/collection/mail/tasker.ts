import { htmlFeed } from "@/platform/py/html";
import { pyFindall, pyRe, pySub, translate } from "@/platform/py/re";
import { pySplit, pyStrip } from "@/platform/py/unicode";
import { urlsplit } from "@/platform/py/url";
import { PyDict, PyError } from "@/platform/py/value";
import type { MailMessage } from "./message";

// Port of collection/tasker.py: the single-listing Tasker notification template observed in 2026-09.
// Unsupported notifications are failures, never empty source success.

const fail = (message: string) => new PyError("TaskerParseError", message);
const HIDDEN = new Set(["script", "style", "noscript", "template"]);
const BREAK_BEFORE = new Set(["p", "div", "br", "tr", "td", "h1", "h2", "h3", "li"]);
const BREAK_AFTER = new Set(["p", "div", "tr", "td", "h1", "h2", "h3", "li"]);

function canonical(url: string): string | null {
  try {
    const parsed = urlsplit(url);
    if (parsed.scheme !== "https" || parsed.netloc !== "www.tasker.com.tw") return null;
    if (!/^\/cases\/[A-Za-z0-9]+$/.test(parsed.path)) return null;
    return "https://www.tasker.com.tw" + parsed.path;
  } catch (e) {
    if (e instanceof PyError && e.pyType === "ValueError") return null;
    throw e;
  }
}

// URLs may appear as visible pasted text, not just HTML attributes.
const PASTED_URL = pyRe("(?:[a-zA-Z][a-zA-Z0-9+.-]*://|//|www\\.|mailto:|tel:)[^\\s<>]+", false, true);
const clean = (text: string) => pySplit(pySub(PASTED_URL, text, () => "")).join(" ");

const LINK = pyRe("https?://[^\\s<>]+", false, true);
// re.MULTILINE: ^ after a newline only and $ before one, unlike JS's m flag, which also breaks at \r.
const BOUNDARY = new RegExp(`(?<![^\\n])${translate("[ \\t]*查看完整資訊[ \\t]+(https://[^\\s<>]+)[ \\t]*")}(?![^\\n])`, "gu");
const TITLE = pyRe("【([^【】]+)】", false, true);
/** re.escape for a literal inside a pattern; only these characters are syntax in both dialects. */
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

function htmlParts(body: string): { links: string[]; text: string } {
  const chunks: string[] = [], links: string[] = [], hidden: string[] = [], ctaStarts: number[] = [];
  let anchor: [number, string[]] | null = null;
  htmlFeed(body, {
    starttag(tag, attrs) {
      if (HIDDEN.has(tag)) hidden.push(tag);
      if (hidden.length) return;
      if (tag === "a") {
        const hrefs = attrs.filter(([k, v]) => k === "href" && v).map(([, v]) => v as string);
        links.push(...hrefs);
        anchor = [chunks.length, hrefs];
      }
      if (BREAK_BEFORE.has(tag)) chunks.push("\n");
    },
    endtag(tag) {
      if (hidden.length) {
        if (tag === hidden[hidden.length - 1]) hidden.pop();
        return;
      }
      if (tag === "a" && anchor !== null) {
        const [start, hrefs] = anchor;
        const label = clean(chunks.slice(start).join(""));
        if (label.startsWith("查看完整資訊") && hrefs.length === 1 && canonical(hrefs[0])) ctaStarts.push(start);
        anchor = null;
      }
      if (BREAK_AFTER.has(tag)) chunks.push("\n");
    },
    data(data) {
      if (!hidden.length) chunks.push(data);
    },
  });
  if (ctaStarts.length !== 1) throw fail("Unsupported Tasker demand boundary");
  return { links, text: chunks.slice(0, ctaStarts[0]).join("") };
}

export function parseTasker(mail: MailMessage): PyDict[] {
  if (mail.sender !== "deals@tasker.com.tw") throw fail("Unverified Tasker sender");
  let links: string[], text: string;
  if (mail.isHtml) ({ links, text } = htmlParts(mail.body));
  else {
    text = mail.body;
    links = pyFindall(LINK, text);
    const boundaries = [...text.matchAll(BOUNDARY)].filter((m) => canonical(m[1]));
    if (boundaries.length !== 1) throw fail("Unsupported Tasker demand boundary");
    text = text.slice(0, boundaries[0].index);
  }
  const urls = new Set(links.map(canonical).filter((u): u is string => u !== null));
  if (urls.size !== 1) throw fail("Unsupported Tasker listing count or case URL");
  const titles = pyFindall(TITLE, mail.subject);
  if (titles.length !== 1) throw fail("Unsupported Tasker subject template");
  const title = clean(titles[0]);
  const normalized = clean(text);
  const header = pyRe(
    "\\d{4}/\\d{2}/\\d{2}\\s*(?:最新案件，限時搶先提案！|最新上架案件，歡迎提案)\\s*" + escape(title) + "\\s*(?:(\\$[\\d,]+)|預算詳談)(.*?)需求說明\\s*(.*?)\\s*$",
  ).exec(normalized);
  if (!title || !header || !pyStrip(header[3])) throw fail("Unsupported Tasker body template");
  const [url] = urls;
  const externalId = url.slice(url.lastIndexOf("/") + 1);
  return [PyDict.of({
    source: "tasker", external_id: externalId, canonical_url: url, url,
    receipt_id: `${mail.messageId}:${externalId}`, received_at: mail.receivedAt,
    title, description: pyStrip(header[3]),
    observed_amount: header[1] ?? null, language: "zh-TW", complete: false,
    kind: null, currency: null, budget_min: null, budget_max: null,
    weekly_hours: null, taiwan_eligible: null, timezone_compatible: null,
    deadline: null,
  })];
}

