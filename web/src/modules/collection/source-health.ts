import { asc, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { sourceHealth, type SourceStatus } from "@/db/schema";

export async function setSourceHealth(db: Db, source: string, status: SourceStatus) {
  await db
    .insert(sourceHealth)
    .values({ source, status })
    .onConflictDoUpdate({
      target: sourceHealth.source,
      set: { status, checkedAt: sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')` },
    });
}

export async function listSourceHealth(db: Db) {
  return db.select().from(sourceHealth).orderBy(asc(sourceHealth.source));
}
