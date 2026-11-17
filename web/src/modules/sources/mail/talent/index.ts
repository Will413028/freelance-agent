import type { ListingInput } from "@/modules/listings/public";
import { replay, squash } from "../html";
import { jobKind, wordsIgnoreCase } from "../kind";
import { mailListing, type MailMessage } from "../message";
import { reject } from "../reasons";
import type { MailSourceSettings } from "../../types";

// Talent.com: the job alert's cards, read offline as observed (old collection/talent_mail.py,
// web/src/modules/collection/mail/talent.ts at ce1254d), in two templates told apart by the subject:
// "described" (更多职位，例如…), whose cards mark Title, Location, Company, Salary and Description with
// HTML comments inside one job link, and "card only" (software engineer … jobs you don't want to miss),
// whose cards are a link around a link with the title, then location and company rows. The mail holds
// summaries only (complete false). external_id is the 12-hex id of https://tw.talent.com/redirect?id=…,
// whose public page is https://tw.talent.com/view?id=…; the redirect is never visited.

export const SENDER = "no-reply@alerts.talent.com";
const MAX_CARDS = 100;
const FIELDS = ["Title", "Location", "Company", "Salary", "Description"] as const;
const CONTRACT = wordsIgnoreCase(String.raw`兼職|接案|\b(?:contractor|contract|freelance|part[ -]time)\b`);
type Identity = [id: string, url: string];
type Card = { identity: Identity; Title: string; Location: string; Company: string; Salary?: string; Description?: string };

/** The template a subject names, or null (the listing gate). */
export function subjectFormat(subject: string): "described" | "card_only" | null {
  if (/^更多职位，例如[^\n]{1,500}$/u.test(subject)) return "described";
  if (/^software engineer(?: - [^\r\n]{1,200})? jobs you don't want to miss$/iu.test(subject)) return "card_only";
  return null;
}

export const isAlertSubject = (subject: string) => subjectFormat(subject) !== null;

/** The job of a card link: https://tw.talent.com/redirect with exactly one 12-hex `id`, or null. */
export function jobOf(href: string | undefined): Identity | null {
  if (href === undefined || href.length > 8192 || !URL.canParse(href)) return null;
  const u = new URL(href);
  const ids = u.searchParams.getAll("id");
  if (u.protocol !== "https:" || u.host !== "tw.talent.com" || u.username || u.password || u.pathname !== "/redirect" || u.hash) return null;
  if ([...u.searchParams].length > 30 || ids.length !== 1 || !/^[a-f0-9]{12}$/.test(ids[0])) return null;
  return [ids[0], `https://tw.talent.com/view?id=${ids[0]}`];
}
const job = (href: string | undefined) => jobOf(href) ?? reject("talent_job_link");

/** The described template: fields marked by comments inside one job link per card. */
function describedCards(html: string): Card[] {
  let depth = 0, stage = -1, links = 0;
  // The job the card's outer link names; the inner job__link must name the same one.
  let outer: Identity | null = null;
  let current: (Record<(typeof FIELDS)[number], string[]> & { identity?: Identity }) | null = null;
  const cards: Card[] = [];
  replay(html, {
    comment(raw) {
      const next = FIELDS.indexOf(raw.trim() as (typeof FIELDS)[number]);
      if (next < 0) return;
      if (next === 0) {
        if (current !== null || depth !== 1) reject("talent_card_boundary");
        current = { Title: [], Location: [], Company: [], Salary: [], Description: [] };
        stage = -1;
        links = 0;
      }
      if (current === null || next !== stage + 1) reject("talent_field_order");
      stage = next;
    },
    starttag(tag, attribs) {
      if (tag !== "a") return;
      depth++;
      if (depth === 1) outer = jobOf(attribs.href);
      if ((attribs.class ?? "").split(/\s+/u).includes("job__link")) {
        if (current === null || stage !== 0 || links) reject("talent_card_link");
        current!.identity = job(attribs.href);
        if (outer === null || outer[0] !== current!.identity[0]) reject("talent_card_link");
        links++;
      }
    },
    data(value) {
      if (current !== null) current[FIELDS[stage]].push(value);
    },
    endtag(tag, implied) {
      if (tag !== "a") return;
      if (implied) reject("talent_unbalanced");
      depth--;
      if (current !== null && depth === 0) {
        if (stage !== 4 || links !== 1) reject("talent_incomplete_card");
        const card = Object.fromEntries(FIELDS.map((k) => [k, squash(current![k])])) as Record<(typeof FIELDS)[number], string>;
        if (!card.Title || !card.Location || !card.Company || !card.Description) reject("talent_empty_card");
        cards.push({ ...card, identity: current.identity! });
        current = null;
      }
    },
  });
  if (current !== null) reject("talent_incomplete_alert");
  return cards;
}

/** The card-only template: inside 「Job cards」, a link around a link to the same job, then location and company rows. */
function cardOnlyCards(html: string): Card[] {
  let section = 0, trDepth = 0, linkDepth = 0, titleRowDepth: number | null = null;
  let stage: "await_title" | "title" | "title_row" | "location" | "company" | "done" | null = null;
  let current: { identity: Identity; Title: string[]; Location: string[]; Company: string[] } | null = null;
  const cards: Card[] = [];
  replay(html, {
    comment(raw) {
      const marker = raw.trim();
      if (marker === "Job cards") {
        if (section) reject("talent_card_boundary");
        section = 1;
      } else if (marker === "View more jobs button" && section === 1) {
        if (current !== null || linkDepth || trDepth) reject("talent_incomplete_alert");
        section = 2;
      }
    },
    starttag(tag, attribs) {
      if (section !== 1) return;
      if (tag === "tr") trDepth++;
      else if (tag === "a") {
        const identity = job(attribs.href);
        if (linkDepth === 0) {
          current = { identity, Title: [], Location: [], Company: [] };
          stage = "await_title";
          linkDepth = 1;
        } else if (linkDepth === 1 && stage === "await_title" && identity[0] === current!.identity[0]) {
          titleRowDepth = trDepth;
          stage = "title";
          linkDepth = 2;
        } else reject("talent_card_link");
      }
    },
    data(value) {
      if (section !== 1 || current === null) return;
      if (stage === "title" && linkDepth === 2) current.Title.push(value);
      else if (linkDepth === 1 && trDepth === titleRowDepth && (stage === "location" || stage === "company")) {
        current[stage === "location" ? "Location" : "Company"].push(value);
      }
    },
    endtag(tag, implied) {
      if (section !== 1) return;
      if (implied && (tag === "a" || tag === "tr")) reject("talent_unbalanced");
      if (tag === "tr") {
        // A row closed that opened before the card section: the section escaped its row.
        if (trDepth < 1) reject("talent_unbalanced");
        if (current !== null && linkDepth === 1 && trDepth === titleRowDepth) {
          if (stage === "title_row") stage = "location";
          else if (stage === "location") stage = "company";
          else if (stage === "company") stage = "done";
        }
        trDepth--;
      } else if (tag === "a") {
        if (linkDepth === 2 && stage === "title") {
          linkDepth = 1;
          stage = "title_row";
        } else if (linkDepth === 1 && stage === "done") {
          const card = { Title: squash(current!.Title), Location: squash(current!.Location), Company: squash(current!.Company) };
          if (!card.Title) reject("talent_empty_card");
          cards.push({ ...card, identity: current!.identity });
          current = null;
          linkDepth = 0;
          titleRowDepth = null;
          stage = null;
        } else reject("talent_incomplete_card");
      }
    },
  });
  if (section !== 2) reject("talent_incomplete_alert");
  return cards;
}

/** The listings of one alert, or a MailRejection naming the check that failed. */
export function parseTalent(message: MailMessage): ListingInput[] {
  const template = subjectFormat(message.subject);
  if (message.sender !== SENDER || !message.isHtml || template === null) reject("talent_unsupported");
  const cards = template === "described" ? describedCards(message.body) : cardOnlyCards(message.body);
  if (cards.length < 1 || cards.length > MAX_CARDS) reject("talent_incomplete_alert");
  const seen = new Set<string>();
  return cards.map((card) => {
    const [id, url] = card.identity;
    if (seen.has(id)) reject("talent_duplicate_card");
    seen.add(id);
    const description = template === "described" ? card.Description!
      : "Talent.com notification card only: " + [card.Title, card.Company, card.Location].filter(Boolean).join("\n");
    const evidence = card.Title + (template === "described" ? "\n" + card.Description : "");
    return mailListing({
      external_id: id, title: card.Title, company: card.Company || null, location: card.Location || null, url, canonical_url: url,
      description, compensation_evidence: card.Salary || null, complete: false,
      kind: jobKind(evidence, CONTRACT),
      extra: { language: "en" },
    });
  });
}

export const TALENT_SETTINGS: Omit<MailSourceSettings, "order"> = {
  kind: "mail", name: "talent", label: "Talent.com", sender: SENDER, subjectGate: isAlertSubject, parse: parseTalent, preferText: false,
  // One page of the inbox list per request; bodies only for new alerts.
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 60, completeRead: false, disabled: null,
};
