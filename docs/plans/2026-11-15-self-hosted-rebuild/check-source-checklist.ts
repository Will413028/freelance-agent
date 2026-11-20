// One-off check for plan step 12a (run from web/: pnpm exec tsx ../docs/plans/2026-11-15-self-hosted-rebuild/check-source-checklist.ts).
// The checklist's sources equal the catalog's, every cell is filled, and every cited repository path exists.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "../../../web/src/modules/sources/catalog";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const file = process.argv[2] ?? join(here, "source-checklist.md");
const rows = readFileSync(file, "utf8").split("\n").filter((l) => /^\| [a-z0-9_]+ \|/.test(l));
const problems: string[] = [];
const seen = new Set<string>();
for (const row of rows) {
  const cells = row.split("|").slice(1, -1).map((c) => c.trim());
  const name = cells[0];
  if (seen.has(name)) problems.push(`${name}: listed twice`);
  seen.add(name);
  if (cells.length !== 7) problems.push(`${name}: ${cells.length} cells, expected 7`);
  cells.forEach((c, i) => { if (c === "" || /MISSING|TODO/.test(c)) problems.push(`${name}: column ${i + 1} empty`); });
  for (const m of row.matchAll(/`((?:web|docs|deploy|browser)\/[^`:]+?)(?::(\d+))?`/g)) {
    const p = join(repo, m[1]);
    if (!existsSync(p)) { problems.push(`${name}: ${m[1]} does not exist`); continue; }
    if (m[2] && Number(m[2]) > readFileSync(p, "utf8").split("\n").length) problems.push(`${name}: ${m[1]}:${m[2]} past the end`);
  }
  const s = SOURCES.find((x) => x.name === name);
  if (s?.disabled && !(cells[6] ?? "").startsWith("停用")) problems.push(`${name}: disabled in the catalog but the VM cell does not say so`);
}
for (const s of SOURCES) if (!seen.has(s.name)) problems.push(`${s.name}: in the catalog, not in the checklist`);
for (const n of seen) if (!SOURCES.some((s) => s.name === n)) problems.push(`${n}: in the checklist, not in the catalog`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`OK: ${rows.length} sources, every cell filled, every cited path exists`);
