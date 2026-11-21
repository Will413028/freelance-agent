import { and, eq, ne } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings, listingVersions, OPPORTUNITY_TYPES, type OpportunityType } from "@/db/pg/schema";
import { evaluatorFor } from "@/modules/evaluation/public";
import { parseListingInput } from "./contract";
import { evaluatedColumns } from "./intake";

// Plan D26: the evaluation columns are computed at intake and only recomputed when the content changes, so
// a rule change would leave every stored row on the old rules. Each row carries the FACTS_VERSION it was
// computed with; this recomputes the rows of any other version from their stored contract (raw). It derives
// everything from the tables, so an interrupted or repeated run is safe. A row whose raw no longer parses
// under today's contract keeps its columns and version and is counted, so it shows up in the run record.
// Per opportunity type (opportunity types plan D1): only rows of a type this image knows, against that
// type's version, so an older image after a rollback never touches rows a newer one wrote.

const BATCH = 500;

export type ReevaluateCounts = { reevaluated: number; unparsable: number };

const evaluated = (raw: unknown, type: OpportunityType) => {
  try {
    const input = parseListingInput(raw);
    // A raw of another type than its column is counted as unparsable too: no rule of this type applies to it.
    if (input.opportunity_type !== type) return null;
    return evaluatedColumns(input);
  } catch {
    return null;
  }
};

/** `types`: the types this image knows; a test passes fewer to stand for an older image after a rollback. */
export async function reevaluateStale(db: PgDb, types: readonly OpportunityType[] = OPPORTUNITY_TYPES): Promise<ReevaluateCounts> {
  const counts: ReevaluateCounts = { reevaluated: 0, unparsable: 0 };
  for (const type of types) await reevaluateType(db, type, counts);
  return counts;
}

async function reevaluateType(db: PgDb, type: OpportunityType, counts: ReevaluateCounts): Promise<void> {
  const { version } = evaluatorFor(type);
  const skip = { listings: new Set<number>(), versions: new Set<string>() };
  for (;;) {
    const rows = await db.select({ id: listings.id, raw: listings.raw }).from(listings)
      .where(and(eq(listings.opportunityType, type), ne(listings.evaluatedWith, version))).orderBy(listings.id).limit(BATCH + skip.listings.size);
    const todo = rows.filter((r) => !skip.listings.has(r.id));
    if (!todo.length) break;
    for (const r of todo) {
      const set = evaluated(r.raw, type);
      if (!set) { skip.listings.add(r.id); counts.unparsable++; continue; }
      await db.update(listings).set(set).where(eq(listings.id, r.id));
      counts.reevaluated++;
    }
  }
  for (;;) {
    const rows = await db.select({ listingId: listingVersions.listingId, fingerprint: listingVersions.fingerprint, raw: listingVersions.raw }).from(listingVersions)
      .where(and(eq(listingVersions.opportunityType, type), ne(listingVersions.evaluatedWith, version))).orderBy(listingVersions.listingId, listingVersions.fingerprint).limit(BATCH + skip.versions.size);
    const todo = rows.filter((r) => !skip.versions.has(`${r.listingId}:${r.fingerprint}`));
    if (!todo.length) break;
    for (const r of todo) {
      const set = evaluated(r.raw, type);
      if (!set) { skip.versions.add(`${r.listingId}:${r.fingerprint}`); counts.unparsable++; continue; }
      await db.update(listingVersions).set(set).where(and(eq(listingVersions.listingId, r.listingId), eq(listingVersions.fingerprint, r.fingerprint)));
      counts.reevaluated++;
    }
  }
}
