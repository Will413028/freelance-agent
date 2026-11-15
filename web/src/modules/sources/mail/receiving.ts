import { z } from "zod";
import type { Fetcher } from "@/platform/fetch";
import { SourceError } from "../types";

// Bounded reads of Resend Receiving (old web/src/modules/collection/mail/receiving.ts until step 11).
// The key is full_access (Resend has no read-only scope, plan D14), so every request is a GET (the
// Fetcher sends nothing else) under https://api.resend.com/emails/receiving, checked before it leaves
// the process. Resend's list and retrieve responses carry no read or processed state (API reference,
// checked 2026-11-15), so reading changes nothing for the frozen production system reading the same inbox.
// A message body is fetched only when the list just showed it from the source's sender.

export const ROOT = "https://api.resend.com/emails/receiving";
export const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const KEY = /^re_[A-Za-z0-9_-]{5,500}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** RESEND_INBOX: an address of a Resend receiving domain. */
const INBOX = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.resend\.app$/;

/** A Resend id: the lowercase hyphenated UUID form only. */
export function resendId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new SourceError("invalid Resend id");
  return value;
}

/** The inbox address, lower case; refuses anything but a single *.resend.app address. */
export function inboxAddress(value: string): string {
  if (!INBOX.test(value)) throw new SourceError("RESEND_INBOX is not a Resend receiving address");
  return value.toLowerCase();
}

/**
 * The one address of a single-line From value (`addr` or `Name <addr>`), lower case, or null when the
 * value is not text, spans lines, or names no address or more than one.
 */
export function senderAddress(value: unknown): string | null {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return null;
  const angle = /^[^<>]*<([^<>]+)>\s*$/.exec(value);
  const address = (angle ? angle[1] : value).trim();
  if (!/^[^\s@,<>"]+@[^\s@,<>"]+$/.test(address)) return null;
  return address.toLowerCase();
}

/** Refuses any URL but https://api.resend.com/emails/receiving[/…] without credentials or port. */
export function assertReceivingUrl(url: string): void {
  const u = URL.canParse(url) ? new URL(url) : null;
  if (!u || u.protocol !== "https:" || u.host !== "api.resend.com" || u.username || u.password
      || !(u.pathname === "/emails/receiving" || u.pathname.startsWith("/emails/receiving/"))) throw new SourceError("refused Resend request");
}

const entrySchema = z.object({ id: z.string(), from: z.unknown(), subject: z.unknown() }).loose();
const listSchema = z.object({ data: z.array(entrySchema).max(100), has_more: z.boolean() }).loose();
const messageSchema = z.record(z.string(), z.unknown());

export type ListEntry = { id: string; sender: string | null; subject: string };
export type ListPage = { entries: ListEntry[]; hasMore: boolean };

export class ReceivingClient {
  private readonly listed = new Set<string>();

  constructor(private readonly fetcher: Fetcher, private readonly key: string, private readonly sender: string) {
    if (!KEY.test(key)) throw new SourceError("RESEND_API_KEY is not a Resend key");
  }

  private async get(suffix: string): Promise<unknown> {
    const url = ROOT + suffix;
    assertReceivingUrl(url);
    const response = await this.fetcher.get({ url, headers: { Authorization: `Bearer ${this.key}`, Accept: "application/json" }, maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS });
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    } catch {
      throw new SourceError("Resend answered with something other than JSON");
    }
    if (data === null || typeof data !== "object" || Array.isArray(data) || "error" in data) throw new SourceError("Resend answered with an error object");
    return data;
  }

  /** One list page, newest first; `after` continues past that id. */
  async list(after: string | null): Promise<ListPage> {
    const parsed = listSchema.safeParse(await this.get(`?limit=100${after === null ? "" : `&after=${resendId(after)}`}`));
    if (!parsed.success) throw new SourceError("invalid Resend list");
    this.listed.clear();
    const entries = parsed.data.data.map((e) => ({ id: resendId(e.id), sender: senderAddress(e.from), subject: typeof e.subject === "string" ? e.subject : "" }));
    for (const e of entries) if (e.sender === this.sender) this.listed.add(e.id);
    return { entries, hasMore: parsed.data.has_more };
  }

  /** One message the last list showed from this source's sender; anything else is refused before a request. */
  async message(id: string): Promise<Record<string, unknown>> {
    if (!this.listed.has(resendId(id))) throw new SourceError("message not listed from the source's sender");
    const parsed = messageSchema.safeParse(await this.get(`/${id}?html_format=cid`));
    if (!parsed.success) throw new SourceError("invalid Resend message");
    return parsed.data;
  }
}
