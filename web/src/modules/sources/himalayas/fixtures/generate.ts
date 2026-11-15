// Writes cases.json from golden.json's himalayas_normalize and himalayas_fetch cases (plan step 5):
// the input is the golden payload as JSON, the expected output is the old system's job turned into
// the listing contract by legacyToInput, the step-10 conversion, so it is an oracle independent of
// the new connector. Deliberate differences are applied here, each with its reason, and nowhere else.
// Run once: pnpm exec tsx src/modules/sources/himalayas/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { PyDict, type PyValue } from "@/platform/py/value";
import { fixture, untag, type Expect, type Tagged } from "../../../../../tests/helpers/golden";

type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };
const plain = (v: PyValue): Plain =>
  typeof v === "bigint" ? Number(v) : Array.isArray(v) ? v.map(plain) : v instanceof PyDict ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v;

const base = {
  title: "AI agent backend engineer", description: "<p>Build AI agents and APIs</p>", employmentType: "Contractor",
  locationRestrictions: [], timezoneRestrictions: [], pubDate: 1789746632, expiryDate: 1893456000,
  applicationLink: "https://himalayas.app/companies/example/jobs/engineer", guid: "https://himalayas.app/companies/example/jobs/engineer",
} as Record<string, unknown>;
const key = (p: unknown) => JSON.stringify(p);
const v = (changes: Record<string, unknown>) => key({ ...base, ...changes });

/**
 * Old refusals plan D8 turns into an unknown (or as-given) field: the listing is kept. By the exact
 * payload, each checked by hand. `value` is the field's expected value (null unless given).
 */
const D8_UNKNOWN = new Map<string, { field: string; value?: unknown; why: string }>([
  // A time without an offset has no rule on this board; booleans, null, NaN (null in JSON), lists and text that is no time are unreadable.
  ...["2026-09-18T12:00:00", true, null, "bad", [1]].map((x) => [v({ pubDate: x }), { field: "published_at", why: "publication time unreadable or without offset" }] as const),
  // Deadlines take the contract's four shapes instead of refusing the listing.
  [v({ expiryDate: "bad" }), { field: "deadline", value: { kind: "invalid", text: "bad" }, why: "deadline text that is no time is kept as invalid" }],
  [v({ expiryDate: true }), { field: "deadline", value: { kind: "invalid", text: "true" }, why: "deadline of the wrong type is kept as invalid" }],
  [v({ expiryDate: "2027-01-01" }), { field: "deadline", value: { kind: "date", date: "2027-01-01" }, why: "a date-only deadline is the contract's date shape" }],
  // Country restrictions the connector cannot read leave Taiwan eligibility unknown.
  ...[[{}], [5], [""], ["  "], null, "US"].map((x) => [v({ locationRestrictions: x }), { field: "taiwan_eligible", why: "country restrictions unreadable" }] as const),
  // Offsets the connector cannot read leave timezone compatibility unknown (booleans, null, lists,
  // objects, inf/nan text, out of range, not a number; the int too large for a float
  // that golden holds becomes Infinity, which JSON writes as null, so the [null] entry covers it, not a list).
  ...[[true], [false], [null], [[8]], [{}], ["inf"], ["nan"], [14.0000001], ["abc"], null, 8]
    .map((x) => [v({ timezoneRestrictions: x }), { field: "timezone_compatible", why: "timezone restrictions unreadable" }] as const),
]);

/** Old results the new connector deliberately changes: the expected output is patched, with the reason. */
const PATCHED = new Map<string, { why: string; patch: Record<string, unknown> }>([
  // Python float() reads "1_4" as 14 (digit separators); decimal text without separators is the board's format, so this offset is unreadable (D8).
  [v({ timezoneRestrictions: ["1_4"] }), { why: "D8: offset text with a digit separator is unreadable", patch: { timezone_compatible: null } }],
]);

type Golden = {
  himalayas_normalize: { payload: Tagged; expect: Expect<string> }[];
  himalayas_fetch: { pages: Record<string, [number, string]>; expect: Expect<string[]> }[];
};
const golden = fixture<Golden>("golden.json");

const expected = (old: string) => {
  const job = JSON.parse(old) as Record<string, unknown>;
  return {
    ...legacyToInput("himalayas", job),
    // New: extra keeps only what the connector read and the contract has no field for (not the
    // receipt id, the received time, which is published_at, or the constant language).
    extra: { employment_types: job.employment_types, location_evidence: job.location_evidence, timezone_evidence: job.timezone_evidence },
  };
};

const used = new Set<string>();
const normalizeCases = golden.himalayas_normalize.map((c) => {
  const payload = plain(untag(c.payload)), k = key(payload);
  if ("error" in c.expect) {
    const d8 = D8_UNKNOWN.get(k);
    if (d8) return used.add(k), { payload, expect: { field: d8.field, value: d8.value ?? null }, why: `D8: ${d8.why}` };
    return { payload, expect: { error: true } };
  }
  const patched = PATCHED.get(k);
  if (patched) used.add(k);
  return { payload, expect: { ...expected(c.expect.ok), ...patched?.patch }, ...(patched ? { why: patched.why } : {}) };
});
const unused = [...D8_UNKNOWN.keys(), ...PATCHED.keys()].filter((k) => !used.has(k));
if (unused.length) throw new Error(`differences that match no golden case: ${unused.join("\n")}`);

// Fetch scenarios: the pages served, and the external ids the old fetch-then-normalize returned, or a failure.
// ACCEPTED: Python refuses an int literal of over 4300 digits (its int-to-string limit); JSON.parse
// reads it as a number, and it sits in a field the connector never reads.
const hugeInt = (c: Golden["himalayas_fetch"][number]) => Object.values(c.pages).some(([, body]) => /\d{4301,}/.test(body));
const fetchCases = golden.himalayas_fetch.map((c) => {
  if (hugeInt(c)) {
    if (!("error" in c.expect)) throw new Error("the huge-int scenario no longer fails in golden");
    return { pages: c.pages, expect: { ids: [] }, why: "ACCEPTED: an int past Python's 4300-digit limit in an unread field" };
  }
  return { pages: c.pages, expect: "error" in c.expect ? { error: true } : { ids: c.expect.ok.map((j) => (JSON.parse(j) as { external_id: string }).external_id) } };
});
if (fetchCases.filter((c) => "why" in c).length !== 1) throw new Error("expected exactly one huge-int scenario");

writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify({ normalize: normalizeCases, fetch: fetchCases }, null, 1) + "\n");
console.log(`${normalizeCases.length} normalize cases, ${fetchCases.length} fetch cases`);
