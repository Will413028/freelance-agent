import type { ListingInput } from "@/modules/listings/public";
import { replay, squash } from "../html";
import { jobKind, wordsIgnoreCase } from "../kind";
import { mailListing, type MailMessage } from "../message";
import { reject } from "../reasons";
import type { MailSourceSettings } from "../../types";

// Glassdoor: the job alert's cards, read offline as observed (old collection/glassdoor_mail.py,
// web/src/modules/collection/mail/glassdoor.ts at ce1254d). A card is one listing link holding the
// company in spans and two or three paragraphs: the title, optionally 「Easy Apply」, and a relative age
// (「3d」, 「Just posted」). The age is no publication date and the card no full listing (complete false).
// The scan refuses anything else, including an element the body never closed (htmlparser2 closes it;
// replay tells), so a cut-off or changed template is rejected mail, never fewer listings. external_id is
// the jobListingId of https://www.glassdoor.com/partner/jobListing.htm, which is never visited.

export const SENDER = "noreply@glassdoor.com";
const MAX_CARDS = 100;
const CONTRACT = wordsIgnoreCase(String.raw`兼職|接案|\b(?:contractor|contract|freelance|part[ -]time)\b`);
const AGE = /^(?:\d{1,3}[dh]|Just posted)$/u;

/** The listing gate: the two alert subjects observed. */
export const isJobSubject = (subject: string) => /^All the top jobs for [^\n]{1,500}\. Ready to apply\?$/u.test(subject)
  || /^[^\n]{1,200} at [^\n]{1,200} and \d{1,3} more jobs in [^\n]{1,200} for you\. Apply Now\.$/u.test(subject);

/** The listing a link names: https://www.glassdoor.com/partner/jobListing.htm with one 10–20 digit jobListingId, or null. */
export function listingOf(href: string): [id: string, url: string] | null {
  if (href.length > 8192 || !URL.canParse(href)) return null;
  const u = new URL(href);
  const ids = u.searchParams.getAll("jobListingId");
  if (u.protocol !== "https:" || u.host !== "www.glassdoor.com" || u.username || u.password || u.pathname !== "/partner/jobListing.htm" || u.hash) return null;
  if ([...u.searchParams].length > 50 || ids.length !== 1 || !/^[0-9]{10,20}$/.test(ids[0])) return null;
  return [ids[0], `https://www.glassdoor.com/partner/jobListing.htm?jobListingId=${ids[0]}`];
}

/** Length in characters (code points), as the old limits counted. */
const chars = (s: string) => [...s].length;
type Card = { id: string; url: string; company: string; title: string };

function cardsOf(html: string): Card[] {
  let current: { id: string; url: string; company: string[]; paragraphs: string[] } | null = null;
  let spans = 0, paragraph: string[] | null = null;
  const cards: Card[] = [];
  replay(html, {
    starttag(tag, attribs) {
      if (tag === "a") {
        if (current !== null) reject("glassdoor_nested_link");
        const href = attribs.href ?? "";
        if (href.includes("jobListing")) {
          const [id, url] = listingOf(href) ?? reject("glassdoor_listing_link");
          current = { id, url, company: [], paragraphs: [] };
        }
      } else if (current !== null) {
        if (tag === "script" || tag === "style") reject("glassdoor_card_content");
        if (tag === "span") spans++;
        // A paragraph opened inside another (nested in a span, so the parser does not close the outer one)
        // leaves the outer </p> without an open paragraph, which refuses the card below.
        if (tag === "p") paragraph = [];
      }
    },
    data(value) {
      if (current === null) return;
      if (paragraph !== null) paragraph.push(value);
      else if (spans) current.company.push(value);
      else if (value.trim()) reject("glassdoor_card_content");
    },
    endtag(tag, implied) {
      if (current === null) return;
      // A card's link, paragraph or company span the body never closed (cut off, or a paragraph
      // opened inside another) refuses the alert.
      if (implied && (tag === "a" || tag === "p" || tag === "span")) reject("glassdoor_incomplete_card");
      // Every end event matches an element opened before it (htmlparser2 drops a stray end tag), so the
      // span count never goes below zero; a misnested one is closed for the body and refused above.
      if (tag === "span") spans--;
      else if (tag === "p") {
        if (paragraph === null) reject("glassdoor_incomplete_card");
        current.paragraphs.push(squash(paragraph!));
        paragraph = null;
      } else if (tag === "a") {
        const company = squash(current.company), p = current.paragraphs;
        if (spans || paragraph !== null || !company || chars(company) > 500 || (p.length !== 2 && p.length !== 3)
          || !p[0] || chars(p[0]) > 1000 || (p.length === 3 && p[1] !== "Easy Apply") || !AGE.test(p[p.length - 1])) reject("glassdoor_incomplete_card");
        cards.push({ id: current.id, url: current.url, company, title: p[0] });
        current = null;
        if (cards.length > MAX_CARDS) reject("glassdoor_incomplete_alert");
      }
    },
  });
  if (!cards.length) reject("glassdoor_incomplete_alert");
  if (new Set(cards.map((c) => c.id)).size !== cards.length) reject("glassdoor_duplicate_card");
  return cards;
}

/** The listings of one alert, or a MailRejection naming the check that failed. */
export function parseGlassdoor(message: MailMessage): ListingInput[] {
  if (message.sender !== SENDER || !message.isHtml || !isJobSubject(message.subject)) reject("glassdoor_unsupported");
  return cardsOf(message.body).map((card) => {
    return mailListing({
      external_id: card.id, title: card.title, company: card.company, url: card.url, canonical_url: card.url,
      description: `Glassdoor notification card only: ${card.title}\n${card.company}`, complete: false,
      kind: jobKind(card.title, CONTRACT),
      extra: { language: "en" },
    });
  });
}

export const GLASSDOOR_SETTINGS: Omit<MailSourceSettings, "order"> = {
  kind: "mail", name: "glassdoor", label: "Glassdoor", sender: SENDER, subjectGate: isJobSubject, parse: parseGlassdoor, preferText: false,
  // One page of the inbox list per request; bodies only for new alerts.
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 60, completeRead: false, disabled: null,
};
