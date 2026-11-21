import { z } from "zod";
import { KINDS, type OpportunityType } from "@/db/pg/schema";
import type { Contest, Deadline, Listing } from "@/modules/evaluation/public";

// The listing contract between a connector and intake (plan D8: parse at the boundary, never guess
// after it). Fields follow the parts of schema.org JobPosting the evaluation reads; unknown stays
// null, never false. Times are RFC 3339: a date `YYYY-MM-DD`, an instant always with its offset. A
// connector turns its source's formats into this and writes what it cannot turn as unknown with the
// original text; intake accepts nothing else.

const text = z.string().min(1);
const optionalText = z.string().nullable().default(null);
const amount = z.number().nullable().default(null);
const triState = z.boolean().nullable().default(null);

/** Year 0000 passes ISO syntax but neither Postgres nor the old system holds it. */
const fromYear1 = (t: string) => !t.startsWith("0000");
export const rfc3339Instant = z.iso.datetime({ offset: true }).refine((t) => fromYear1(t) && Number.isFinite(Date.parse(t)), "not a real instant");
const isoDate = z.iso.date().refine(fromYear1, "year 0000");

export const deadlineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), date: isoDate }).strict(),
  z.object({ kind: z.literal("instant"), at: rfc3339Instant }).strict(),
  /** Given but unusable: a local time without a zone, or text that is not a date. `text` is what the source said. */
  z.object({ kind: z.enum(["no_timezone", "invalid"]), text: z.string() }).strict(),
]).nullable().default(null);

/** A job (opportunity types plan D1): today's fields. A connector may leave the type out; it is then a job. */
const jobInputSchema = z.object({
  opportunity_type: z.literal("job").default("job"),
  external_id: text,
  title: text,
  company: optionalText,
  description: optionalText,
  url: optionalText,
  canonical_url: optionalText,
  location: optionalText,
  kind: z.enum(KINDS).nullable().default(null),
  currency: optionalText,
  budget_min: amount,
  budget_max: amount,
  weekly_hours: amount,
  taiwan_eligible: triState,
  timezone_compatible: triState,
  complete: triState,
  listing_closed: triState,
  compensation_evidence: optionalText,
  published_at: rfc3339Instant.nullable().default(null),
  deadline: deadlineSchema,
  /** Source-specific facts kept for audit; they never change the fingerprint or the evaluation. */
  extra: z.record(z.string(), z.unknown()).default({}),
}).strict();

/**
 * A contest (opportunity types plan D5): a competition with a submission deadline and a prize. `deadline`
 * is the submission deadline, `company` the organiser, `budget_*` and `currency` the prize amount when the
 * source gives one as a number, `prize_text` the prize as the source words it. Unknown stays null: no
 * prize given is not a prize of 0, and online never means open to every country.
 */
const contestInputSchema = z.object({
  opportunity_type: z.literal("contest"),
  external_id: text,
  title: text,
  company: optionalText,
  description: optionalText,
  url: optionalText,
  canonical_url: optionalText,
  location: optionalText,
  currency: optionalText,
  budget_min: amount,
  budget_max: amount,
  prize_text: optionalText,
  online: triState,
  invite_only: triState,
  /** A hackathon is a contest with this flag (plan D5). */
  hackathon: triState,
  listing_closed: triState,
  published_at: rfc3339Instant.nullable().default(null),
  deadline: deadlineSchema,
  registration_deadline: isoDate.nullable().default(null),
  extra: z.record(z.string(), z.unknown()).default({}),
}).strict();

/**
 * The contract, one variant per opportunity type (opportunity types plan D1). Every raw stored before
 * opportunity types has no `opportunity_type`; the union applies the job variant's default to a missing
 * discriminator, so those raws parse as jobs (reevaluate.test.ts checks it). Only one variant may default.
 */
export const listingInputSchema = z.discriminatedUnion("opportunity_type", [jobInputSchema, contestInputSchema]);

/** A listing of any type as a connector gives it, after parsing: every field present, unknown as null. */
export type ListingInput = z.output<typeof listingInputSchema>;
export type JobInput = z.output<typeof jobInputSchema>;
export type ContestInput = z.output<typeof contestInputSchema>;
/** What a job connector may write: optional fields (the type included) can be left out. */
export type JobInputDraft = z.input<typeof jobInputSchema>;
export type { OpportunityType };

/**
 * The contract with an empty title allowed, for the frozen evaluate and recommendation fixtures only:
 * their inputs came from old-system jobs (some with empty titles) through legacyToInput, deleted in
 * step 5a2 (plan D10). Nothing stores through it; delete it with those fixtures.
 */
export const legacyListingInputSchema = jobInputSchema.extend({ title: z.string() });

/** Parses a connector's listing of any type; throws a ZodError naming each field it refuses. */
export const parseListingInput = (value: unknown): ListingInput => listingInputSchema.parse(value);
/** Parses a job connector's listing: the job variant only, the type left out or `job`. */
export const parseJobInput = (value: unknown): JobInput => jobInputSchema.parse(value);
/** Parses a contest connector's listing. */
export const parseContestInput = (value: unknown): ContestInput => contestInputSchema.parse(value);

type DeadlineColumns = { deadlineKind: ListingInput["deadline"] extends infer D ? (D extends { kind: infer K } ? K : never) | null : never; deadlineText: string | null };

/** A contract deadline as stored: its kind and what the source said (deadline_at is the evaluation fact). */
export function deadlineColumns(d: ListingInput["deadline"]): DeadlineColumns {
  return { deadlineKind: d?.kind ?? null, deadlineText: d === null ? null : d.kind === "date" ? d.date : d.kind === "instant" ? d.at : d.text };
}

/** A stored deadline back to evaluation's form; deadline_at is the instant of an instant deadline. */
export function deadlineOfColumns(kind: string | null, text: string | null, at: Date | null): Deadline {
  if (kind === null) return null;
  if (kind === "date") return { kind: "date", date: text! };
  if (kind === "instant") return { kind: "instant", at: at! };
  return { kind: kind as "no_timezone" | "invalid", text: text! };
}

const deadlineOf = (d: ListingInput["deadline"]): Deadline => (d === null ? null : d.kind === "date" ? d : d.kind === "instant" ? { kind: "instant", at: new Date(d.at) } : d);

/** The typed contest its evaluation reads. */
export function contestOf(input: ContestInput): Contest {
  return { listingClosed: input.listing_closed, publishedAt: input.published_at === null ? null : new Date(input.published_at), deadline: deadlineOf(input.deadline) };
}

/** The typed job listing evaluation reads. */
export function listingOf(input: JobInput): Listing {
  return {
    title: input.title, description: input.description, kind: input.kind, currency: input.currency,
    budgetMin: input.budget_min, budgetMax: input.budget_max, weeklyHours: input.weekly_hours,
    taiwanEligible: input.taiwan_eligible, timezoneCompatible: input.timezone_compatible, complete: input.complete,
    listingClosed: input.listing_closed, compensationEvidence: input.compensation_evidence,
    publishedAt: input.published_at === null ? null : new Date(input.published_at),
    deadline: deadlineOf(input.deadline),
  };
}
