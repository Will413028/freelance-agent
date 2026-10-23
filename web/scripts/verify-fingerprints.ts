// Spike 1c one-time check on a copy of production (plan step 1c, item 4): recompute every stored id,
// fingerprint and snapshot hash with the TS port and count matches. Prints counts only, never data.
//   pnpm exec tsx scripts/verify-fingerprints.ts --sqlite <copy>
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { jobFingerprint, opportunityId } from "@/modules/collection/public";
import { encode, loads, loadsDict, submissionDigest } from "@/platform/py/json";

const { values } = parseArgs({ options: { sqlite: { type: "string" } } });
if (!values.sqlite) throw new Error("usage: verify-fingerprints.ts --sqlite <copy>");
const lite = new DatabaseSync(values.sqlite, { readOnly: true });

const tally = new Map<string, { pass: number; fail: number }>();
const check = (name: string, ok: () => boolean) => {
  const t = tally.get(name) ?? { pass: 0, fail: 0 };
  tally.set(name, t);
  try { if (ok()) t.pass++; else t.fail++; } catch { t.fail++; }
};
const rows = (sql: string) => lite.prepare(sql).all() as Record<string, string>[];

for (const r of rows("select id, source, external_id, item from opportunities")) {
  check("HP10 item text round-trips through loads/encode", () => encode(loads(r.item)) === r.item);
  const item = loadsDict(r.item), job = item.dict("job");
  check("HP1 opportunity id", () => opportunityId(r.source, r.external_id) === r.id && item.req("id") === r.id);
  check("HP1 stored fingerprint", () => jobFingerprint(job) === item.req("fingerprint"));
}
for (const r of rows("select opportunity_id, fingerprint, job from mail_content_versions")) {
  check("HP1 mail content version fingerprint", () => jobFingerprint(loadsDict(r.job)) === r.fingerprint);
}
for (const r of rows("select snapshot, snapshot_hash, approval_hash, status from submission_intents")) {
  check("HP4 submission snapshot hash", () => submissionDigest(loads(r.snapshot)) === r.snapshot_hash);
}
for (const table of ["digest_outbox:snapshot", "proposal_drafts:source_snapshot", "manual_applications:request_payload", "opportunity_tracking:state"]) {
  const [name, column] = table.split(":");
  for (const r of rows(`select ${column} as v from ${name}`)) {
    check(`HP10 ${name}.${column} round-trips`, () => encode(loads(r.v)) === r.v);
  }
}
lite.close();

// HP10 is informational: rows written by an older plain json.dumps (ensure_ascii=True) do not
// round-trip through encode() yet keep their meaning; only the hash points decide the exit code.
let failed = 0;
for (const [name, t] of tally) {
  const info = name.startsWith("HP10");
  console.log(`${t.fail ? (info ? "info" : "FAIL") : "ok  "} ${name}: ${t.pass}/${t.pass + t.fail}`);
  if (!info) failed += t.fail;
}
process.exitCode = failed ? 1 : 0;
