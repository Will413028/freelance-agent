// One-off (plan step 3b): golden.json's evaluate and recommendation cases to native fixtures beside
// web/src/modules/evaluation/. Run from web/:
//   pnpm exec tsx ../docs/plans/2026-11-15-self-hosted-rebuild/step-3b/convert-golden.ts
// Inputs JSON cannot hold (NaN, integers a double does not hold exactly) and the cases whose Python result is an exception
// are not carried; each is listed in the output's `dropped` with its reason. Expectations are the
// golden results with the fields the new system no longer has removed (portfolio_ids, method,
// available_hours); deliberate changes are applied from CHANGES below and named on each case.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluate as oldEvaluate } from "@/modules/discovery/rules";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { PyDict, type PyValue } from "@/platform/py/value";
import { untag, type Tagged } from "../../../../web/tests/helpers/golden";

const web = process.cwd();
const golden = JSON.parse(readFileSync(path.join(web, "tests/fixtures/golden.json"), "utf8"));
const NOW = golden.now as string;
const PY_NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
if (NOW !== "2026-09-28T01:00:00+00:00") throw new Error(`golden now changed: ${NOW}`);

class NotJson extends Error {}
function native(v: PyValue): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "bigint") {
    // JSON numbers are doubles: an integer is carried when a double holds it exactly (2^60 does).
    if (BigInt(Number(v)) !== v) throw new NotJson(`integer ${v} not exact as a double`);
    return Number(v);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new NotJson(`float ${v}`);
    return v;
  }
  if (Array.isArray(v)) return v.map(native);
  return Object.fromEntries([...(v as PyDict)].map(([k, x]) => [k, native(x)]));
}

const settingsOf = (s: any) => ({ maxWeeklyHours: s.max_weekly_hours, minFixedTwd: s.min_fixed_twd, categories: s.categories });
const evalExpect = (e: any) => ({ status: e.status, category: e.category, score: e.score, reasons: e.reasons, questions: e.questions });

/** Deliberate changes, by golden list and index, with the native expectation's patch. */
const CHANGES: Record<string, { reason: string; patch: Record<string, unknown> }> = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "changes.json"), "utf8"));

const dropped: { list: string; index: number; reason: string }[] = [];
const changed: string[] = [];
const apply = (key: string, expect: any) => {
  const c = CHANGES[key];
  if (!c) return { expect };
  changed.push(key);
  return { expect: { ...expect, ...c.patch }, change: c.reason };
};

const evaluateCases = golden.evaluate.flatMap((c: any, index: number) => {
  if ("error" in c.expect) { dropped.push({ list: "evaluate", index, reason: `Python ${c.expect.error}: a non-text title or description; native intake refuses a listing without a text title and reads other non-text as absent` }); return []; }
  try {
    const job = native(untag(c.job as Tagged)) as any, settings = settingsOf(native(untag(c.settings as Tagged)));
    return [{ index, source: job.source, job, settings, ...apply(`evaluate/${index}`, evalExpect(JSON.parse(c.expect.ok))) }];
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
  const e = JSON.parse(c.expect.ok);
  return [{
    index, source: item.job.source, listing: { fingerprint: item.fingerprint, job: item.job }, versions: [], feedback: item.tracking?.feedback ?? "neutral", settings,
    ...apply(`recommendation/${index}`, { score: e.score, completeness: e.completeness, freshness: e.freshness, reasons: e.reasons, basis: e.basis_fingerprint }),
  }];
});

const unused = Object.keys(CHANGES).filter((k) => !changed.includes(k));
if (unused.length) throw new Error(`changes not applied: ${unused}`);
const header = (list: string, cases: unknown[]) => ({
  about: `Native cases of golden.json ${list} (plan step 3b; generated by docs/plans/2026-11-15-self-hosted-rebuild/step-3b/convert-golden.ts, now edited here). index is the golden case's position.`,
  now: NOW, dropped: dropped.filter((d) => d.list === list), cases,
});
const out = path.join(web, "src/modules/evaluation");
writeFileSync(path.join(out, "evaluate.fixtures.json"), JSON.stringify(header("evaluate", evaluateCases), null, 1) + "\n");
writeFileSync(path.join(out, "recommendation.fixtures.json"), JSON.stringify(header("recommendation", recommendationCases), null, 1) + "\n");
console.log(`evaluate ${evaluateCases.length} carried, recommendation ${recommendationCases.length} carried, dropped ${dropped.length}, changed ${changed.length}`);
for (const d of dropped) console.log(`dropped ${d.list}/${d.index}: ${d.reason}`);
