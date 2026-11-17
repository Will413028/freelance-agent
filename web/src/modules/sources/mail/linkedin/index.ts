import type { ListingInput } from "@/modules/listings/public";
import { jobKind, wordsIgnoreCase } from "../kind";
import { mailListing, type MailMessage } from "../message";
import { reject } from "../reasons";
import type { MailSourceSettings } from "../../types";

// LinkedIn: the English job alert's text part, read as observed (old collection/linkedin_mail.py,
// web/src/modules/collection/mail/linkedin.ts at ce1254d). The alert names itself on its first two lines,
// then lists cards: three to ten lines (title, company, location, then whatever LinkedIn adds) closed by
// 「View job: <url>」, until 「See all jobs on LinkedIn:」. Only card metadata is there (complete false).
// The settings read the text part (preferText), never the HTML. external_id is the numeric id of
// https://www.linkedin.com/jobs/view/<id>/ (the /comm/ form too), read with the standard URL parser.

export const SENDER = "jobalerts-noreply@linkedin.com";
const ALERT = /^(?:(?:New|[1-9][0-9]{0,3} new) jobs match your preferences\.|A new job matches your preferences\.)$/u;
// English only, as the old LinkedIn parser had it (no 全職: the alerts are English).
const FULL_TIME = wordsIgnoreCase(String.raw`\bfull[ -]time\b`);
const CONTRACT = wordsIgnoreCase(String.raw`\b(?:freelance|part[ -]time|contract)\b`);
const REMOTE = wordsIgnoreCase(String.raw`\bremote\b`);
const UNPAID = wordsIgnoreCase(String.raw`\b(?:unpaid|equity only)\b`);
// Python's str.splitlines() boundaries.
const LINE_BREAK = new RegExp(String.raw`\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]`, "u");

// Python's str.strip() whitespace: JavaScript's trim() also strips U+FEFF and keeps \x1c–\x1f.
const PY_SPACE = String.raw`[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "gu");
const pyStrip = (s: string) => s.replace(PY_STRIP, "");

/** The listing gate: everything but the 「…has been created」 confirmation is read. */
export const isAlertSubject = (subject: string) => !subject.toLowerCase().includes("has been created");

/** A notice that a job alert was turned off: no cards, and no rejection either. */
export const isAdministrativeNotice = (subject: string) => /^We[‘’']ve turned off your job alert for [^\n]{1,500}$/u.test(subject);

/** The job a 「View job:」 url names: https://www.linkedin.com/(comm/)jobs/view/<id>/, or null. */
export function jobOf(href: string): [id: string, url: string] | null {
  // The standard parser would resolve dot segments and backslashes into another job's path; the old
  // parser refused them, and so does this one (a changed template is rejected mail, not another id).
  if (href.length > 8192 || /\\|\/\.\.?(?:[/?#]|$)/u.test(href) || !URL.canParse(href)) return null;
  const u = new URL(href);
  const job = /^\/(?:comm\/)?jobs\/view\/([0-9]{1,20})\/?$/.exec(u.pathname);
  if (u.protocol !== "https:" || u.host !== "www.linkedin.com" || u.username || u.password || !job) return null;
  return [job[1], `https://www.linkedin.com/jobs/view/${job[1]}/`];
}

const manageAlerts = (value: string) => {
  if (value.length > 8192 || !URL.canParse(value)) return false;
  const u = new URL(value);
  return u.protocol === "https:" && u.host === "www.linkedin.com" && u.pathname === "/comm/jobs/alerts" && !u.hash;
};

/** The listings of one alert ([] for a turned-off-alert notice), or a MailRejection naming the check that failed. */
export function parseLinkedin(message: MailMessage): ListingInput[] {
  if (message.sender !== SENDER) reject("linkedin_unsupported");
  if (isAdministrativeNotice(message.subject)) return [];
  if (message.isHtml) reject("linkedin_unsupported");
  const lines = message.body.split(LINE_BREAK).map(pyStrip).filter(Boolean);
  if (lines.length < 2 || !lines[0].startsWith("Your job alert for ") || !ALERT.test(lines[1])) reject("linkedin_template");
  let start = 2;
  if (lines.length > 2 && lines[2].startsWith("Manage alerts: ")) {
    if (!manageAlerts(lines[2].slice("Manage alerts: ".length))) reject("linkedin_manage_link");
    start = 3;
  }
  const jobs = new Map<string, ListingInput>();
  let card: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.startsWith("See all jobs on LinkedIn:")) break;
    if (/^-{10,}$/.test(line)) {
      if (card.length) reject("linkedin_incomplete_card");
      continue;
    }
    if (!line.startsWith("View job: ")) {
      if (line.startsWith("Manage alerts: ")) reject("linkedin_manage_link");
      card.push(line);
      continue;
    }
    if (card.length < 3 || card.length > 10 || card.some((v) => [...v].length > 500 || v.includes("https://"))) reject("linkedin_card");
    const [id, url] = jobOf(pyStrip(line.slice("View job: ".length))) ?? reject("linkedin_job_link");
    const [title, company, location] = card;
    const listing = mailListing({
      external_id: id, title, company, location, url, canonical_url: url,
      description: `LinkedIn notification card only: ${title}\n${company}\n${location}`, complete: false,
      kind: jobKind(title, CONTRACT, FULL_TIME),
      compensation_evidence: UNPAID.test(title) ? "unpaid_or_equity_only" : null,
      extra: { language: "en", remote_evidence: REMOTE.test(`${title} ${location}`) },
    });
    const known = jobs.get(id);
    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(listing)) reject("linkedin_conflicting_cards");
    jobs.set(id, listing);
    card = [];
  }
  if (card.length || !jobs.size) reject("linkedin_incomplete_card");
  return [...jobs.values()];
}

export const LINKEDIN_SETTINGS: Omit<MailSourceSettings, "order"> = {
  kind: "mail", name: "linkedin", label: "LinkedIn", sender: SENDER, subjectGate: isAlertSubject, parse: parseLinkedin, preferText: true,
  // One page of the inbox list per request; bodies only for new alerts.
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 60, completeRead: false, disabled: null,
};
