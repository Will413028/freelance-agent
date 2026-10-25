import { qualify, DEFAULT_HOURS } from "@/modules/discovery/public";
import { urlopenRead, loadsBytes } from "@/platform/http";
import { getaddresses } from "@/platform/py/email";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { pyFullmatch } from "@/platform/py/re";
import { casefold, pyStr } from "@/platform/py/unicode";
import { isDict, isList, pyEq, pyGet, pySubscript, PyDict, PyError, truthy, type PyValue } from "@/platform/py/value";
import { parseLinkedin, isAdministrativeNotice } from "./linkedin";
import { parseTasker } from "./tasker";

// Port of collection/resend_preview.py: bounded reads of Resend Receiving. GET only, so a shadow run
// never changes anything on the Resend side; no DB, sending or attachments here.

export const MAX_BYTES = 2 * 1024 * 1024;
const ROOT = "https://api.resend.com/emails/receiving";
export const SENDERS: Record<string, string> = {
  tasker: "deals@tasker.com.tw", linkedin: "jobalerts-noreply@linkedin.com", cake: "notifications@no-reply.cake.me",
  jobbank104: "jobbank@ms1.104.com.tw", talent: "no-reply@alerts.talent.com", glassdoor: "noreply@glassdoor.com",
  indeed: "donotreply@jobalert.indeed.com",
};

export class ResendError extends PyError {
  constructor(message: string) {
    super("ResendError", message);
  }
}

const KEY = /^re_[A-Za-z0-9_-]{5,500}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * _id: str(UUID(value)) == value, which only the lowercase hyphenated form passes. Python raises
 * ValueError or ResendError depending on how a value fails; every caller treats both as one failure.
 */
export function resendId(value: PyValue | undefined): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ResendError("Invalid Resend identifier");
  return value;
}

/** _sender: the one address of a single-line From value, casefolded, or null. */
export function sender(value: PyValue | undefined): string | null {
  if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) return null;
  const addresses = getaddresses([value]);
  return addresses.length === 1 ? casefold(addresses[0][1]) : null;
}

/** One GET: status and body, as urllib's opener with NoRedirect returns or raises them. */
export type Request = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: Uint8Array }>;
// timeout=20 bounds the connect and each read, not the whole read; past MAX_BYTES the read fails.
const httpRequest: Request = (url, headers) => urlopenRead(url, headers, MAX_BYTES, 20_000, 20_000, Infinity);
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

export class ReceivingClient {
  private readonly senders: Set<string>;
  private readonly allowed = new Set<string>();
  private requested = false;

  constructor(private readonly key: string, private readonly opts: { request?: Request; pause?: (s: number) => Promise<void>; sources?: string[] } = {}) {
    if (typeof key !== "string" || !KEY.test(key)) throw new ResendError("Invalid Resend key");
    const sources = opts.sources ?? ["tasker"];
    if (!sources.length || sources.some((s) => !(s in SENDERS))) throw new ResendError("Unsupported receiving source");
    this.senders = new Set(sources.map((s) => SENDERS[s]));
  }

  private async get(suffix: string): Promise<PyDict> {
    try {
      if (this.requested) await (this.opts.pause ?? sleep)(0.6);
      this.requested = true;
      const response = await (this.opts.request ?? httpRequest)(ROOT + suffix, {
        Authorization: "Bearer " + this.key, Accept: "application/json", "User-Agent": "freelance-agent/0.1",
      });
      if (response.status !== 200 || response.body.length > MAX_BYTES) throw new Error();
      const data = loadsBytes(response.body);
      if (!isDict(data) || data.has("error")) throw new Error();
      return data;
    } catch {
      throw new ResendError("Resend read failed");
    }
  }

  async listReceived(after: string | null = null): Promise<PyDict> {
    const data = await this.get("?limit=100" + (after !== null ? "&after=" + resendId(after) : ""));
    const entries = data.get("data");
    if (!isList(entries) || entries.length > 100 || typeof data.get("has_more") !== "boolean") throw new ResendError("Invalid Resend list");
    this.allowed.clear();
    for (const entry of entries) {
      if (!isDict(entry)) throw new ResendError("Invalid Resend list");
      const mid = resendId(entry.get("id"));
      const from = sender(entry.get("from"));
      if (from !== null && this.senders.has(from)) this.allowed.add(mid);
    }
    return data;
  }

  getReceived(mid: string, retrySource: string | null = null): Promise<PyDict> {
    if (retrySource !== null) {
      if (!(retrySource in SENDERS) || !this.senders.has(SENDERS[retrySource])) throw new ResendError("Retry source is not enabled");
    } else if (!this.allowed.has(mid)) throw new ResendError("Message not listed as an enabled source");
    return this.get("/" + resendId(mid) + "?html_format=cid");
  }
}

/** Subject gates beyond the sender, per source; sources whose parser is not ported have none yet. */
const SUBJECT_GATES: Record<string, (subject: string) => boolean> = {
  tasker: () => true,
  linkedin: (subject) => !casefold(subject).includes("has been created"),
  jobbank104: (subject) => pyFullmatch(".{1,100}\\d{2}/\\d{2}的配對日報，符合職缺\\d{1,3}筆", subject) !== null,
  cake: (subject) => subject.includes("刊登了一筆新職缺"),
};

export function matches(entry: PyDict, source: string): boolean {
  const gate = SUBJECT_GATES[source];
  if (!gate) throw new PyError("ValueError", "Receiving source not ported");
  return sender(entry.get("from")) === SENDERS[source] && gate(pyStr(pyGet(entry, "subject", "")));
}

export type { MailMessage } from "./message";
import type { MailMessage } from "./message";

export class NotificationError extends PyError {
  constructor(readonly stage: "fetch" | "metadata" | "template") {
    super("NotificationError", "Notification unavailable or unsupported");
  }
}

const PARSERS: Record<string, (message: MailMessage) => PyDict[]> = { tasker: parseTasker, linkedin: parseLinkedin };

/** True when str.encode() (strict UTF-8) of s would exceed `limit` bytes; lone surrogates throw like UnicodeEncodeError. */
export function utf8Length(s: string): number {
  if (!s.isWellFormed()) throw new PyError("UnicodeEncodeError", "surrogates not allowed");
  return Buffer.byteLength(s, "utf8");
}

/** Read one allowlisted message; callers own paging, persistence and recovery. */
export async function readNotification(client: ReceivingClient, mid: string, recipient: string, source: string, retry = false, now = PyDateTime.now()): Promise<PyDict[]> {
  let stage: NotificationError["stage"] = "fetch";
  try {
    const mail = retry ? await client.getReceived(mid, source) : await client.getReceived(mid);
    stage = "metadata";
    const recipients = pyGet(mail, "received_for", []), to = pyGet(mail, "to", []);
    if (!pyEq(pyGet(mail, "id"), mid) || sender(mail.get("from")) !== SENDERS[source] || !isList(recipients) || !isList(to)
        || [...recipients, ...to].some((x) => typeof x !== "string")
        || !(([...recipients, ...to] as string[]).map(casefold).includes(casefold(recipient)))) throw new Error();
    const created = pySubscript(mail, "created_at");
    if (typeof created !== "string") throw new Error();
    const timestamp = fromisoformat(created.replaceAll("Z", "+00:00"));
    if (timestamp.offset === null) throw new Error();
    const subject = pySubscript(mail, "subject");
    const body = source === "linkedin" ? pyGet(mail, "text") : truthy(pyGet(mail, "html")) ? pyGet(mail, "html") : pyGet(mail, "text");
    if (typeof subject !== "string" || typeof body !== "string" || utf8Length(body) > MAX_BYTES) throw new Error();
    const message: MailMessage = {
      messageId: "resend:" + mid, sender: SENDERS[source], subject, body,
      isHtml: source !== "linkedin" && truthy(pyGet(mail, "html")), receivedAt: timestamp.isoformat(),
    };
    stage = "template";
    if (source === "linkedin" && isAdministrativeNotice(subject)) return [];
    const parse = PARSERS[source];
    if (!parse) throw new Error();
    const jobs = parse(message);
    // Only the jobs travel on; qualify still runs, because an exception in it rejects the message.
    for (const job of jobs) qualify(job, DEFAULT_HOURS, now, 3000n);
    return jobs;
  } catch {
    throw new NotificationError(stage);
  }
}
