import { writeTransaction, type Db, type Executor } from "@/db/client";
import { sourcesIn } from "@/modules/collection/public";
import { backfillNoveltyIn, findDigestIn, insertDigestIn, type DigestRow, type StoredDigest } from "@/modules/notifications/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { listIn } from "./discovery";

// Notifications.create_digest: compose discovery's list_in with the outbox in one write
// transaction; an existing intent for the day is returned unchanged, never rebuilt.
export function createDigest(db: Db, localDate: string, recipient: string, now: PyDateTime): Promise<DigestRow> {
  return writeTransaction(db, (tx) => createDigestIn(tx, localDate, recipient, now));
}

/** create_digest inside the caller's transaction (the shadow digest replay runs it in one it rolls back). */
export async function createDigestIn(tx: Executor, localDate: string, recipient: string, now: PyDateTime): Promise<DigestRow> {
  const existing = await findDigestIn(tx, localDate, recipient);
  if (existing) return existing;
  return insertDigestIn(tx, await listIn(tx, now), await sourcesIn(tx), localDate, recipient, now);
}

/** The digest_novelty rows of digests just loaded from a copy (converge, replay), from the copy's rows. */
export const rebuildNoveltyIn = (tx: Executor, digests: Iterable<StoredDigest>): Promise<number> => backfillNoveltyIn(tx, digests);
