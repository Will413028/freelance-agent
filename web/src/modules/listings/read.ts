import { asc, inArray } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingFeedback, listings, listingVersions } from "@/db/pg/schema";

// What a page shows of the listings it ranked (plan step 3c): the rows, their mail versions and their
// feedback, read for the ids of one page only (at most PAGE_SIZE), never for the whole table.

export type ListingRow = typeof listings.$inferSelect;
export type VersionRow = typeof listingVersions.$inferSelect;
export type Shown = { row: ListingRow; versions: VersionRow[]; feedback: { state: "neutral" | "interested" | "skipped"; revision: number } };

/** The listings of `ids` with their versions (oldest first) and feedback; missing ids are left out. */
export async function readShown(db: PgDb, ids: readonly string[]): Promise<Map<string, Shown>> {
  const shown = new Map<string, Shown>();
  if (!ids.length) return shown;
  const list = [...ids];
  const [rows, versions, feedback] = await Promise.all([
    db.select().from(listings).where(inArray(listings.id, list)),
    db.select().from(listingVersions).where(inArray(listingVersions.listingId, list)).orderBy(asc(listingVersions.observedAt), asc(listingVersions.fingerprint)),
    db.select().from(listingFeedback).where(inArray(listingFeedback.listingId, list)),
  ]);
  const fb = new Map(feedback.map((f) => [f.listingId, { state: f.state, revision: f.revision }]));
  for (const row of rows) shown.set(row.id, { row, versions: [], feedback: fb.get(row.id) ?? { state: "neutral", revision: 0 } });
  for (const v of versions) shown.get(v.listingId)?.versions.push(v);
  return shown;
}
