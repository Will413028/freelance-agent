// Compare what the Python run and the TS shadow run each changed after the same start copy (plan step 4d).
//   SHADOW_DATABASE_URL=… pnpm exec tsx scripts/compare.ts --start <08:30 copy> --python <after-run copy> --out <report dir> [--day YYYY-MM-DD]
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { compareShadow, summarize } from "../src/ops/compare";

const { values } = parseArgs({ options: { start: { type: "string" }, python: { type: "string" }, out: { type: "string" }, day: { type: "string" } } });
// Report files are named by the Asia/Taipei day, like the copies they compare.
const day = values.day ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const url = process.env.SHADOW_DATABASE_URL;
if (!values.start || !values.python || !values.out || !url) throw new Error("usage: SHADOW_DATABASE_URL=… compare.ts --start <copy> --python <copy> --out <dir>");

const taken = (file: string) => `${path.basename(file)} (mtime ${statSync(file).mtime.toISOString()})`;
const pool = new Pool({ connectionString: url, max: 2 });
try {
  const report = await compareShadow({ start: values.start, python: values.python }, pool,
    { start: taken(values.start), python: taken(values.python), ts: `shadow at ${new Date().toISOString()}` });
  mkdirSync(values.out, { recursive: true, mode: 0o700 });
  const file = path.join(values.out, `compare-${day}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1) + "\n", { mode: 0o600 });
  console.log(summarize(report));
  console.log(`report: ${file}`);
  process.exitCode = report.counts.logic ? 1 : 0;
} finally {
  await pool.end();
}
