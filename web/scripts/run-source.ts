// One source, once, against DATABASE_URL: reads the source, writes its listings and prints counts.
// It writes no run_sources row (the daily run does). It prints counts only, never listing text.
//   DATABASE_URL=… pnpm tsx scripts/run-source.ts <source>
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "../src/db/pg/client";
import { collectSource } from "../src/services/collect";

const [source, ...rest] = process.argv.slice(2);
if (!source || rest.length) throw new Error("usage: run-source.ts <source>");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: url, max: 1 });
try {
  const db = drizzle(pool, { schema });
  const run = await collectSource(db, source);
  console.log(JSON.stringify({ source: run.source, seen: run.seen, examined: run.examined, rejected: run.rejected, truncated: run.truncated, stored: run.stored, requests: run.requests, intake: run.intake }, null, 2));
} finally {
  await pool.end();
}
