import { htmlFeed } from "@/platform/py/html";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { casefold, pyLen, pyStrip } from "@/platform/py/unicode";
import { queryValues, urlsplit } from "@/platform/py/url";
import { PyDict, PyError } from "@/platform/py/value";
import { attr, FULL_TIME, mailParseError, receivedAt, squash } from "./common";
import type { MailMessage } from "./message";

// Port of collection/glassdoor_mail.py: observed Glassdoor alerts; summary cards never imply full job
// evidence, and a relative age is not a publication date.

const SENDER = "noreply@glassdoor.com";
const SUBJECT = "All the top jobs for .{1,500}\\. Ready to apply\\?";
const CONTRACT = pyRe("兼職|接案|\\b(?:contractor|contract|freelance|part[ -]time)\\b", true);

export const isJobSubject = (value: unknown) => typeof value === "string"
  && (pyFullmatch(SUBJECT, value) !== null || pyFullmatch(".{1,200} at .{1,200} and \\d{1,3} more jobs in .{1,200} for you\\. Apply Now\\.", value) !== null);

export function canonical(value: string | null | undefined): [string, string] {
  try {
    if (typeof value !== "string" || pyLen(value) > 8192) throw new PyError("ValueError", "");
    const url = urlsplit(value);
    const ids = queryValues(url.query, "jobListingId", { keepBlankValues: true, maxNumFields: 50 });
    if (url.scheme !== "https" || url.netloc !== "www.glassdoor.com" || url.path !== "/partner/jobListing.htm" || url.fragment
        || ids.length !== 1 || !/^[0-9]{10,20}$/.test(ids[0])) throw new PyError("ValueError", "");
    return [ids[0], "https://www.glassdoor.com/partner/jobListing.htm?jobListingId=" + ids[0]];
  } catch {
    throw mailParseError("Unsupported Glassdoor listing link");
  }
}

type Card = { job_id: string; source_url: string; company: string; title: string; relative_date: string; easy_apply: boolean };

function inspect(message: MailMessage): Card[] {
  if (casefold(message.sender) !== SENDER || !message.isHtml || !isJobSubject(message.subject) || Buffer.byteLength(message.body, "utf8") > 1_000_000) {
    throw mailParseError("Unsupported Glassdoor notification");
  }
  receivedAt(message.receivedAt, "Invalid Glassdoor timestamp");
  let current: { job_id: string; source_url: string; company_parts: string[]; paragraphs: string[] } | null = null;
  let spans = 0, paragraph: string[] | null = null;
  const cards: Card[] = [];
  htmlFeed(message.body, {
    starttag(tag, attrs) {
      if (tag === "a") {
        if (current !== null) throw mailParseError("Nested Glassdoor listing link");
        const href = attr(attrs, "href", "");
        // A bare href fails the message in Python ('jobListing' in None).
        if (typeof href !== "string") throw mailParseError("Unsupported Glassdoor link attributes");
        if (href.includes("jobListing")) {
          const [id, url] = canonical(href);
          current = { job_id: id, source_url: url, company_parts: [], paragraphs: [] };
        }
      } else if (current !== null) {
        if (tag === "script" || tag === "style") throw mailParseError("Unexpected Glassdoor card content");
        if (tag === "span") spans++;
        if (tag === "p") {
          if (paragraph !== null) throw mailParseError("Nested Glassdoor paragraph");
          paragraph = [];
        }
      }
    },
    data(value) {
      if (current === null) return;
      if (paragraph !== null) paragraph.push(value);
      else if (spans) current.company_parts.push(value);
      else if (pyStrip(value)) throw mailParseError("Unexpected Glassdoor card text");
    },
    endtag(tag) {
      if (current === null) return;
      if (tag === "span") {
        if (--spans < 0) throw mailParseError("Unbalanced Glassdoor company field");
      } else if (tag === "p") {
        if (paragraph === null) throw mailParseError("Unbalanced Glassdoor paragraph");
        current.paragraphs.push(squash(paragraph));
        paragraph = null;
      } else if (tag === "a") {
        const company = squash(current.company_parts), paragraphs = current.paragraphs;
        if (spans || paragraph !== null || !company || pyLen(company) > 500 || (paragraphs.length !== 2 && paragraphs.length !== 3)
            || !paragraphs[0] || pyLen(paragraphs[0]) > 1000 || (paragraphs.length === 3 && paragraphs[1] !== "Easy Apply")
            || !pyFullmatch("(?:\\d{1,3}[dh]|Just posted)", paragraphs[paragraphs.length - 1])) throw mailParseError("Incomplete Glassdoor card");
        cards.push({ job_id: current.job_id, source_url: current.source_url, company, title: paragraphs[0], relative_date: paragraphs[paragraphs.length - 1], easy_apply: paragraphs.length === 3 });
        current = null;
        if (cards.length > 100) throw mailParseError("Too many Glassdoor cards");
      }
    },
  }, true);
  if (current !== null || !cards.length) throw mailParseError("Incomplete Glassdoor notification");
  if (new Set(cards.map((c) => c.job_id)).size !== cards.length) throw mailParseError("Duplicate Glassdoor listing");
  return cards;
}

export function parseGlassdoor(message: MailMessage): PyDict[] {
  return inspect(message).map((card) => {
    const title = card.title;
    const kind = FULL_TIME.test(title) ? "full_time" : CONTRACT.test(title) ? "contract" : null;
    const job = PyDict.of({
      source: "glassdoor", external_id: card.job_id,
      url: card.source_url, canonical_url: card.source_url,
      title, company: card.company, location: null,
      description: "Glassdoor notification card only: " + title + "\n" + card.company,
      salary_text: null, kind, complete: false, body_available: false,
      language: "en", taiwan_eligible: null, timezone_compatible: null,
      weekly_hours: null, currency: null, budget_min: null, budget_max: null,
      deadline: null, published_at: null,
    });
    const out = new PyDict(job);
    // Python keeps the message's own timestamp text here, not its isoformat().
    out.set("received_at", message.receivedAt);
    out.set("receipt_id", "glassdoor:" + identityHash(job));
    return out;
  });
}
