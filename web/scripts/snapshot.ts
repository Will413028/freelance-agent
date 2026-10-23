// Consistent copy of the production SQLite file through the SQLite backup API (plan step 4c).
//   pnpm exec tsx scripts/snapshot.ts --source <product db> --target <new file> [--retain-days 7]
// The source is opened read-only and the target must not exist yet. Copies in the target's
// directory older than --retain-days are removed afterwards.
import { closeSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { source: { type: "string" }, target: { type: "string" }, "retain-days": { type: "string" } } });
if (!values.source || !values.target) throw new Error("usage: snapshot.ts --source <db> --target <new file> [--retain-days N]");

closeSync(openSync(values.target, "wx", 0o600)); // O_EXCL: never overwrite an earlier copy
const source = new DatabaseSync(values.source, { readOnly: true });
try {
  await backup(source, values.target);
} finally {
  source.close();
}
const copy = new DatabaseSync(values.target, { readOnly: true });
try {
  const integrity = (copy.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check;
  const fk = copy.prepare("pragma foreign_key_check").all();
  if (integrity !== "ok" || fk.length) throw new Error(`copy failed checks: integrity ${integrity}, foreign key violations ${fk.length}`);
} finally {
  copy.close();
}
console.log(`snapshot ok: ${path.basename(values.target)}`);

const days = Number(values["retain-days"] ?? 0);
if (days > 0) {
  const dir = path.dirname(values.target), cutoff = Date.now() - days * 86_400_000;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name.endsWith(".sqlite3") && statSync(file).mtimeMs < cutoff) unlinkSync(file);
  }
}
