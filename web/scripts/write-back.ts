// Write-back "D1 → SQLite" for a rollback inside D6's window (plan steps 12–13): run with the Vercel
// cron disabled and WEB_WRITES removed, on a copy of the pre-cutover backup, never on the live file.
// Prints counts and fingerprints only; the report names tables and columns, no values.
//   CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/write-back.ts --sqlite <copy> [--report <file>]
// Run it again until it reports no inserts and no updates; then the copy equals D1.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { writeBack } from "../src/ops/write-back";

const { values } = parseArgs({ options: { sqlite: { type: "string" }, report: { type: "string" } } });
if (!values.sqlite) throw new Error("usage: CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… write-back.ts --sqlite <copy> [--report <file>]");

const report = await writeBack(getDb(), values.sqlite);
if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 1) + "\n", { mode: 0o600 });
for (const [table, t] of Object.entries(report.tables)) {
  const columns = Object.entries(t.updatedColumns).map(([c, n]) => `${c}:${n}`).join(",");
  console.log(`${table}\t${t.rows}\t+${t.inserted}\t~${t.updated}${columns ? ` (${columns})` : ""}\t${t.sqlite === t.d1 ? "same" : "DIFFERENT"}\t${t.sqlite.slice(0, 16)}`);
}
console.log(report.ok ? "write-back ok" : "write-back FAILED");
process.exitCode = report.ok ? 0 : 1;
