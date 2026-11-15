import { rfc3339Instant } from "@/modules/listings/public";
import { reject } from "./reasons";
import { MAX_BYTES, senderAddress } from "./receiving";

import type { MailMessage } from "../types";

export type { MailMessage };

/**
 * The envelope checks every mail source shares, on a fetched Resend message: the id is the listed one,
 * From is the source's sender, this inbox is a recipient, created_at is an instant with an offset, and
 * subject and body are text within the size cap. The body is the HTML part when there is one, else the
 * text part (`preferText` reads only the text part, for a source whose parser reads text).
 */
export function readMessage(raw: Record<string, unknown>, id: string, sender: string, inbox: string, preferText = false): MailMessage {
  if (raw.id !== id) reject("id_mismatch");
  if (senderAddress(raw.from) !== sender) reject("sender_mismatch");
  const recipients = [...(Array.isArray(raw.received_for) ? raw.received_for : []), ...(Array.isArray(raw.to) ? raw.to : [])];
  if (!recipients.some((r) => typeof r === "string" && r.toLowerCase() === inbox)) reject("recipient_mismatch");
  const created = typeof raw.created_at === "string" ? raw.created_at : "";
  if (!rfc3339Instant.safeParse(created).success) reject("bad_received_at");
  const html = typeof raw.html === "string" && raw.html !== "" ? raw.html : null;
  const body = preferText ? raw.text : html ?? raw.text;
  if (typeof raw.subject !== "string" || typeof body !== "string") reject("missing_subject_or_body");
  if (Buffer.byteLength(body as string, "utf8") > MAX_BYTES) reject("body_too_large");
  return { id, sender, subject: raw.subject as string, body: body as string, isHtml: !preferText && html !== null, receivedAt: new Date(created).toISOString() };
}
