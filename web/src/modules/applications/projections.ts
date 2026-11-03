import { asc, eq } from "drizzle-orm";
import { inList, read, type Db } from "@/db/client";
import { manualApplicationOpportunities, manualApplications } from "@/db/schema";

// The read side of applications/store.py:projections_in that discovery needs for group tokens (HP7).
// Writes to manual applications arrive in plan step 11.

export type ApplicationProjection = { ids: string[]; token: string[] };

function project(rows: { opportunityId: string; id: string; revision: number; deletedAt: string | null }[]) {
  const result = new Map<string, ApplicationProjection>();
  for (const row of rows) {
    const view = result.get(row.opportunityId) ?? { ids: [], token: [] };
    result.set(row.opportunityId, view);
    if (row.deletedAt === null) view.ids.push(row.id);
    view.token.push(`${row.id}:${row.revision}:${row.deletedAt || ""}`);
  }
  return result;
}

const projectionsQuery = (db: Db, keys?: readonly string[]) =>
  db.select({ opportunityId: manualApplicationOpportunities.opportunityId, id: manualApplications.id,
    revision: manualApplications.revision, deletedAt: manualApplications.deletedAt })
    .from(manualApplicationOpportunities)
    .innerJoin(manualApplications, eq(manualApplications.id, manualApplicationOpportunities.applicationId))
    .where(keys === undefined ? undefined : inList(manualApplicationOpportunities.opportunityId, keys))
    .orderBy(asc(manualApplications.id)); // SQLite BINARY order, as Python (spike 1c rule 9)

export const applicationProjectionsRead = (db: Db) => read(projectionsQuery(db), project);

/** The same for these opportunities only (a discovery page, plan step 10e1). */
export const applicationProjectionsFor = (db: Db, keys: readonly string[]) => read(projectionsQuery(db, keys), project);
