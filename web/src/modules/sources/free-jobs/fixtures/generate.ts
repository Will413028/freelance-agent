// Writes cases.json from golden.json's free_jobs_normalize cases (plan step 4): the input is the
// golden payload as JSON, the expected output is the old system's job turned into the listing
// contract by legacyToInput, the step-10 conversion, so it is an oracle independent of the new
// connector. Deliberate differences are applied here, each with its reason, and nowhere else.
// Run once: pnpm tsx src/modules/sources/free-jobs/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { PyDict, type PyValue } from "@/platform/py/value";
import { fixture, untag, type Expect, type Tagged } from "../../../../../tests/helpers/golden";

type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };
const plain = (v: PyValue): Plain =>
  typeof v === "bigint" ? Number(v) : Array.isArray(v) ? v.map(plain) : v instanceof PyDict ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v;

const base = { id: 1, url: "https://remotive.com/remote-jobs/software-dev/backend-1", title: "Backend API engineer", description: "<p>Build an API</p>",
  job_type: "part_time", publication_date: "2026-09-18T12:00:00", candidate_required_location: "Worldwide" };
const jobicy = { id: 2, url: "https://jobicy.com/jobs/2-python", jobTitle: "Python API", jobDescription: "<p>API</p>", jobType: ["contract"],
  jobGeo: "Anywhere", pubDate: "2026-09-18T12:00:00+00:00", salaryMin: 100000, salaryPeriod: "yearly" };
const key = (p: unknown) => JSON.stringify(p);

/**
 * Old refusals plan D8 turns into an unknown field: the listing is kept with that field null. By the
 * exact payload, each checked by hand.
 */
const D8_UNKNOWN = new Map<string, { field: string; why: string }>([
  ...[5, true].map((v) => [key({ ...base, candidate_required_location: v }), { field: "location", why: "geography not text" }] as const),
  ...["bad", null, "ZZ", 20260918].map((v) => [key({ ...base, publication_date: v }), { field: "published_at", why: "publication time unreadable" }] as const),
]);

/** Old refusals the new connector accepts for another reason. */
const ACCEPTED = new Map<string, string>([
  // Python told the float 1.0 from the int 1; a JSON number in JavaScript cannot, and 1.0 names listing 1.
  [key(base), "JSON has one number type: id 1.0 is listing 1"],
]);

/** Old results the new connector deliberately changes: the expected output is patched, with the reason. */
const PATCHED = new Map<string, { why: string; patch: Record<string, unknown> }>([
  // Python 3.13 and V8 lower-case with different Unicode versions; only unknown type labels are affected, kind stays null.
  [key({ ...base, job_type: "\u1c89\ua7cb\ua7dc" }), { why: "Unicode lower-casing version", patch: { extra: { employment_types: ["\u1c89\ua7cb\ua7dc".toLowerCase()], publication_evidence: "2026-09-18T12:00:00" } } }],
]);

/** Old results the new connector refuses. */
const REFUSED = new Map<string, string>([
  // An id past 2^53 cannot be held exactly by a JSON number in JavaScript; refusing keeps external_id exact. The boards' ids are under 10^7.
  [key({ ...base, id: 1180591620717411303424 }), "id past Number.MAX_SAFE_INTEGER"],
]);

const golden = fixture<{ free_jobs_normalize: { source: string; payload: Tagged; expect: Expect<{ job: string }> }[] }>("golden.json");
const cases = golden.free_jobs_normalize.filter((c) => c.source !== "nope").map((c) => {
  const payload = plain(untag(c.payload));
  if ("error" in c.expect) {
    const d8 = D8_UNKNOWN.get(key(payload)), accepted = ACCEPTED.get(key(payload));
    if (d8) return { source: c.source, payload, expect: { unknown: d8.field }, why: `D8: ${d8.why}` };
    if (accepted) return { source: c.source, payload, expect: { listing: true }, why: accepted };
    return { source: c.source, payload, expect: { error: true } };
  }
  const refused = REFUSED.get(key(payload));
  if (refused) return { source: c.source, payload, expect: { error: true }, why: refused };
  const job = JSON.parse(c.expect.ok.job) as Record<string, unknown>;
  const patched = PATCHED.get(key(payload));
  const input = legacyToInput(c.source, job);
  return {
    source: c.source, payload,
    expect: {
      ...input,
      // New: the board's location text is the listing's location (old kept it as location_evidence only).
      location: (job.location_evidence as string) || null,
      // New: extra keeps only what the connector read and the contract has no field for.
      extra: { employment_types: job.employment_types, publication_evidence: job.publication_evidence },
      ...patched?.patch,
    },
    ...(patched ? { why: patched.why } : {}),
  };
});
writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
console.log(`${cases.length} cases`);
