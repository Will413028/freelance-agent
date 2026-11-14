import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";

/** Postgres answers a query. The compose healthcheck calls this; it checks nothing else. */
export async function health(db: () => PgDb): Promise<Response> {
  try {
    await db().execute(sql`select 1`);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
