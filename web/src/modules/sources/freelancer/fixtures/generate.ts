// Writes cases.json from golden.json's freelancer_normalize and freelancer_search cases and the
// b4_re cases of the two title patterns (plan step 5, connector-checklist.md section 4): the input is
// the golden payload as JSON, the expected output is the old system's job turned into the listing
// contract by legacyToInput, so it is an oracle independent of the new connector. Deliberate
// differences are classified here, each with its reason, and nowhere else.
// Run once: pnpm exec tsx src/modules/sources/freelancer/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { loadsBytes } from "@/platform/http";
import { isDict, PyDict, type PyValue } from "@/platform/py/value";
import { fixture, untag, type Expect, type Tagged } from "../../../../../tests/helpers/golden";

type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };
// NaN and infinities have no JSON form; they are written as null (both old and new read them as invalid).
const plain = (v: PyValue): Plain =>
  typeof v === "bigint" ? Number(v) : typeof v === "number" && !Number.isFinite(v) ? null
  : Array.isArray(v) ? v.map(plain) : v instanceof PyDict ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v;

const at = (p: PyValue, k: string): PyValue | undefined => (isDict(p) && p.has(k) ? p.at(k) : undefined);
const truthy = (v: PyValue | undefined) => !(v === undefined || v === null || v === false || v === 0n || v === 0 || v === "" || (Array.isArray(v) && !v.length) || (isDict(v) && !v.size));
const len = (s: string) => [...s].length;

/**
 * The old checks (collection/sources/freelancer.ts:30-48) that stay refusals of the whole batch:
 * identity, active public status, title, description, the project's own URL. JSON has one number
 * type, so an id the old code refused only for being a float with an integral value is a valid id now
 * (ACCEPTED below); a non-integral or past-2^53 id stays refused.
 */
function identityRefusal(p: PyValue): string | null {
  if (!isDict(p)) return "not an object";
  const id = at(p, "id");
  const intLike = typeof id === "bigint" || (typeof id === "number" && Number.isInteger(id));
  if (!intLike || Number(id) <= 0 || !Number.isSafeInteger(Number(id))) return "id";
  if (at(p, "status") !== "active" || truthy(at(p, "deleted")) || truthy(at(p, "nonpublic"))) return "status";
  const t = at(p, "title"), d = at(p, "description");
  if (typeof t !== "string" || len(t) < 1 || len(t) > 500 || typeof d !== "string" || len(d) < 1 || len(d) > 50_000) return "title or description";
  const slug = at(p, "seo_url");
  if (typeof slug !== "string" || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(slug)) return "project URL";
  return null;
}

/** The old non-identity refusals (time_updated, currency, budget, type), in their order: plan D8 makes each field unknown. */
function d8Field(p: PyDict): { field: string; why: string } {
  const num = (v: PyValue | undefined) => (typeof v === "bigint" && Math.abs(Number(v)) < 2 ** 1023) || (typeof v === "number" && Number.isFinite(v));
  const stamp = at(p, "time_updated");
  if (!num(stamp) || Number(stamp) <= 0 || Number(stamp) * 1000 > 253402300799999) return { field: "time_updated", why: "update time unreadable" };
  const cur = at(p, "currency"), code = cur === undefined ? undefined : at(cur, "code");
  if (cur !== undefined && !isDict(cur)) return { field: "currency", why: "currency not an object" };
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) return { field: "currency", why: "currency code unreadable" };
  const budget = at(p, "budget");
  if (budget !== undefined && !isDict(budget)) return { field: "budget_min", why: "budget not an object" };
  return at(p, "type") === "fixed" || at(p, "type") === "hourly" ? { field: "budget_min", why: "budget amount or range unreadable" } : { field: "kind", why: "unknown project type" };
}

/** Old results the new connector refuses. */
const REFUSED = (p: PyValue) => (identityRefusal(p) === "id" ? "id past Number.MAX_SAFE_INTEGER: a JSON number in JavaScript cannot hold it exactly" : null);

// New: extra keeps only what the connector read and the contract has no field for (old receipt_id,
// received_at and the constant language are not carried; time_updated is kept as an instant).
const extraOf = (p: Plain) => {
  const o = p as Record<string, Plain>, s = o.time_updated;
  return { time_updated: typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : null, project_type: typeof o.type === "string" ? o.type : null };
};
const expected = (job: Record<string, unknown>, payload: Plain) => ({ ...legacyToInput("freelancer", job), extra: extraOf(payload) });

const golden = fixture<{
  freelancer_normalize: { project: Tagged; expect: Expect<string> }[];
  freelancer_search: { query: string; pages: Record<string, [number, string]>; kw: Tagged; ticks: number[] | null; expect: Expect<string>; calls: [string, number][] }[];
  b4_re: { pattern: string; ignorecase: boolean; input: string; expect: unknown }[];
}>("golden.json");

const normalize = golden.freelancer_normalize.map((c) => {
  const raw = untag(c.project), payload = plain(raw);
  if ("error" in c.expect) {
    const refusal = identityRefusal(raw);
    if (refusal) return { payload, expect: { error: true } };
    const id = at(raw, "id");
    if (typeof id === "number") return { payload, expect: { listing: true }, why: "ACCEPTED: JSON has one number type, id 42.0 is project 42" };
    const d8 = d8Field(raw as PyDict);
    return { payload, expect: { unknown: d8.field }, why: `D8_UNKNOWN: ${d8.why}` };
  }
  const refused = REFUSED(raw);
  if (refused) return { payload, expect: { error: true }, why: `REFUSED: ${refused}` };
  const job = JSON.parse(c.expect.ok) as Record<string, unknown>;
  // PATCHED: a budget bound past 2^53 is not held exactly by a JavaScript number (two different bounds
  // can read as one), so the connector writes both bounds unknown; the old kept the Python int.
  const inexact = [job.budget_min, job.budget_max].some((v) => typeof v === "number" && v > Number.MAX_SAFE_INTEGER);
  if (inexact) return { payload, expect: { ...expected(job, payload), budget_min: null, budget_max: null }, why: "PATCHED: budget bound past Number.MAX_SAFE_INTEGER is unknown" };
  return { payload, expect: expected(job, payload) };
});

/**
 * Search cases. Not ported: the old search's argument validation (the connector passes constants)
 * and its wall-clock deadline (max_seconds; the new connector is bounded by its page cap and the
 * Fetcher's per-run request cap instead).
 */
const NOT_PORTED = (kw: PyDict, query: string) =>
  query !== "AI agent" && query !== "API integration" && query !== "MVP web development" ? "query outside the fixed three"
  : kw.has("max_seconds") ? "wall-clock deadline (max_seconds) dropped"
  : (kw.has("limit") && !(Number(kw.at("limit")) >= 1 && Number(kw.at("limit")) <= 100)) || (kw.has("max_pages") && Number(kw.at("max_pages")) < 1) ? "argument validation"
  : null;
type SearchCase = { query: string; limit: number; maxPages: number; pages: Record<string, [number, string]>; urls: string[]; expect: unknown; why?: string };
const search = golden.freelancer_search.flatMap((c): SearchCase[] => {
  const kw = untag(c.kw) as PyDict;
  const skip = NOT_PORTED(kw, c.query);
  if (skip) return [];
  const limit = kw.has("limit") ? Number(kw.at("limit")) : 20, maxPages = kw.has("max_pages") ? Number(kw.at("max_pages")) : 20;
  const base = { query: c.query, limit, maxPages, pages: c.pages, urls: c.calls.map(([u]) => u) };
  const projects = new Map<string, Plain[]>(), refused: PyValue[] = [];
  let floatTotal = false;
  for (const url of c.calls.map(([u]) => u)) {
    const [, body] = c.pages[url] ?? [0, ""];
    let data: PyValue;
    try {
      data = loadsBytes(new Uint8Array(Buffer.from(body, "latin1")));
    } catch {
      continue;
    }
    const list = at(at(data, "result") ?? null, "projects"), total = at(at(data, "result") ?? null, "total_count");
    if (typeof total === "number" && Number.isInteger(total)) floatTotal = true;
    for (const raw of Array.isArray(list) ? list : []) {
      const id = String(plain(at(raw, "id") ?? null));
      projects.set(id, [...(projects.get(id) ?? []), plain(raw)]);
      if (identityRefusal(raw) !== null || (isDict(raw) && typeof at(raw, "id") !== "bigint")) refused.push(raw);
    }
  }
  if ("error" in c.expect) {
    // Python told the float 1.0 from the int 1 in total_count; a JSON number in JavaScript cannot.
    if (floatTotal) return [{ ...base, expect: { ids: [...projects.keys()].sort() }, why: "ACCEPTED: JSON has one number type, total_count 1.0 is 1" }];
    return [{ ...base, expect: { error: true } }];
  }
  const out = JSON.parse(c.expect.ok) as { jobs: Record<string, unknown>[]; rejected_count: number };
  // The project version the old search kept: the one whose update time is the job's received_at.
  const versionOf = (j: Record<string, unknown>) =>
    projects.get(j.external_id as string)!.find((p) => extraOf(p).time_updated === new Date(j.received_at as string).toISOString())!;
  const listings = out.jobs.map((j) => expected(j, versionOf(j)));
  if (out.rejected_count === 0) return [{ ...base, expect: { listings } }];
  // Old per-project refusals made the run partial. A refusal of identity fails the batch now
  // (checklist section 2); a refusal of another field only makes that field unknown (plan D8), so the
  // project is kept: the expected ids are the old ones plus those projects.
  if (refused.some((r) => identityRefusal(r) !== null)) return [{ ...base, expect: { error: true }, why: "REFUSED: a project without identity fails the batch (old: rejected_count, partial run)" }];
  const kept = new Set(out.jobs.map((j) => j.external_id as string));
  for (const [id] of projects) kept.add(id);
  return [{ ...base, expect: { ids: [...kept].sort() }, why: "D8_UNKNOWN: the old refused project is kept with its unreadable fields unknown" }];
});

const PATTERNS = ["TITLE_SIGNAL", "OUT_OF_SCOPE"] as const;
const regex = golden.b4_re.filter((c) => c.pattern.startsWith(String.raw`\b(?:ai|`) || c.pattern.startsWith(String.raw`\b(?:copywriting`))
  .map((c) => ({ pattern: PATTERNS[c.pattern.startsWith(String.raw`\b(?:ai|`) ? 0 : 1], input: c.input, match: c.expect !== null }));

writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify({ normalize, search, regex }, null, 1) + "\n");
console.log(`${normalize.length} normalize, ${search.length} search (of ${golden.freelancer_search.length}), ${regex.length} regex cases`);
