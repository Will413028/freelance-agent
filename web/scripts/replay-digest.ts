// Same-start digest replay (plan step 10b, on the local D1 stand-in since step 4e3): rebuild the day's
// Python digest with the TS code from the after-run copy. Touches neither D1 nor the copies.
//   pnpm exec tsx scripts/replay-digest.ts --start <08:30 copy> --python <after-run copy> --out <report dir> --day YYYY-MM-DD
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { replayDigest } from "../src/verify/replay";

const { values } = parseArgs({ options: { start: { type: "string" }, python: { type: "string" }, out: { type: "string" }, day: { type: "string" } } });
if (!values.start || !values.python || !values.out || !values.day) throw new Error("usage: replay-digest.ts --start <copy> --python <copy> --out <dir> --day YYYY-MM-DD");

const report = await replayDigest({ start: values.start, python: values.python }, values.day);
mkdirSync(values.out, { recursive: true, mode: 0o700 });
const file = path.join(values.out, `replay-${values.day}.json`);
writeFileSync(file, JSON.stringify(report, null, 1) + "\n", { mode: 0o600 });
console.log(report.equal === null ? `replay ${values.day}: inconclusive (${report.userChanges.length ? "user changes: " + report.userChanges.join(", ") : "no Python digest"})` : `replay ${values.day}: ${report.equal ? "same" : "DIFFERENT"} ` +
  `(python ${report.python!.items} items, ts ${report.ts!.items} items)`);
console.log(`report: ${file}`);
process.exitCode = report.equal === false ? 1 : 0;
