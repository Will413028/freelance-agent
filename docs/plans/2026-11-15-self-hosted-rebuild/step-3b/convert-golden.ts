// One-off (plan steps 3b, 3b2): golden.json's evaluate and recommendation cases to native fixtures
// beside web/src/modules/evaluation/. Run from web/:
//   pnpm exec tsx --tsconfig tsconfig.json ../docs/plans/2026-11-15-self-hosted-rebuild/step-3b/convert-golden.ts
// Each old job goes through legacyToInput (plan D8) and the fixture keeps the contract input it gives.
// Expectations are the golden results without the fields the new system no longer has (portfolio_ids,
// method, available_hours), never edited. A case whose Python result is an exception, or whose job
// legacyToInput refuses, is listed in `dropped` with its reason.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluate as oldEvaluate } from "@/modules/discovery/rules";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { PyDict, type PyValue } from "@/platform/py/value";
import { legacyToInput } from "@/modules/listings/public";
import { untag, type Tagged } from "../../../../web/tests/helpers/golden";

const web = process.cwd();
const golden = JSON.parse(readFileSync(path.join(web, "tests/fixtures/golden.json"), "utf8"));
const NOW = golden.now as string;
const PY_NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
if (NOW !== "2026-09-28T01:00:00+00:00") throw new Error(`golden now changed: ${NOW}`);

const dropped: { list: string; index: number; reason: string }[] = [];
class NotJson extends Error {}

/** legacyToInput, or a drop reason when it refuses the job (no text title or external_id). */
function toInput(list: string, index: number, job: any) {
  try {
    return legacyToInput(job.source, job);
  } catch (e) {
    dropped.push({ list, index, reason: `legacyToInput refuses it: ${(e as Error).message} (old intake never stored such a listing)` });
    return null;
  }
}
function native(v: PyValue): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "bigint") {
    // JSON numbers are doubles: an integer is carried when a double holds it exactly (2^60 does).
    if (BigInt(Number(v)) !== v) throw new NotJson(`integer ${v} not exact as a double`);
    return Number(v);
  }
  if (typeof v === "number") return v; // NaN and infinities reach legacyToInput, which reads them as unknown
  if (Array.isArray(v)) return v.map(native);
  return Object.fromEntries([...(v as PyDict)].map(([k, x]) => [k, native(x)]));
}

const settingsOf = (s: any) => ({ maxWeeklyHours: s.max_weekly_hours, minFixedTwd: s.min_fixed_twd, categories: s.categories });
const evalExpect = (e: any) => ({ status: e.status, category: e.category, score: e.score, reasons: e.reasons, questions: e.questions });

const evaluateCases = golden.evaluate.flatMap((c: any, index: number) => {
  if ("error" in c.expect) { dropped.push({ list: "evaluate", index, reason: `Python ${c.expect.error}: a non-text title or description; native intake refuses a listing without a text title and reads other non-text as absent` }); return []; }
  try {
    const job = native(untag(c.job as Tagged)) as any, settings = settingsOf(native(untag(c.settings as Tagged)));
    const parsed = toInput("evaluate", index, job);
    return parsed ? [{ index, input: parsed, settings, expect: evalExpect(JSON.parse(c.expect.ok)) }] : [];
  } catch (e) {
    if (!(e instanceof NotJson)) throw e;
    dropped.push({ list: "evaluate", index, reason: `input not JSON: ${e.message}` });
    return [];
  }
});

const ALL = ["AI agent", "AI 整合／自動化", "後端／API", "全端 MVP"];
const recommendationCases = golden.recommendation.flatMap((c: any, index: number) => {
  const input = untag(c.input as Tagged) as PyDict;
  let item: any;
  try { item = native(input); } catch (e) {
    if (!(e instanceof NotJson)) throw e;
    dropped.push({ list: "recommendation", index, reason: `input not JSON: ${e.message}` });
    return [];
  }
  // The settings the stored evaluation was made under: its available hours, the default floor and categories.
  const settings = { maxWeeklyHours: item.evaluation.available_hours, minFixedTwd: 3000, categories: ALL };
  const recomputed = encode(oldEvaluate(input.dict("job"), PyDict.of({ max_weekly_hours: input.dict("evaluation").req("available_hours"), min_fixed_twd: 3000n, categories: [...ALL] }), PY_NOW));
  if (recomputed !== encode(input.dict("evaluation"))) throw new Error(`recommendation/${index}: stored evaluation is not evaluate's under the inferred settings`);
  const e = JSON.parse(c.expect.ok), parsed = toInput("recommendation", index, item.job);
  if (!parsed) return [];
  return [{
    index, listing: { fingerprint: item.fingerprint, input: parsed }, versions: [], feedback: item.tracking?.feedback ?? "neutral", settings,
    expect: { score: e.score, completeness: e.completeness, freshness: e.freshness, reasons: e.reasons, basis: e.basis_fingerprint },
  }];
});

const header = (list: string, cases: unknown[]) => ({
  about: `Native cases of golden.json ${list} (plan steps 3b, 3b2; generated by docs/plans/2026-11-15-self-hosted-rebuild/step-3b/convert-golden.ts). index is the golden case's position; input is the old job through legacyToInput; expect is golden's result.`,
  now: NOW, dropped: dropped.filter((d) => d.list === list), cases,
});
const out = path.join(web, "src/modules/evaluation");
writeFileSync(path.join(out, "evaluate.fixtures.json"), JSON.stringify(header("evaluate", evaluateCases), null, 1) + "\n");
writeFileSync(path.join(out, "recommendation.fixtures.json"), JSON.stringify(header("recommendation", recommendationCases), null, 1) + "\n");
console.log(`evaluate ${evaluateCases.length} carried, recommendation ${recommendationCases.length} carried, dropped ${dropped.length}`);
for (const d of dropped) console.log(`dropped ${d.list}/${d.index}: ${d.reason}`);
