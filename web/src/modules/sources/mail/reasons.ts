// Why a mail message was rejected (plan step 7: one code per check of each parser, stored in
// mail_messages.reason). Codes name the check, never the message's content. A rejection is about ONE
// message: it is recorded and the scan goes on (one message failing never undoes another).

export const ENVELOPE_REASONS = [
  /** The fetched message's id is not the one listed. */
  "id_mismatch",
  /** From is not the source's one sender address. */
  "sender_mismatch",
  /** Neither received_for nor to names this inbox. */
  "recipient_mismatch",
  /** created_at missing, not an instant, or without an offset. */
  "bad_received_at",
  /** Subject or body missing or not text. */
  "missing_subject_or_body",
  /** The message (Resend's whole response, or the body a parser reads) is over the size cap. */
  "body_too_large",
  /** Resend answered for this message with something other than a JSON message object. */
  "unreadable_message",
  /** A listing the parser produced was refused by the listing contract. */
  "contract_refused",
] as const;

export const JOBBANK104_REASONS = [
  /** Not an HTML 104 matching digest (subject, sender or format). */
  "104_unsupported",
  /** An <a> inside an <a>. */
  "104_nested_link",
  /** An href that is not even a relative URL. */
  "104_invalid_link",
  /** A job link not on https://www.104.com.tw or with an empty title. */
  "104_unsupported_job_link",
  /** A job link before the previous card's apply link. */
  "104_incomplete_card",
  /** A card with two company links or an empty company name. */
  "104_ambiguous_company",
  /** No end marker, an open card or link at the end, or a card count different from the subject's. */
  "104_incomplete_digest",
  /** A card without a company or description. */
  "104_invalid_card",
  /** The same job twice in one digest. */
  "104_duplicate_card",
] as const;

export type MailReason = (typeof ENVELOPE_REASONS)[number] | (typeof JOBBANK104_REASONS)[number];

export class MailRejection extends Error {
  constructor(readonly reason: MailReason) {
    super(`mail rejected: ${reason}`);
    this.name = "MailRejection";
  }
}

export const reject = (reason: MailReason): never => {
  throw new MailRejection(reason);
};
