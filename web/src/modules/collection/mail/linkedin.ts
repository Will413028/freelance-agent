import { fromisoformat } from "@/platform/py/datetime";
import { asciiHash } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { casefold, pyLen, pySplitlines, pyStrip } from "@/platform/py/unicode";
import { urlsplit } from "@/platform/py/url";
import { pyEq, PyDict, PyError } from "@/platform/py/value";
import type { MailMessage } from "./message";

// Port of collection/linkedin_mail.py: observed English LinkedIn job-alert text bodies. Only card
// metadata is available; callers must not treat these cards as full listings.

const SENDER = "jobalerts-noreply@linkedin.com";
const fail = (message: string) => new PyError("MailParseError", message);

export const isAdministrativeNotice = (subject: string) => pyFullmatch("We[‘’']ve turned off your job alert for .{1,500}", subject) !== null;

function canonical(value: string): [string, string] {
  try {
    const url = urlsplit(value);
    const match = pyFullmatch("/(?:comm/)?jobs/view/([0-9]{1,20})/?", url.path);
    if (url.scheme !== "https" || url.netloc !== "www.linkedin.com" || !match) throw new PyError("ValueError", "");
    return [match[1], "https://www.linkedin.com/jobs/view/" + match[1] + "/"];
  } catch (e) {
    if (e instanceof PyError && e.pyType === "ValueError") throw fail("Unsupported LinkedIn job URL");
    throw e;
  }
}

const ALERT = "(?:New|[1-9][0-9]{0,3} new) jobs match your preferences\\.|A new job matches your preferences\\.";
const FULL_TIME = pyRe("\\bfull[ -]time\\b", true);
const CONTRACT = pyRe("\\b(?:freelance|part[ -]time|contract)\\b", true);
const REMOTE = pyRe("\\bremote\\b", true);
const UNPAID = pyRe("\\b(?:unpaid|equity only)\\b", true);

export function parseLinkedin(message: MailMessage): PyDict[] {
  if (casefold(message.sender) !== SENDER || message.isHtml) throw fail("Expected LinkedIn text notification");
  const body = message.body;
  if (Buffer.byteLength(body, "utf8") > 1_000_000) throw fail("Invalid LinkedIn notification size");
  let received;
  try {
    received = fromisoformat(message.receivedAt.replaceAll("Z", "+00:00"));
    if (received.offset === null) throw new PyError("ValueError", "");
  } catch (e) {
    if (e instanceof PyError && e.pyType === "ValueError") throw fail("Invalid LinkedIn received timestamp");
    throw e;
  }
  const lines = pySplitlines(body).map(pyStrip).filter(Boolean);
  if (lines.length < 2 || !lines[0].startsWith("Your job alert for ") || !pyFullmatch(ALERT, lines[1])) {
    throw fail("Unsupported LinkedIn notification template");
  }
  let start = 2;
  if (lines.length > 2 && lines[2].startsWith("Manage alerts: ")) {
    const value = lines[2].slice("Manage alerts: ".length);
    const url = urlsplit(value);
    if (pyLen(value) > 8192 || url.scheme !== "https" || url.netloc !== "www.linkedin.com" || url.path !== "/comm/jobs/alerts" || url.fragment) {
      throw fail("Unsupported LinkedIn management URL");
    }
    start = 3;
  }
  const jobs = new Map<string, PyDict>();
  let card: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.startsWith("See all jobs on LinkedIn:")) break;
    if (/^-{10,}$/.test(line)) {
      if (card.length) throw fail("Incomplete LinkedIn job card");
      continue;
    }
    if (!line.startsWith("View job: ")) {
      if (line.startsWith("Manage alerts: ")) throw fail("Unexpected LinkedIn management URL");
      card.push(line);
      continue;
    }
    if (!(card.length >= 3 && card.length <= 10) || card.some((v) => pyLen(v) > 500 || v.includes("https://"))) throw fail("Unsupported LinkedIn job card");
    const [externalId, url] = canonical(pyStrip(line.slice("View job: ".length)));
    const [title, company, location] = card;
    const kind = FULL_TIME.test(title) ? "full_time" : CONTRACT.test(title) ? "contract" : null;
    const job = PyDict.of({
      source: "linkedin", external_id: externalId, url, canonical_url: url,
      title, company, location_evidence: location,
      description: "LinkedIn notification card only: " + title + "\n" + company + "\n" + location,
      kind, remote_evidence: REMOTE.test(title + " " + location),
      taiwan_eligible: null, timezone_compatible: null, weekly_hours: null,
      budget_min: null, budget_max: null, currency: null, deadline: null,
      published_at: null, complete: false, body_available: false, language: "en",
      compensation_evidence: UNPAID.test(title) ? "unpaid_or_equity_only" : null,
    });
    const known = jobs.get(externalId);
    if (known !== undefined && !pyEq(known, job)) throw fail("Conflicting LinkedIn job cards");
    jobs.set(externalId, job);
    card = [];
  }
  if (card.length || !jobs.size) throw fail("Missing or incomplete LinkedIn job cards");
  return [...jobs.values()].map((job) => {
    const out = new PyDict(job);
    out.set("received_at", received.isoformat());
    out.set("receipt_id", "linkedin:" + asciiHash(job));
    return out;
  });
}
