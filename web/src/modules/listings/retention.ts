import { and, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingFeedback, listings } from "@/db/pg/schema";

// Retention (plan step 5a2-3). Intake stores every listing read (plan D9), so the table grows by what the
// sources publish; a listing no read has shown for RETENTION_DAYS is deleted. The clock is last_seen_at, not
// gone_at: few sources' reads are complete (arbeitnow stops at its page cap; the contest sources' reads
// are: devpost, mlcontests, zindi; see `completeRead` in the source catalog), and one complete read can
// miss a listing that shifted between pages, so only a long run of absences counts. A listing with any
// feedback row stays: the person's saved and skipped lists never lose an entry. Versions and feedback
// events cascade with the listing. The operation derives everything from the table, so a rerun or an
// interrupted run is safe; the daily run (plan step 6) calls it after intake, naming the sources that had a
// successful read within the window: a source broken or disabled for N days keeps its listings, so they do
// not all vanish and come back later as new ones.

/** Days without a sighting before a listing is deleted. */
export const RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Deletes the listings of `sources` last seen more than `days` before `now` that carry no feedback; returns
 * how many. `sources` are the ones read successfully within those days (the caller knows the runs).
 */
export async function pruneListings(db: PgDb, sources: readonly string[], now = new Date(), days = RETENTION_DAYS): Promise<number> {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError(`days must be a whole number from 1, not ${days}`);
  if (sources.length === 0) return 0;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  // The candidates are locked first and skipped when locked: setFeedback holds the listing row FOR UPDATE
  // while it writes feedback, and a DELETE that waited on that lock would not recheck NOT EXISTS (the row
  // was only locked, not updated) and would delete the new save. A skipped row goes on a later run.
  const doomed = db.select({ id: listings.id }).from(listings).where(and(
    inArray(listings.source, [...sources]),
    lt(listings.lastSeenAt, cutoff),
    notExists(db.select({ one: sql`1` }).from(listingFeedback).where(eq(listingFeedback.listingId, listings.id))),
  )).for("update", { skipLocked: true });
  const gone = await db.delete(listings).where(inArray(listings.id, doomed)).returning({ id: listings.id });
  return gone.length;
}
