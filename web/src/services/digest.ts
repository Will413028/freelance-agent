import { readAll, type Db } from "@/db/client";
import { sourcesRead } from "@/modules/collection/public";
import { backfillNoveltyIn, findDigestRead, insertDigest, type DigestRow, type StoredDigest } from "@/modules/notifications/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { assembleList, listReads } from "./discovery";

/**
 * Notifications.create_digest: discovery's list_in composed with the outbox. The existing intent,
 * the list and the source statuses are read in one request, so the snapshot is built from one state
 * of the database; an existing intent for the day is returned unchanged, never rebuilt. Outside the
 * writer lease (D20 common basis 4): it only adds the day's rows, and the day's unique key decides
 * between two runs.
 */
export async function createDigest(db: Db, localDate: string, recipient: string, now: PyDateTime): Promise<DigestRow> {
  const [existing, sources, ...list] = await readAll(db, [findDigestRead(db, localDate, recipient), sourcesRead(db), ...listReads(db)]);
  if (existing) return existing;
  return insertDigest(db, assembleList(list, now), sources, localDate, recipient, now);
}

/** The digest_novelty rows of digests just loaded from a copy (converge, replay), from the copy's rows. */
export const rebuildNoveltyIn = (db: Db, digests: Iterable<StoredDigest>): Promise<number> => backfillNoveltyIn(db, digests);
