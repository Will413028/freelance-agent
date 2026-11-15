import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { MailMessage } from "../message";
import { MailRejection, reject } from "../reasons";
import type { MailSourceSettings } from "../../types";

// 104 job bank: the daily matching digest (「…MM/DD的配對日報，符合職缺N筆」) sent to the inbox, read
// card by card as observed (old collection/jobbank104_mail.py, web/src/modules/collection/mail/jobbank104.ts
// until step 11). No request goes to 104 and nothing is guessed from recommendations: a card is a job link,
// a company link, text, and the apply link; cards after 「適合你大展身手的工作」 (104's own suggestions)
// are not read. The whole digest is refused when its structure is off (one code per check, reasons.ts),
// so a template change shows as rejected mail instead of silently fewer listings. HTML is parsed with
// htmlparser2 through cheerio (document order, nested links kept visible, not repaired as HTML5 would).
// external_id is the job code of https://www.104.com.tw/job/<code>, read with the standard URL parser.

export const SENDER = "jobbank@ms1.104.com.tw";
const SUBJECT = /^.{1,100}\d{2}\/\d{2}的配對日報，符合職缺(\d{1,3})筆$/u;
const STOP = "適合你大展身手的工作";
const MAX_BODY_BYTES = 1_000_000;
const FULL_TIME = /全職|\bfull[ -]time\b/i;
const CONTRACT = /兼職|接案|\b(?:part[ -]time|freelance)\b/i;

/** The listing gate: only the matching digest's subject is read. */
export const isDigestSubject = (subject: string) => SUBJECT.test(subject);

/** The parts of a domhandler node this walk reads (cheerio does not export the type). */
type AnyNode = { type: string; data?: string; name?: string; attribs?: Record<string, string>; children?: AnyNode[] };

type Card = { id: string; title: string; url: string; parts: string[]; company?: string };
const strip = (s: string) => s.replace(/^\s+|\s+$/gu, "");
const on104 = (u: URL | null): u is URL => u !== null && u.protocol === "https:" && u.host === "www.104.com.tw" && !u.username && !u.password;

function readCards(html: string) {
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: true } }, false);
  const cards: Card[] = [];
  let current: Card | null = null, stopped = false;

  const linkText = (node: AnyNode, out: string[]) => {
    if (node.type === "text") {
      const v = strip(node.data ?? "");
      if (v) out.push(v);
    } else {
      for (const c of node.children ?? []) {
        if (c.type === "tag" && c.name === "a") reject("104_nested_link");
        linkText(c, out);
      }
    }
  };

  const link = (href: string, text: string) => {
    // A malformed href (not even a relative URL) refuses the digest; a relative one is no 104 link.
    if (!URL.canParse(href, "https://relative.invalid/")) reject("104_invalid_link");
    if (stopped) return;
    const url = URL.canParse(href) ? new URL(href) : null;
    const job = url ? /^\/job\/([a-z0-9]+)$/.exec(url.pathname) : null;
    if (job) {
      if (!on104(url) || !text) reject("104_unsupported_job_link");
      if (current !== null) reject("104_incomplete_card");
      current = { id: job[1], title: text, url: `https://www.104.com.tw${url!.pathname}`, parts: [] };
    } else if (current !== null && url !== null) {
      if (on104(url) && /^\/company\/[a-z0-9]+$/.test(url.pathname)) {
        if (current.company || !text) reject("104_ambiguous_company");
        current.company = text;
      } else if (url.protocol === "https:" && url.host === "104app.onelink.me" && url.pathname === "/zB8j/apply" && text === "我要應徵") {
        cards.push(current);
        current = null;
      }
    }
  };

  const walk = (node: AnyNode) => {
    if (node.type === "text") {
      const v = strip(node.data ?? "");
      if (!v) return;
      if (v === STOP) stopped = true;
      else if (current !== null && !stopped) current.parts.push(v);
    } else if (node.type === "tag" && node.name === "a") {
      const out: string[] = [];
      linkText(node, out);
      link(node.attribs?.href ?? "", out.join(" "));
    } else {
      for (const c of node.children ?? []) walk(c);
    }
  };
  walk($.root()[0] as unknown as AnyNode);
  return { cards, open: current !== null, stopped };
}

/** The listings of one digest, or a MailRejection naming the check that failed. */
export function parse104(message: MailMessage): ListingInput[] {
  const subject = SUBJECT.exec(message.subject);
  if (message.sender !== SENDER || !message.isHtml || !subject) reject("104_unsupported");
  if (Buffer.byteLength(message.body, "utf8") > MAX_BODY_BYTES) reject("body_too_large");
  const { cards, open, stopped } = readCards(message.body);
  if (!stopped || open || !cards.length || cards.length !== Number(subject![1])) reject("104_incomplete_digest");
  const seen = new Set<string>();
  return cards.map((card) => {
    if (!card.company || !card.parts.length) reject("104_invalid_card");
    if (seen.has(card.id)) reject("104_duplicate_card");
    seen.add(card.id);
    try {
      return parseListingInput({
        external_id: card.id, title: card.title, company: card.company, url: card.url, canonical_url: card.url,
        description: card.parts.join("\n"), complete: false,
        kind: FULL_TIME.test(card.title) ? "full_time" : CONTRACT.test(card.title) ? "contract" : null,
      });
    } catch (e) {
      if (e instanceof MailRejection) throw e;
      return reject("contract_refused");
    }
  });
}

export const JOBBANK104_SETTINGS: Omit<MailSourceSettings, "order"> = {
  kind: "mail", name: "jobbank104", sender: SENDER, subjectGate: isDigestSubject, parse: parse104, preferText: false,
  // One page of the inbox list per request; bodies only for new digests (about one a day).
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 45, completeRead: false, disabled: null,
};
