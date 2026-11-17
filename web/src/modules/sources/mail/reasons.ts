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
  /** The body's HTML is nested deeper than any real notification (html.ts MAX_DEPTH). */
  "html_too_deep",
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

export const TASKER_REASONS = [
  /** Not from Tasker's notification sender. */
  "tasker_unsupported",
  /** Not exactly one 「查看完整資訊」 link (or text line) to a case page. */
  "tasker_boundary",
  /** Links to more than one case page, or none. */
  "tasker_case_link",
  /** The subject does not name exactly one 【title】. */
  "tasker_subject",
  /** The header line, the title, the amount or 「預算詳談」, or the 「需求說明」 text is missing. */
  "tasker_body",
] as const;

export const CAKE_REASONS = [
  /** Not an HTML notification from Cake's sender. */
  "cake_unsupported",
  /** The subject is not 「您追蹤的 <company> 刊登了一筆新職缺 - <title>」. */
  "cake_subject",
  /** An <a> inside an <a>. */
  "cake_nested_link",
  /** A 「了解詳情」 link that is not a Cake job page, directly or through Cake's tracker. */
  "cake_job_link",
  /** No 「了解詳情」 link, or links to more than one job. */
  "cake_job_link_count",
] as const;

export const TALENT_REASONS = [
  /** Not an HTML alert from Talent.com's sender with a known subject. */
  "talent_unsupported",
  /** A card link that is not https://tw.talent.com/redirect with one 12-hex id. */
  "talent_job_link",
  /** A card starting where it cannot (inside another, outside its link, a second card section). */
  "talent_card_boundary",
  /** Card fields missing or out of order. */
  "talent_field_order",
  /** A job link where the template has none, or a second one. */
  "talent_card_link",
  /** A card closed before all its fields or links. */
  "talent_incomplete_card",
  /** A card without a title, location, company or description the template requires. */
  "talent_empty_card",
  /** No cards, more than 100, an open card at the end, or no end marker. */
  "talent_incomplete_alert",
  /** The same job twice in one alert. */
  "talent_duplicate_card",
  /** A link (or, in the card-only section, a row) the body never closed. */
  "talent_unbalanced",
] as const;

export const GLASSDOOR_REASONS = [
  /** Not an HTML alert from Glassdoor's sender with a known subject. */
  "glassdoor_unsupported",
  /** A link inside a listing link. */
  "glassdoor_nested_link",
  /** A jobListing link that is not https://www.glassdoor.com/partner/jobListing.htm with one 10–20 digit id. */
  "glassdoor_listing_link",
  /** Script, style or loose text inside a card. */
  "glassdoor_card_content",
  /** A card without its company, title or age, with an unexpected middle paragraph, or with an element the body never closed. */
  "glassdoor_incomplete_card",
  /** No cards, or more than 100. */
  "glassdoor_incomplete_alert",
  /** The same listing twice in one alert. */
  "glassdoor_duplicate_card",
] as const;

export const LINKEDIN_REASONS = [
  /** Not a text alert from LinkedIn's job alert sender. */
  "linkedin_unsupported",
  /** The first two lines are not 「Your job alert for …」 and the matching-jobs line. */
  "linkedin_template",
  /** A 「Manage alerts:」 line that is not LinkedIn's alert page, or one inside the cards. */
  "linkedin_manage_link",
  /** A card of fewer than 3 or more than 10 lines, a line over 500 characters, or a link in a card line. */
  "linkedin_card",
  /** A 「View job:」 url that is not https://www.linkedin.com/(comm/)jobs/view/<id>/. */
  "linkedin_job_link",
  /** A card left open at a separator or at the end, or no card at all. */
  "linkedin_incomplete_card",
  /** The same job twice with different content. */
  "linkedin_conflicting_cards",
] as const;

export type MailReason = (typeof ENVELOPE_REASONS)[number] | (typeof JOBBANK104_REASONS)[number] | (typeof TASKER_REASONS)[number] | (typeof CAKE_REASONS)[number] | (typeof TALENT_REASONS)[number] | (typeof GLASSDOOR_REASONS)[number] | (typeof LINKEDIN_REASONS)[number];

export class MailRejection extends Error {
  constructor(readonly reason: MailReason) {
    super(`mail rejected: ${reason}`);
    this.name = "MailRejection";
  }
}

export const reject = (reason: MailReason): never => {
  throw new MailRejection(reason);
};
