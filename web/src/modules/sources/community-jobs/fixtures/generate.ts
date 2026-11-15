// Writes cases.json from golden.json's hn_job, hn_fetch and v2ex_jobs cases (plan step 5a): the input
// is the golden payload (as JSON, or the feed and page bodies), the expected output is the old system's
// jobs turned into the listing contract by legacyToInput, the step-10 conversion, so it is an oracle
// independent of the new connector. Deliberate differences are applied here, each with its reason, and
// nowhere else. golden.json is frozen, so a case is named by its key and index; each entry also asserts
// the old outcome it overrides.
// Run once: pnpm exec tsx src/modules/sources/community-jobs/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { PyDict, type PyValue } from "@/platform/py/value";
import { fixture, untag, type Expect, type Tagged } from "../../../../../tests/helpers/golden";

type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };
const plain = (v: PyValue): Plain =>
  typeof v === "bigint" ? Number(v) : Array.isArray(v) ? v.map(plain) : v instanceof PyDict ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v;

type Pages = Record<string, [number, string]>;
const golden = fixture<{
  hn_job: { p: Tagged; parent: Tagged; expect: Expect<string | null> }[];
  hn_fetch: { pages: Pages; expect: Expect<string[]> }[];
  v2ex_jobs: { input: string; expect: Expect<string[]> }[];
}>("golden.json");

type Old = "error" | "skip" | "ok";
type Override = { old: Old; expect: Record<string, unknown>; why: string };

/** Deliberate differences, by golden key and index (category: reason). */
const OVERRIDES: Record<"hn_job" | "hn_fetch" | "v2ex_jobs", Map<number, Override>> = {
  hn_job: new Map<number, Override>([
    // D8_UNKNOWN: a comment time that is not whole seconds, missing, or past year 9999 failed the old run; the time is not identity.
    ...[17, 18, 19, 20].map((i) => [i, { old: "error", expect: { unknown: "published_at" }, why: "D8_UNKNOWN: comment time unreadable" }] as const),
    // REFUSED: an id past 2^53 cannot be held exactly by a JSON number in JavaScript; refusing keeps external_id exact. HN ids are under 10^8.
    [137, { old: "ok", expect: { error: true }, why: "REFUSED: id past Number.MAX_SAFE_INTEGER" }],
  ]),
  hn_fetch: new Map<number, Override>([
    // ACCEPTED: Python told the float 11.0 from the int 11; a JSON number in JavaScript cannot, and 11.0 names comment 11.
    [29, { old: "error", expect: { listing: true }, why: "ACCEPTED: JSON has one number type: id 11.0 is comment 11" }],
  ]),
  v2ex_jobs: new Map(),
};

const EXTRA: Record<string, string[]> = { hackernews: ["thread_id"], v2ex: ["body_available"] };
const listing = (source: string, json: string) => {
  const job = JSON.parse(json) as Record<string, unknown>;
  // New: extra keeps only what the connector read and the contract has no field for (not receipt ids, constant evidence or language).
  return { ...legacyToInput(source, job), extra: Object.fromEntries(EXTRA[source].map((k) => [k, job[k]])) };
};
/** A list of old jobs as the connector returns it: every lead counted, a lead listed twice kept once as its last entry. */
const collected = (source: string, jobs: string[]) => {
  const all = jobs.map((j) => listing(source, j));
  return { seen: all.length, listings: [...new Map(all.map((l) => [l.external_id, l])).values()] };
};

function apply<T>(key: keyof typeof OVERRIDES, i: number, old: Old, base: T, normal: Record<string, unknown>) {
  const o = OVERRIDES[key].get(i);
  if (!o) return { ...base, expect: normal };
  if (o.old !== old) throw new Error(`${key} ${i}: old outcome is ${old}, not the overridden ${o.old}`);
  return { ...base, expect: o.expect, why: o.why };
}
const outcome = (e: Expect<unknown>): Old => ("error" in e ? "error" : e.ok === null ? "skip" : "ok");

const cases = {
  hn_job: golden.hn_job.map((c, i) => apply("hn_job", i, outcome(c.expect), { index: i, p: plain(untag(c.p)), parent: plain(untag(c.parent)) },
    "error" in c.expect ? { error: true } : c.expect.ok === null ? { skip: true } : listing("hackernews", c.expect.ok))),
  hn_fetch: golden.hn_fetch.map((c, i) => apply("hn_fetch", i, outcome(c.expect), { index: i, pages: c.pages },
    "error" in c.expect ? { error: true } : collected("hackernews", c.expect.ok))),
  v2ex_jobs: golden.v2ex_jobs.map((c, i) => apply("v2ex_jobs", i, outcome(c.expect), { index: i, input: c.input },
    "error" in c.expect ? { error: true } : collected("v2ex", c.expect.ok))),
};
writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
console.log(Object.entries(cases).map(([k, v]) => `${k}: ${v.length}`).join(", "));
