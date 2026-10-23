// Load a consistent SQLite copy of production into the shadow Postgres (plan step 4c).
//   SHADOW_DATABASE_URL=… pnpm exec tsx scripts/converge.ts --sqlite <copy> --confirm-drop <shadow host> [--report <file>]
// It drops and recreates the target schema, so the operator names the target host explicitly.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { strictSslUrl } from "../src/db/client";
import { converge } from "../src/ops/converge";

const { values } = parseArgs({ options: { sqlite: { type: "string" }, "confirm-drop": { type: "string" }, report: { type: "string" } } });
const url = process.env.SHADOW_DATABASE_URL;
if (!values.sqlite || !url) throw new Error("usage: SHADOW_DATABASE_URL=… converge.ts --sqlite <copy> --confirm-drop <host> [--report <file>]");
const host = new URL(url).hostname || "localhost";
if (values["confirm-drop"] !== host) throw new Error(`refusing to drop: --confirm-drop must name the target host (${host})`);

const pool = new Pool({ connectionString: strictSslUrl(url), max: 2 });
try {
  const report = await converge(values.sqlite, pool, path.resolve(import.meta.dirname, "../drizzle"));
  const text = JSON.stringify(report, null, 1);
  if (values.report) writeFileSync(values.report, text + "\n", { mode: 0o600 });
  for (const [table, t] of Object.entries(report.tables)) console.log(`${table}\t${t.source.rows}\t${t.source.sha256 === t.target.sha256 ? "same" : "DIFFERENT"}`);
  console.log(report.ok ? "converge ok" : "converge FAILED: target differs from the copy");
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await pool.end();
}
