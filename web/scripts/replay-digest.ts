// Same-start digest replay (plan step 10b): rebuild the day's Python digest with the TS code on the
// after-run copy, inside a shadow-database transaction that is always rolled back.
//   SHADOW_DATABASE_URL=… pnpm exec tsx scripts/replay-digest.ts --start <08:30 copy> --python <after-run copy> --out <report dir> --day YYYY-MM-DD
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { strictSslUrl } from "../src/db/client";
import { replayDigest } from "../src/verify/replay";

const { values } = parseArgs({ options: { start: { type: "string" }, python: { type: "string" }, out: { type: "string" }, day: { type: "string" } } });
const url = process.env.SHADOW_DATABASE_URL;
if (!values.start || !values.python || !values.out || !values.day || !url) throw new Error("usage: SHADOW_DATABASE_URL=… replay-digest.ts --start <copy> --python <copy> --out <dir> --day YYYY-MM-DD");

const pool = new Pool({ connectionString: strictSslUrl(url), max: 1 });
try {
  const report = await replayDigest({ start: values.start, python: values.python }, pool, values.day);
  mkdirSync(values.out, { recursive: true, mode: 0o700 });
  const file = path.join(values.out, `replay-${values.day}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1) + "\n", { mode: 0o600 });
  console.log(report.equal === null ? `replay ${values.day}: inconclusive (${report.userChanges.length ? "user changes: " + report.userChanges.join(", ") : "no Python digest"})` : `replay ${values.day}: ${report.equal ? "same" : "DIFFERENT"} ` +
    `(python ${report.python!.items} items, ts ${report.ts!.items} items)`);
  console.log(`report: ${file}`);
  process.exitCode = report.equal === false ? 1 : 0;
} finally {
  await pool.end();
}
