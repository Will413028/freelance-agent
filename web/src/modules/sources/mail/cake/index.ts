import { inflateSync } from "node:zlib";
import type { JobInput } from "@/modules/listings/public";
import { loadMailHtml, type AnyNode } from "../html";
import { jobKind, wordsIgnoreCase } from "../kind";
import { mailListing, type MailMessage } from "../message";
import { reject } from "../reasons";
import type { MailSourceSettings } from "../../types";

// Cake: the followed-company notification (「您追蹤的 <company> 刊登了一筆新職缺 - <title>」), read as
// observed (old collection/cake_mail.py, web/src/modules/collection/mail/cake.ts at ce1254d). One message
// is one job: company and title from the subject, the job page from the one 「了解詳情」 link. That link
// is either the job page or Cake's tracker (https://email.no-reply.cake.me/c/<token>), whose token is
// base64url zlib data holding the target as its one `l` query value: it is decoded here, never visited.
// The mail carries no description, so the listing is a summary (complete false). external_id is
// `<company>/<job>` of https://www.cake.me/companies/<company>/jobs/<job>, read with the standard URL parser.

export const SENDER = "notifications@no-reply.cake.me";
const MAX_LINK = 8192;
// [^\n] as the old pattern's "." (a subject may carry \r or U+2028).
const SUBJECT = /^您追蹤的 ([^\n]{1,300}?) 刊登了一筆新職缺 - ([^\n]{1,500})$/u;
const CONTRACT = wordsIgnoreCase(String.raw`兼職|接案|\b(?:freelance|part[ -]time|contract)\b`);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The listing gate: only job notifications are read (Cake also sends messages and account mail). */
export const isJobSubject = (subject: string) => subject.includes("刊登了一筆新職缺");

/** The tracker's target: the token inflates exactly (nothing left over, at most 8 KiB) to a query with one `l`. */
function trackerTarget(token: string): string | null {
  if (token.length % 4 === 1) return null;
  let raw: Buffer;
  try {
    const compressed = Buffer.from(token, "base64url");
    const { buffer, engine } = inflateSync(compressed, { info: true, maxOutputLength: MAX_LINK }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (engine.bytesWritten !== compressed.length) return null;
    raw = buffer;
  } catch {
    return null;
  }
  let query: string;
  try {
    query = UTF8.decode(raw);
  } catch {
    return null;
  }
  const fields = query.split("&");
  if (fields.length > 20 || fields.some((f) => !f.includes("="))) return null;
  // Blank values are dropped, as the old parse_qs did, so an empty `l=` beside the target is no second link.
  const links = [...new URLSearchParams(query)].filter(([k, v]) => k === "l" && v !== "").map(([, v]) => v);
  return links.length === 1 ? links[0] : null;
}

/** The job page [url, external_id] a 「了解詳情」 link points at, or null when it is not one. */
export function jobPage(href: string): [string, string] | null {
  if (href.length > MAX_LINK || !URL.canParse(href)) return null;
  let u = new URL(href);
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (u.host === "email.no-reply.cake.me") {
    const token = /^\/c\/([A-Za-z0-9_-]{1,8192})$/.exec(u.pathname);
    if (!token || u.search || u.hash) return null;
    const target = trackerTarget(token[1]);
    if (target === null || !URL.canParse(target)) return null;
    u = new URL(target);
    if (u.protocol !== "https:" || u.username || u.password) return null;
  }
  if (u.host !== "www.cake.me" && u.host !== "cake.me") return null;
  const job = /^\/companies\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
  return job ? [`https://www.cake.me/companies/${job[1]}/jobs/${job[2]}`, `${job[1]}/${job[2]}`] : null;
}


/** Every 「了解詳情」 link's href; a link inside a link refuses the message. */
function detailLinks(html: string): string[] {
  const root = loadMailHtml(html);
  const hrefs: string[] = [];
  const text = (node: AnyNode): string => node.type === "text" ? node.data ?? "" : (node.children ?? []).map((c) => {
    if (c.type === "tag" && c.name === "a") reject("cake_nested_link");
    return text(c);
  }).join("");
  const walk = (node: AnyNode) => {
    if (node.type === "tag" && node.name === "a") {
      if (text(node).trim() === "了解詳情") hrefs.push(node.attribs?.href ?? "");
    } else for (const c of node.children ?? []) walk(c);
  };
  walk(root);
  return hrefs;
}

/** The one listing of a job notification, or a MailRejection naming the check that failed. */
export function parseCake(message: MailMessage): JobInput[] {
  if (message.sender !== SENDER || !message.isHtml) reject("cake_unsupported");
  const subject = SUBJECT.exec(message.subject);
  if (!subject) reject("cake_subject");
  const pages = detailLinks(message.body).map((href) => jobPage(href) ?? reject("cake_job_link"));
  const unique = new Map(pages.map(([url, id]) => [id, url]));
  if (unique.size !== 1) reject("cake_job_link_count");
  const [[externalId, url]] = unique;
  const [, company, title] = subject!;
  return [mailListing({
    external_id: externalId, title, company, url, canonical_url: url,
    description: `Cake 新職缺通知摘要：${title}\n${company}`, complete: false,
    kind: jobKind(title, CONTRACT),
    extra: { language: "zh-TW" },
  })];
}

export const CAKE_SETTINGS: Omit<MailSourceSettings, "order"> = {
  opportunityType: "job",
  kind: "mail", name: "cake", label: "Cake", sender: SENDER, subjectGate: isJobSubject, parse: parseCake, preferText: false,
  // One page of the inbox list per request; bodies only for new notifications.
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 60, completeRead: false, disabled: null,
};
