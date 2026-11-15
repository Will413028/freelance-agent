import { eq } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingFeedback, listingFeedbackEvents, listings } from "@/db/pg/schema";
import type { FeedbackState } from "@/modules/evaluation/public";
import { Conflict, NotFound } from "@/platform/errors";

// Save/skip (step-3-design.md, listing_feedback): the page sends back the feedback revision it showed
// as its token, and a write at any other revision is refused, so two tabs never overwrite each other
// silently. Every accepted write appends an event with its revision.

export const STALE_FEEDBACK = "職缺或收藏狀態已更新，請重新載入";

/** The token a page renders for a listing: its feedback revision, 0 before the first write. */
export const feedbackToken = (revision: number) => String(revision);

/** Writes `state` when `token` is the listing's current revision; returns the new revision. */
export async function setFeedback(db: PgDb, id: string, token: string, state: FeedbackState, now = new Date()): Promise<number> {
  const expected = /^(0|[1-9][0-9]{0,8})$/.test(token) ? Number(token) : null;
  return db.transaction(async (tx) => {
    // Locking the listing row serializes writes to one listing, also the first one (no feedback row yet).
    const [listing] = await tx.select({ id: listings.id }).from(listings).where(eq(listings.id, id)).for("update");
    if (!listing) throw new NotFound(id);
    const [current] = await tx.select({ revision: listingFeedback.revision }).from(listingFeedback).where(eq(listingFeedback.listingId, id));
    if (expected === null || expected !== (current?.revision ?? 0)) throw new Conflict(STALE_FEEDBACK);
    const revision = expected + 1;
    await tx.insert(listingFeedback).values({ listingId: id, state, revision, updatedAt: now })
      .onConflictDoUpdate({ target: listingFeedback.listingId, set: { state, revision, updatedAt: now } });
    await tx.insert(listingFeedbackEvents).values({ listingId: id, revision, state, createdAt: now });
    return revision;
  });
}
