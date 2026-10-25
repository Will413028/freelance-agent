// Rederive the digest_novelty ledger from the stored snapshots and compare (plan step 10b2, D15).
// Needs only the snapshots, so it keeps working after the shadow replay is deleted in step 14.
//   SHADOW_DATABASE_URL=… pnpm exec tsx scripts/check-novelty.ts [--since YYYY-MM-DD]
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readTransaction, strictSslUrl } from "../src/db/client";
import * as schema from "../src/db/schema";
import { checkNoveltyIn } from "../src/modules/notifications/public";

const { values } = parseArgs({ options: { since: { type: "string" } } });
const url = process.env.SHADOW_DATABASE_URL;
if (!url) throw new Error("usage: SHADOW_DATABASE_URL=… check-novelty.ts [--since YYYY-MM-DD]");

const pool = new Pool({ connectionString: strictSslUrl(url), max: 1 });
try {
  const check = await readTransaction(drizzle(pool, { schema }), (tx) => checkNoveltyIn(tx, values.since));
  const ok = check.missing === 0 && check.extra === 0;
  console.log(`novelty ledger ${ok ? "same" : "DIFFERENT"}: ${check.digests} digests, ${check.rows} rows, ${check.missing} missing, ${check.extra} extra`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await pool.end();
}
