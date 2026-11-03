import { readAll, type Db } from "@/db/client";
import { sourcesRead } from "@/modules/collection/public";
import { backfillNovelty, checkNovelty, findDigestRead, insertDigest, type DigestRow, type NoveltyCheck, type StoredDigest } from "@/modules/notifications/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { assembleList, listReads } from "./discovery";

/** The replay rebuilds the projection the digest will read (verify may only import this service). */
export { rebuildProjection } from "./discovery";

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

/** The digest_novelty rows of digests just loaded from a copy (the import, the replay), from the copy's rows. */
export const rebuildNovelty = (db: Db, digests: Iterable<StoredDigest>): Promise<number> => backfillNovelty(db, digests);

/**
 * The after job's ledger check (plan step 10b2, read-only on D1): the stored ledger against the one
 * rederived from the snapshots since a day. No digest since then is a failure, not a pass: the day's
 * TS run should have built one.
 */
export async function checkLedger(db: Db, since: string): Promise<NoveltyCheck & { ok: boolean }> {
  const check = await checkNovelty(db, since);
  return { ...check, ok: check.digests > 0 && check.missing === 0 && check.extra === 0 };
}
