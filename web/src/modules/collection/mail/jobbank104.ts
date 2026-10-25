import { htmlFeed } from "@/platform/py/html";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { casefold, pyInt, pyStrip } from "@/platform/py/unicode";
import { urlsplit, type SplitResult } from "@/platform/py/url";
import { PyDict, PyError } from "@/platform/py/value";
import { attr, FULL_TIME, mailParseError, receivedAt } from "./common";
import type { MailMessage } from "./message";

// Port of collection/jobbank104_mail.py: observed 104 matching-digest cards; no website requests or
// recommendation guessing.

const SENDER = "jobbank@ms1.104.com.tw";
const SUBJECT = ".{1,100}\\d{2}/\\d{2}的配對日報，符合職缺(\\d{1,3})筆";

/** The listing gate of resend_preview.matches: the same subject the parser requires. */
export const isJobSubject = (subject: string) => pyFullmatch(SUBJECT, subject) !== null;
const CONTRACT = pyRe("兼職|接案|\\b(?:part[ -]time|freelance)\\b", true);
type Card = { external_id: string; title: string; url: string; parts: string[]; company?: string };

function cards(body: string) {
  let anchor: string | null = null, label: string[] = [], current: Card | null = null, stopped = false;
  const found: Card[] = [];
  htmlFeed(body, {
    starttag(tag, attrs) {
      if (tag !== "a") return;
      if (anchor !== null) throw mailParseError("Nested 104 links");
      // dict(attrs).get('href', ''): a bare href is None, which leaves the parser outside any link.
      anchor = attr(attrs, "href", "") ?? null;
      label = [];
    },
    data(raw) {
      const value = pyStrip(raw);
      if (!value) return;
      if (anchor !== null) label.push(value);
      else if (value === "適合你大展身手的工作") stopped = true;
      else if (current !== null && !stopped) current.parts.push(value);
    },
    endtag(tag) {
      if (tag !== "a" || anchor === null) return;
      const text = label.join(" ");
      let url: SplitResult;
      try {
        url = urlsplit(anchor);
      } catch (e) {
        if (e instanceof PyError && e.pyType === "ValueError") throw mailParseError("Invalid 104 link");
        throw e;
      }
      anchor = null;
      if (stopped) return;
      const match = /^\/job\/([a-z0-9]+)$/.exec(url.path);
      if (match) {
        if (url.scheme !== "https" || url.netloc !== "www.104.com.tw" || !text) throw mailParseError("Unsupported 104 job link");
        if (current !== null) throw mailParseError("Incomplete 104 card");
        current = { external_id: match[1], title: text, url: "https://www.104.com.tw" + url.path, parts: [] };
      } else if (current !== null) {
        if (url.scheme === "https" && url.netloc === "www.104.com.tw" && /^\/company\/[a-z0-9]+$/.test(url.path)) {
          if (current.company || !text) throw mailParseError("Ambiguous 104 company");
          current.company = text;
        } else if (url.scheme === "https" && url.netloc === "104app.onelink.me" && url.path === "/zB8j/apply" && text === "我要應徵") {
          found.push(current);
          current = null;
        }
      }
    },
  }, true);
  return { cards: found, current, anchor, stopped };
}

export function parse104(message: MailMessage): PyDict[] {
  const match = pyFullmatch(SUBJECT, message.subject);
  if (casefold(message.sender) !== SENDER || !message.isHtml || !match) throw mailParseError("Unsupported 104 notification");
  const received = receivedAt(message.receivedAt, "Invalid 104 notification");
  if (Buffer.byteLength(message.body, "utf8") > 1_000_000) throw mailParseError("Invalid 104 notification");
  const parsed = cards(message.body);
  if (!parsed.stopped || parsed.current !== null || parsed.anchor !== null || BigInt(parsed.cards.length) !== pyInt(match[1]) || !parsed.cards.length) {
    throw mailParseError("Incomplete 104 matching digest");
  }
  const seen = new Set<string>();
  return parsed.cards.map((card) => {
    if (!card.company || !card.parts.length || seen.has(card.external_id)) throw mailParseError("Invalid or duplicate 104 card");
    seen.add(card.external_id);
    const title = card.title;
    const kind = FULL_TIME.test(title) ? "full_time" : CONTRACT.test(title) ? "contract" : null;
    const job = PyDict.of({
      source: "jobbank104", external_id: card.external_id, title,
      company: card.company, url: card.url, canonical_url: card.url,
      description: card.parts.join("\n"), kind, complete: false,
      body_available: false, language: "zh-TW", taiwan_eligible: null,
      timezone_compatible: null, weekly_hours: null, currency: null,
      budget_min: null, budget_max: null, deadline: null, published_at: null,
    });
    const out = new PyDict(job);
    out.set("received_at", received.isoformat());
    out.set("receipt_id", "jobbank104:" + identityHash(job));
    return out;
  });
}
