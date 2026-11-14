import { desc } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings } from "@/db/pg/schema";

export type SkeletonListing = { id: string; source: string; title: string; url: string };

/** The newest listings, for the walking-skeleton page (removed in step 3). */
export async function latestListings(db: PgDb, limit = 50): Promise<SkeletonListing[]> {
  return db.select({ id: listings.id, source: listings.source, title: listings.title, url: listings.url })
    .from(listings).orderBy(desc(listings.firstSeenAt), listings.id).limit(limit);
}

export const SKELETON_LISTING = {
  id: "skeleton-0001", source: "skeleton", externalId: "0001", title: "Skeleton listing (synthetic)", url: "https://example.com/jobs/0001",
} as const;

/** Writes the one synthetic listing; rerunning leaves the table unchanged (key: source + external_id). */
export async function seedSkeleton(db: PgDb): Promise<void> {
  await db.insert(listings).values(SKELETON_LISTING).onConflictDoNothing({ target: [listings.source, listings.externalId] });
}
