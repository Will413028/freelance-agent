// One source, once, against DATABASE_URL (plan step 4): reads the source, writes its listings and
// prints counts. It writes no run_sources row (the daily run of step 6 does). With --expect <file>
// (one external_id per line, e.g. the production ids of this source) it also prints which ids this
// run kept that the file lacks, with each listing's published_at (each must be newer than production's
// last run, or the id changed spelling). expectedNotKept, the file's ids this run did not keep, is
// informational: with a source's whole production history as the file it is mostly old listings. It prints ids, counts and times only, never listing text.
//   DATABASE_URL=… pnpm tsx scripts/run-source.ts <source> [--expect <file>]
import { readFileSync } from "node:fs";
import { inArray, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "../src/db/pg/client";
import { listings } from "../src/db/pg/schema";
import { collectSource } from "../src/services/collect";

const [source, flag, file] = process.argv.slice(2);
if (!source || (flag !== undefined && (flag !== "--expect" || !file))) throw new Error("usage: run-source.ts <source> [--expect <file>]");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: url, max: 1 });
try {
  const db = drizzle(pool, { schema });
  const run = await collectSource(db, source);
  const report: Record<string, unknown> = { source: run.source, seen: run.seen, jobs: run.jobs, requests: run.requests, intake: run.intake };
  if (file) {
    const expected = new Set(readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    const newOnly = run.externalIds.filter((id) => !expected.has(id));
    const rows = newOnly.length
      ? await db.select({ externalId: listings.externalId, publishedAt: listings.publishedAt }).from(listings)
        .where(and(eq(listings.source, run.source), inArray(listings.externalId, newOnly)))
      : [];
    const kept = new Set(run.externalIds);
    report.compare = {
      expected: expected.size,
      newOnly: rows.map((r) => ({ externalId: r.externalId, publishedAt: r.publishedAt?.toISOString() ?? null })).sort((a, b) => a.externalId.localeCompare(b.externalId)),
      expectedNotKept: [...expected].filter((id) => !kept.has(id)).length,
    };
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
