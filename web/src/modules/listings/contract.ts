import { z } from "zod";
import { KINDS, type OpportunityType } from "@/db/pg/schema";
import type { Deadline, Listing } from "@/modules/evaluation/public";

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
 * The contract, one variant per opportunity type (opportunity types plan D1). Every raw stored before
 * opportunity types has no `opportunity_type`; the union applies the job variant's default to a missing
 * discriminator, so those raws parse as jobs (reevaluate.test.ts checks it). Only one variant may default.
 */
export const listingInputSchema = z.discriminatedUnion("opportunity_type", [jobInputSchema]);

/** A listing as a connector gives it, after parsing: every field present, unknown as null. */
export type ListingInput = z.output<typeof jobInputSchema>;
/** What a connector may write: optional fields (the type included) can be left out. */
export type ListingInputDraft = z.input<typeof jobInputSchema>;
export type { OpportunityType };

/**
 * The contract with an empty title allowed, for the frozen evaluate and recommendation fixtures only:
 * their inputs came from old-system jobs (some with empty titles) through legacyToInput, deleted in
 * step 5a2 (plan D10). Nothing stores through it; delete it with those fixtures.
 */
export const legacyListingInputSchema = jobInputSchema.extend({ title: z.string() });

/** Parses a connector's listing; throws a ZodError naming each field it refuses. */
export const parseListingInput = (value: unknown): ListingInput => listingInputSchema.parse(value);

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

/** The typed listing evaluation reads. */
export function listingOf(input: ListingInput): Listing {
  const d = input.deadline;
  return {
    title: input.title, description: input.description, kind: input.kind, currency: input.currency,
    budgetMin: input.budget_min, budgetMax: input.budget_max, weeklyHours: input.weekly_hours,
    taiwanEligible: input.taiwan_eligible, timezoneCompatible: input.timezone_compatible, complete: input.complete,
    listingClosed: input.listing_closed, compensationEvidence: input.compensation_evidence,
    publishedAt: input.published_at === null ? null : new Date(input.published_at),
    deadline: d === null ? null : d.kind === "date" ? d : d.kind === "instant" ? { kind: "instant", at: new Date(d.at) } : d,
  };
}
