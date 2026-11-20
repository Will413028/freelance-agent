// Fails when a migration after the initial one would stop the previous image from running (design review
// 12e O5). deploy.sh rolls back only the image, never the schema, and there is no backup (plan D1), so every
// migration must let the previous image keep reading and writing: add first, remove in a later deploy
// (docs/operations.md). Refused: DROP TABLE, DROP COLUMN, RENAME, ALTER COLUMN … TYPE, SET NOT NULL, and
// ADD COLUMN … NOT NULL without a DEFAULT (the previous image's inserts omit the column), and any new or
// narrower constraint (ADD CONSTRAINT, CREATE UNIQUE INDEX: the previous image's writes may break it). A migration that
// removes what no deployed image uses any more says so on its own line, naming why:
//   -- contract: <what was removed, and the deploy since which no image uses it>
// Usage: node deploy/check-migrations.mjs [migrations dir]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? new URL("../web/drizzle-pg/", import.meta.url).pathname;
const RULES = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bRENAME\b/i, "RENAME"],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "ALTER COLUMN … TYPE"],
  [/\bSET\s+NOT\s+NULL\b/i, "SET NOT NULL"],
  [/\bADD\s+COLUMN\b(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b/i, "ADD COLUMN … NOT NULL without DEFAULT"],
  [/\bADD\s+CONSTRAINT\b/i, "ADD CONSTRAINT"],
  [/\bCREATE\s+UNIQUE\s+INDEX\b/i, "CREATE UNIQUE INDEX"],
];
const problems = [];
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
for (const file of files.slice(1)) {
  const sql = readFileSync(join(dir, file), "utf8");
  if (/^--\s*contract:\s*\S/m.test(sql)) continue;
  const code = sql.replace(/--.*$/gm, "");
  for (const statement of code.split(/;|--> statement-breakpoint/)) {
    for (const [re, name] of RULES) if (re.test(statement)) problems.push(`${file}: ${name}: ${statement.trim().split("\n")[0]}`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error("a migration must let the previous image run (docs/operations.md); a deliberate removal says `-- contract: <why>`");
  process.exit(1);
}
console.log(`migrations ok (${files.length} files, ${Math.max(files.length - 1, 0)} checked)`);
