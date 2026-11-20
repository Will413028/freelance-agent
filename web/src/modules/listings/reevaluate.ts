import { and, eq, ne } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings, listingVersions } from "@/db/pg/schema";
import { FACTS_VERSION, factsOf } from "@/modules/evaluation/public";
import { listingOf, parseListingInput } from "./contract";

// Plan D26: the evaluation columns are computed at intake and only recomputed when the content changes, so
// a rule change would leave every stored row on the old rules. Each row carries the FACTS_VERSION it was
// computed with; this recomputes the rows of any other version from their stored contract (raw). It derives
// everything from the tables, so an interrupted or repeated run is safe. A row whose raw no longer parses
// under today's contract keeps its columns and version and is counted, so it shows up in the run record.

const BATCH = 500;

export type ReevaluateCounts = { reevaluated: number; unparsable: number };

const evaluated = (raw: unknown) => {
  try {
    return { ...factsOf(listingOf(parseListingInput(raw))), evaluatedWith: FACTS_VERSION };
  } catch {
    return null;
  }
};

export async function reevaluateStale(db: PgDb): Promise<ReevaluateCounts> {
  const counts: ReevaluateCounts = { reevaluated: 0, unparsable: 0 };
  const skip = { listings: new Set<number>(), versions: new Set<string>() };
  for (;;) {
    const rows = await db.select({ id: listings.id, raw: listings.raw }).from(listings)
      .where(ne(listings.evaluatedWith, FACTS_VERSION)).orderBy(listings.id).limit(BATCH + skip.listings.size);
    const todo = rows.filter((r) => !skip.listings.has(r.id));
    if (!todo.length) break;
    for (const r of todo) {
      const set = evaluated(r.raw);
      if (!set) { skip.listings.add(r.id); counts.unparsable++; continue; }
      await db.update(listings).set(set).where(eq(listings.id, r.id));
      counts.reevaluated++;
    }
  }
  for (;;) {
    const rows = await db.select({ listingId: listingVersions.listingId, fingerprint: listingVersions.fingerprint, raw: listingVersions.raw }).from(listingVersions)
      .where(ne(listingVersions.evaluatedWith, FACTS_VERSION)).orderBy(listingVersions.listingId, listingVersions.fingerprint).limit(BATCH + skip.versions.size);
    const todo = rows.filter((r) => !skip.versions.has(`${r.listingId}:${r.fingerprint}`));
    if (!todo.length) break;
    for (const r of todo) {
      const set = evaluated(r.raw);
      if (!set) { skip.versions.add(`${r.listingId}:${r.fingerprint}`); counts.unparsable++; continue; }
      await db.update(listingVersions).set(set).where(and(eq(listingVersions.listingId, r.listingId), eq(listingVersions.fingerprint, r.fingerprint)));
      counts.reevaluated++;
    }
  }
  return counts;
}
