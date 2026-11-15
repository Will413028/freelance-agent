import type { KINDS } from "@/db/pg/schema";
import { taipeiDayAfter } from "./time";

// What evaluation reads of one listing content (plan D8): typed fields only, unknown kept as null.
// modules/listings parses a source's ListingInput into it, and a stored row maps back to it; nothing
// here looks at raw JSON or at which source a listing came from.

export type Kind = (typeof KINDS)[number];

/** A deadline: a calendar date, an instant, or given but unusable (no time zone, not a date); null when none was given. */
export type Deadline =
  | { kind: "date"; date: string }
  | { kind: "instant"; at: Date }
  | { kind: "no_timezone" | "invalid"; text: string }
  | null;

export type Listing = {
  title: string;
  description: string | null;
  kind: Kind | null;
  currency: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  weeklyHours: number | null;
  taiwanEligible: boolean | null;
  timezoneCompatible: boolean | null;
  complete: boolean | null;
  listingClosed: boolean | null;
  compensationEvidence: string | null;
  publishedAt: Date | null;
  deadline: Deadline;
};

/** When the deadline expires the listing: a date at the next Asia/Taipei midnight (D7), an instant at itself; null when unusable or absent. */
export function deadlineAt(deadline: Deadline): Date | null {
  if (deadline?.kind === "date") return taipeiDayAfter(deadline.date);
  if (deadline?.kind === "instant") return deadline.at;
  return null;
}
