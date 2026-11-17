import { escapeRegExp } from "@/platform/text";
import type { ListingInput } from "@/modules/listings/public";
import { collapseSpaces } from "../../shared/text";
import { loadMailHtml, type AnyNode } from "../html";
import { mailListing, type MailMessage } from "../message";
import { reject } from "../reasons";
import type { MailSourceSettings } from "../../types";

// Tasker: the single-case notification (「新案件【<title>】」) sent to the inbox, read as observed in
// 2026-09 (old collection/tasker.py, web/src/modules/collection/mail/tasker.ts at ce1254d). One message is
// one case: the subject's 【title】, the body's header line, the amount or 「預算詳談」, and the text under
// 「需求說明」 up to the one 「查看完整資訊」 link. Anything else refuses the message with the check that
// failed (reasons.ts), so a template change shows as rejected mail, never as an empty success. HTML is
// read with htmlparser2 through cheerio (document order, not repaired as HTML5 would). external_id is the
// case code of https://www.tasker.com.tw/cases/<code>, read with the standard URL parser.

export const SENDER = "deals@tasker.com.tw";
const HIDDEN = new Set(["script", "style", "noscript", "template"]);
const BREAK_BEFORE = new Set(["p", "div", "br", "tr", "td", "h1", "h2", "h3", "li"]);
const BREAK_AFTER = new Set(["p", "div", "tr", "td", "h1", "h2", "h3", "li"]);
const CTA = "查看完整資訊";
const TITLE = /【([^【】]+)】/gu;
// URLs may appear as visible pasted text, not just as link targets; they never reach the listing.
const PASTED_URL = /(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/\/|www\.|mailto:|tel:)[^\s<>]+/gu;
const LINK = /https?:\/\/[^\s<>]+/gu;
// A text-part line that is only the call to action and its link.
const BOUNDARY = /(?<![^\n])[ \t]*查看完整資訊[ \t]+(https:\/\/[^\s<>]+)[ \t]*(?![^\n])/gu;

/** The listing gate: a subject naming exactly one 【title】; other mail from Tasker (news, promotions) is not read. */
export const isCaseSubject = (subject: string) => [...subject.matchAll(TITLE)].length === 1;

const clean = (text: string) => collapseSpaces(text.replace(PASTED_URL, ""));

/** The case page of a link, or null when it is not one: https, www.tasker.com.tw, /cases/<code>. */
function casePage(href: string): string | null {
  if (!URL.canParse(href)) return null;
  const u = new URL(href);
  if (u.protocol !== "https:" || u.host !== "www.tasker.com.tw" || u.username || u.password) return null;
  return /^\/cases\/[A-Za-z0-9]+$/.test(u.pathname) ? `https://www.tasker.com.tw${u.pathname}` : null;
}


/** HTML part: every link target, and the text before the one call-to-action link. */
function htmlParts(html: string): { links: string[]; text: string } {
  const root = loadMailHtml(html);
  const chunks: string[] = [], links: string[] = [], ctaStarts: number[] = [];
  const walk = (node: AnyNode) => {
    if (node.type === "text") {
      chunks.push(node.data ?? "");
      return;
    }
    if (node.type !== "tag" && node.type !== "root") return;
    const tag = node.name ?? "";
    if (HIDDEN.has(tag)) return;
    if (BREAK_BEFORE.has(tag)) chunks.push("\n");
    const start = chunks.length;
    const hrefs = tag === "a" && node.attribs?.href ? [node.attribs.href] : [];
    links.push(...hrefs);
    for (const c of node.children ?? []) walk(c);
    if (tag === "a" && clean(chunks.slice(start).join("")).startsWith(CTA) && hrefs.length === 1 && casePage(hrefs[0])) ctaStarts.push(start);
    if (BREAK_AFTER.has(tag)) chunks.push("\n");
  };
  walk(root);
  if (ctaStarts.length !== 1) reject("tasker_boundary");
  return { links, text: chunks.slice(0, ctaStarts[0]).join("") };
}

/** Text part: every pasted link, and the text before the one call-to-action line. */
function textParts(body: string): { links: string[]; text: string } {
  const boundaries = [...body.matchAll(BOUNDARY)].filter((m) => casePage(m[1]));
  if (boundaries.length !== 1) reject("tasker_boundary");
  return { links: body.match(LINK) ?? [], text: body.slice(0, boundaries[0].index) };
}
/** CRLF, mail's wire form, is read as LF so the call-to-action line matches either way. */
const textPartsOf = (body: string) => textParts(body.replace(/\r\n?/gu, "\n"));

/** The one listing of a case notification, or a MailRejection naming the check that failed. */
export function parseTasker(message: MailMessage): ListingInput[] {
  if (message.sender !== SENDER) reject("tasker_unsupported");
  const { links, text } = message.isHtml ? htmlParts(message.body) : textPartsOf(message.body);
  const pages = new Set(links.map(casePage).filter((u): u is string => u !== null));
  if (pages.size !== 1) reject("tasker_case_link");
  const titles = [...message.subject.matchAll(TITLE)];
  if (titles.length !== 1) reject("tasker_subject");
  // Pasted URLs leave the body text, so the header is matched with the title cleaned the same way;
  // the listing keeps the title as written (a case named after its site keeps the domain).
  const title = collapseSpaces(titles[0][1]);
  const matchTitle = clean(title);
  const header = new RegExp(
    `\\d{4}/\\d{2}/\\d{2}\\s*(?:最新案件，限時搶先提案！|最新上架案件，歡迎提案)\\s*${escapeRegExp(matchTitle)}\\s*(?:(\\$[\\d,]+)|預算詳談)(.*?)需求說明\\s*(.*?)\\s*$`, "u",
  ).exec(clean(text));
  const description = header?.[3].trim();
  if (!matchTitle || !description) reject("tasker_body");
  const [url] = pages;
  return [mailListing({
    external_id: url.slice(url.lastIndexOf("/") + 1), title, url, canonical_url: url, description,
    compensation_evidence: header![1] ?? null, complete: false, extra: { language: "zh-TW" },
  })];
}

export const TASKER_SETTINGS: Omit<MailSourceSettings, "order"> = {
  kind: "mail", name: "tasker", label: "出任務", sender: SENDER, subjectGate: isCaseSubject, parse: parseTasker, preferText: false,
  // One page of the inbox list per request; bodies only for new notifications (a few a day).
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 60, completeRead: false, disabled: null,
};
