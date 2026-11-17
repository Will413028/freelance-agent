import { ZodError } from "zod";
import { parseListingInput, rfc3339Instant, type ListingInput } from "@/modules/listings/public";
import { reject } from "./reasons";
import { senderAddress } from "./receiving";

import type { MailMessage } from "../types";

export type { MailMessage };

/** The largest body a parser reads; real notifications are well under it (the whole response is capped at MAX_BYTES). */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * The envelope checks every mail source shares, on a fetched Resend message: the id is the listed one,
 * From is the source's sender, this inbox is a recipient, created_at is an instant with an offset, and
 * subject and body are text, and the body is at most MAX_BODY_BYTES. The body is the HTML part when there is one, else the
 * text part (`preferText` reads only the text part, for a source whose parser reads text).
 */
export function readMessage(raw: Record<string, unknown>, id: string, sender: string, inbox: string, preferText = false): MailMessage {
  if (raw.id !== id) reject("id_mismatch");
  if (senderAddress(raw.from) !== sender) reject("sender_mismatch");
  // Both lists must be lists of text (absent means empty), as the old reader required.
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) && v.every((r) => typeof r === "string") ? (v as string[]) : reject("recipient_mismatch"));
  if (![...list(raw.received_for), ...list(raw.to)].some((r) => r.toLowerCase() === inbox)) reject("recipient_mismatch");
  const created = typeof raw.created_at === "string" ? raw.created_at : "";
  if (!rfc3339Instant.safeParse(created).success) reject("bad_received_at");
  const html = typeof raw.html === "string" && raw.html !== "" ? raw.html : null;
  const body = preferText ? raw.text : html ?? raw.text;
  if (typeof raw.subject !== "string" || typeof body !== "string") reject("missing_subject_or_body");
  if (Buffer.byteLength(body as string, "utf8") > MAX_BODY_BYTES) reject("body_too_large");
  return { id, sender, subject: raw.subject as string, body: body as string, isHtml: !preferText && html !== null, receivedAt: new Date(created).toISOString() };
}

/** A listing a parser read, through the listing contract; a refusal rejects the message as contract_refused. */
export function mailListing(input: unknown): ListingInput {
  try {
    return parseListingInput(input);
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    return reject("contract_refused");
  }
}
