// One-time import of a consistent SQLite copy of production into D1 (plan step 4e3): the D1 shadow
// (step 4e4) and the production database (step 13). It drops and recreates every product table, so
// the operator names the target database id; it waits for the writer lease and holds it while loading.
//   CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/import-copy.ts --sqlite <copy> --confirm-drop <database id> [--report <file>]
// An interrupted import is run again; only an ok report releases the database.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { copiedDiscovery, importCopy } from "../src/ops/import";
import { rebuildProjection } from "../src/services/discovery";

const { values } = parseArgs({ options: { sqlite: { type: "string" }, "confirm-drop": { type: "string" }, report: { type: "string" } } });
const target = process.env.D1_DATABASE_ID;
if (!values.sqlite || !target) throw new Error("usage: CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… import-copy.ts --sqlite <copy> --confirm-drop <database id> [--report <file>]");
if (values["confirm-drop"] !== target) throw new Error("refusing to drop: --confirm-drop must name the target database id (D1_DATABASE_ID)");

// The discovery projection (plan step 10e1), derived from the copy.
const report = await importCopy(values.sqlite, getDb(), (db, lite, send) => rebuildProjection(db, copiedDiscovery(lite), send));
if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 1) + "\n", { mode: 0o600 });
for (const [table, t] of Object.entries(report.tables)) console.log(`${table}\t${t.source.rows}\t${t.source.sha256 === t.target.sha256 ? "same" : "DIFFERENT"}`);
console.log(`derived\t${report.derived}\trebuilt (discovery_items, discovery_versions)`);
console.log(`d1_rows_written\t${report.d1RowsWritten}`);
console.log(report.ok ? "import ok" : "import FAILED: D1 differs from the copy; run it again");
process.exitCode = report.ok ? 0 : 1;
