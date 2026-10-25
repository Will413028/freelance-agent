import { inflateSync } from "node:zlib";
import { htmlFeed } from "@/platform/py/html";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { casefold, pyLen, pyStrip } from "@/platform/py/unicode";
import { queryValues, urlsplit } from "@/platform/py/url";
import { PyDict, PyError } from "@/platform/py/value";
import { attr, FULL_TIME, mailParseError, receivedAt } from "./common";
import type { MailMessage } from "./message";

// Port of collection/cake_mail.py: observed Cake followed-company notifications, without visiting trackers.

const SENDER = "notifications@no-reply.cake.me";

/** The listing gate of resend_preview.matches. */
export const isJobSubject = (subject: string) => subject.includes("刊登了一筆新職缺");
const CONTRACT = pyRe("兼職|接案|\\b(?:freelance|part[ -]time|contract)\\b", true);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** zlib.decompressobj().decompress(data, 8193) that must end the stream with nothing left over or held back. */
function inflateExact(compressed: Buffer): Buffer {
  const { buffer, engine } = inflateSync(compressed, { info: true, maxOutputLength: 8192 }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (engine.bytesWritten !== compressed.length) throw new PyError("ValueError", "unused data");
  return buffer;
}

export function canonical(value: string | null | undefined): string {
  try {
    if (typeof value !== "string" || pyLen(value) > 8192) throw new PyError("ValueError", "");
    let url = urlsplit(value);
    if (url.scheme !== "https") throw new PyError("ValueError", "");
    if (url.netloc === "email.no-reply.cake.me") {
      const match = /^\/c\/([A-Za-z0-9_-]{1,8192})$/.exec(url.path);
      if (!match || url.query || url.fragment) throw new PyError("ValueError", "");
      // b64decode(token + padding, altchars=b'-_', validate=True): only one too many characters fails.
      if (match[1].length % 4 === 1) throw new PyError("ValueError", "");
      const raw = inflateExact(Buffer.from(match[1], "base64url"));
      const links = queryValues(UTF8.decode(raw), "l", { strictParsing: true, maxNumFields: 20 });
      if (links.length !== 1) throw new PyError("ValueError", "");
      url = urlsplit(links[0]);
    }
    if (url.scheme !== "https" || (url.netloc !== "www.cake.me" && url.netloc !== "cake.me") || !/^\/companies\/[A-Za-z0-9_-]+\/jobs\/[A-Za-z0-9_-]+\/?$/.test(url.path)) {
      throw new PyError("ValueError", "");
    }
    return "https://www.cake.me" + url.path.replace(/\/+$/, "");
  } catch {
    // Every failure rejects the message the same way; readNotification does not tell classes apart.
    throw mailParseError("Unsupported Cake job link");
  }
}

export function parseCake(message: MailMessage): PyDict[] {
  if (casefold(message.sender) !== SENDER || !message.isHtml) throw mailParseError("Expected Cake HTML notification");
  const match = pyFullmatch("您追蹤的 (.{1,300}?) 刊登了一筆新職缺 - (.{1,500})", message.subject);
  if (!match || Buffer.byteLength(message.body, "utf8") > 1_000_000) throw mailParseError("Unsupported Cake notification template");
  const received = receivedAt(message.receivedAt, "Invalid Cake notification timestamp");
  // Details: href is None outside a link, and also for a bare `href` attribute, as dict(attrs) gives.
  let href: string | null = null, label: string[] = [];
  const urls: string[] = [];
  htmlFeed(message.body, {
    starttag(tag, attrs) {
      if (tag !== "a") return;
      if (href !== null) throw mailParseError("Nested Cake notification links");
      href = attr(attrs, "href", "") ?? null;
      label = [];
    },
    data(data) {
      if (href !== null) label.push(data);
    },
    endtag(tag) {
      if (tag !== "a" || href === null) return;
      if (pyStrip(label.join("")) === "了解詳情") urls.push(canonical(href));
      href = null;
      label = [];
    },
  }, true);
  const unique = new Set(urls);
  if (unique.size !== 1 || href !== null) throw mailParseError("Missing or ambiguous Cake job link");
  const [url] = unique;
  const [, company, title] = match;
  const kind = FULL_TIME.test(title) ? "full_time" : CONTRACT.test(title) ? "contract" : null;
  const job = PyDict.of({
    source: "cake", external_id: url, url, canonical_url: url, title,
    company, description: "Cake 新職缺通知摘要：" + title + "\n" + company,
    kind, taiwan_eligible: null, timezone_compatible: null, weekly_hours: null,
    budget_min: null, budget_max: null, currency: null, deadline: null, published_at: null,
    complete: false, body_available: false, language: "zh-TW",
  });
  const out = new PyDict(job);
  out.set("received_at", received.isoformat());
  out.set("receipt_id", "cake:" + identityHash(job));
  return [out];
}
