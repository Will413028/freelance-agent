import { asc, eq } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { manualApplicationOpportunities, manualApplications } from "@/db/schema";

// The read side of applications/store.py:projections_in that discovery needs for group tokens (HP7).
// Writes to manual applications arrive in plan step 11.

export type ApplicationProjection = { ids: string[]; token: string[] };

export async function applicationProjections(tx: Executor): Promise<Map<string, ApplicationProjection>> {
  const rows = await tx
    .select({ opportunityId: manualApplicationOpportunities.opportunityId, id: manualApplications.id,
      revision: manualApplications.revision, deletedAt: manualApplications.deletedAt })
    .from(manualApplicationOpportunities)
    .innerJoin(manualApplications, eq(manualApplications.id, manualApplicationOpportunities.applicationId))
    .orderBy(asc(manualApplications.id)); // COLLATE "C", like SQLite BINARY (spike 1c rule 9)
  const result = new Map<string, ApplicationProjection>();
  for (const row of rows) {
    const view = result.get(row.opportunityId) ?? { ids: [], token: [] };
    result.set(row.opportunityId, view);
    if (row.deletedAt === null) view.ids.push(row.id);
    view.token.push(`${row.id}:${row.revision}:${row.deletedAt || ""}`);
  }
  return result;
}
