import { asc, eq } from "drizzle-orm";
import { read, type Db } from "@/db/client";
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

export const applicationProjectionsRead = (db: Db) => read(
  db.select({ opportunityId: manualApplicationOpportunities.opportunityId, id: manualApplications.id,
    revision: manualApplications.revision, deletedAt: manualApplications.deletedAt })
    .from(manualApplicationOpportunities)
    .innerJoin(manualApplications, eq(manualApplications.id, manualApplicationOpportunities.applicationId))
    .orderBy(asc(manualApplications.id)), // SQLite BINARY order, as Python (spike 1c rule 9)
  project,
);
