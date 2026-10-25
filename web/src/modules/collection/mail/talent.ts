import { htmlFeed } from "@/platform/py/html";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { casefold, pyLen, pySplit, pyStrip } from "@/platform/py/unicode";
import { queryValues, urlsplit } from "@/platform/py/url";
import { PyDict, PyError } from "@/platform/py/value";
import { attr, FULL_TIME, mailParseError, receivedAt, squash } from "./common";
import type { MailMessage } from "./message";

// Port of collection/talent_mail.py: observed Talent.com related-job cards; offline, summary only.
// The legacy hexadecimal ID resolves through the public /view endpoint; keep that source identity.

const SENDER = "no-reply@alerts.talent.com";
const FIELDS = ["Title", "Location", "Company", "Salary", "Description"] as const;
const CONTRACT = pyRe("兼職|接案|\\b(?:contractor|contract|freelance|part[ -]time)\\b", true);
type Identity = [string, string];

export function subjectFormat(subject: unknown): "described" | "card_only" | null {
  if (typeof subject !== "string") return null;
  if (pyFullmatch("更多职位，例如.{1,500}", subject)) return "described";
  if (pyFullmatch("software engineer(?: - [^\\r\\n]{1,200})? jobs you don't want to miss", subject, true)) return "card_only";
  return null;
}

export function canonical(value: string | null | undefined): Identity {
  try {
    if (typeof value !== "string" || pyLen(value) > 8192) throw new PyError("ValueError", "");
    const url = urlsplit(value);
    const ids = queryValues(url.query, "id", { keepBlankValues: true, maxNumFields: 30 });
    if (url.scheme !== "https" || url.netloc !== "tw.talent.com" || url.path !== "/redirect" || url.fragment || ids.length !== 1 || !/^[a-f0-9]{12}$/.test(ids[0])) {
      throw new PyError("ValueError", "");
    }
    return [ids[0], "https://tw.talent.com/view?id=" + ids[0]];
  } catch {
    throw mailParseError("Unsupported Talent job link");
  }
}

type Card = { identity: Identity; Title: string; Location: string; Company: string; Salary?: string; Description?: string };

/** Cards: the described template, fields marked by comments inside one job link. */
function describedCards(body: string) {
  let depth = 0, stage = -1, links = 0;
  let current: (Record<(typeof FIELDS)[number], string[]> & { identity?: Identity }) | null = null;
  const cards: Card[] = [];
  htmlFeed(body, {
    comment(raw) {
      const value = pyStrip(raw);
      const next = FIELDS.indexOf(value as (typeof FIELDS)[number]);
      if (next < 0) return;
      if (next === 0) {
        if (current !== null || depth !== 1) throw mailParseError("Malformed Talent card boundary");
        current = { Title: [], Location: [], Company: [], Salary: [], Description: [] };
        stage = -1;
        links = 0;
      }
      if (current === null || next !== stage + 1) throw mailParseError("Missing or reordered Talent fields");
      stage = next;
    },
    starttag(tag, attrs) {
      if (tag !== "a") return;
      depth++;
      const cls = attr(attrs, "class", "");
      // A bare class attribute fails the message in Python (None.split).
      if (typeof cls !== "string") throw mailParseError("Unsupported Talent link attributes");
      if (pySplit(cls).includes("job__link")) {
        if (current === null || stage !== 0 || links) throw mailParseError("Unexpected Talent job link");
        current.identity = canonical(attr(attrs, "href", null));
        links++;
      }
    },
    data(value) {
      if (current !== null) current[FIELDS[stage]].push(value);
    },
    endtag(tag) {
      if (tag !== "a") return;
      depth--;
      if (depth < 0) throw mailParseError("Unbalanced Talent links");
      if (current !== null && depth === 0) {
        if (stage !== 4 || links !== 1) throw mailParseError("Incomplete Talent card");
        const card = Object.fromEntries(FIELDS.map((k) => [k, squash(current![k])])) as Record<(typeof FIELDS)[number], string>;
        if (!card.Title || !card.Location || !card.Company || !card.Description) throw mailParseError("Empty Talent card");
        cards.push({ ...card, identity: current.identity! });
        current = null;
      }
    },
  }, true);
  return { cards, current, incomplete: depth !== 0 };
}

/** CardOnlyCards: the observed English alert, two matching links and three fields per card. */
function cardOnlyCards(body: string) {
  let section = 0, trDepth = 0, linkDepth = 0, titleRowDepth: number | null = null;
  let stage: "await_title" | "title" | "title_row" | "location" | "company" | "done" | null = null;
  let current: { identity: Identity; Title: string[]; Location: string[]; Company: string[] } | null = null;
  const cards: Card[] = [];
  htmlFeed(body, {
    comment(raw) {
      const marker = pyStrip(raw);
      if (marker === "Job cards") {
        if (section) throw mailParseError("Duplicate Talent card section");
        section = 1;
      } else if (marker === "View more jobs button" && section === 1) {
        if (current !== null || linkDepth || trDepth) throw mailParseError("Incomplete Talent card section");
        section = 2;
      }
    },
    starttag(tag, attrs) {
      if (section !== 1) return;
      if (tag === "tr") trDepth++;
      else if (tag === "a") {
        const identity = canonical(attr(attrs, "href", null));
        if (linkDepth === 0) {
          current = { identity, Title: [], Location: [], Company: [] };
          stage = "await_title";
          linkDepth = 1;
        } else if (linkDepth === 1 && stage === "await_title" && identity[0] === current!.identity[0] && identity[1] === current!.identity[1]) {
          titleRowDepth = trDepth;
          stage = "title";
          linkDepth = 2;
        } else throw mailParseError("Unexpected Talent card link");
      }
    },
    data(value) {
      if (section !== 1 || current === null) return;
      if (stage === "title" && linkDepth === 2) current.Title.push(value);
      else if (linkDepth === 1 && trDepth === titleRowDepth && (stage === "location" || stage === "company")) {
        current[stage === "location" ? "Location" : "Company"].push(value);
      }
    },
    endtag(tag) {
      if (section !== 1) return;
      if (tag === "tr") {
        if (trDepth < 1) throw mailParseError("Unbalanced Talent card rows");
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
          if (!card.Title) throw mailParseError("Empty Talent card title");
          cards.push({ ...card, identity: current!.identity });
          current = null;
          linkDepth = 0;
          titleRowDepth = null;
          stage = null;
        } else throw mailParseError("Incomplete Talent card");
      }
    },
  }, true);
  return { cards, current, incomplete: section !== 2 || linkDepth !== 0 || trDepth !== 0 };
}

export function parseTalent(message: MailMessage): PyDict[] {
  const template = subjectFormat(message.subject);
  if (casefold(message.sender) !== SENDER || !message.isHtml || template === null || Buffer.byteLength(message.body, "utf8") > 1_000_000) {
    throw mailParseError("Unsupported Talent notification");
  }
  const received = receivedAt(message.receivedAt, "Invalid Talent timestamp");
  const parsed = template === "described" ? describedCards(message.body) : cardOnlyCards(message.body);
  if (parsed.incomplete || parsed.current !== null || parsed.cards.length < 1 || parsed.cards.length > 100) throw mailParseError("Incomplete Talent notification");
  const seen = new Set<string>();
  return parsed.cards.map((card) => {
    const [identity, url] = card.identity;
    if (seen.has(identity)) throw mailParseError("Duplicate Talent card");
    seen.add(identity);
    const description = template === "described" ? card.Description!
      : "Talent.com notification card only: " + [card.Title, card.Company, card.Location].filter(Boolean).join("\n");
    const evidence = card.Title + (template === "described" ? "\n" + card.Description : "");
    const kind = FULL_TIME.test(evidence) ? "full_time" : CONTRACT.test(evidence) ? "contract" : null;
    const job = PyDict.of({
      source: "talent", external_id: identity, url, canonical_url: url,
      title: card.Title, company: card.Company || null, location: card.Location || null,
      description, salary_text: card.Salary ?? null, kind,
      complete: false, body_available: false, language: "en",
      taiwan_eligible: null, timezone_compatible: null, weekly_hours: null,
      currency: null, budget_min: null, budget_max: null, deadline: null, published_at: null,
    });
    const out = new PyDict(job);
    out.set("received_at", received.isoformat());
    out.set("receipt_id", "talent:" + identityHash(job));
    return out;
  });
}
