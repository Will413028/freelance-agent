// Writes cases.json from golden.json's getonboard_normalize, getonboard_modalities and
// getonboard_fetch cases (plan step 5): the input is the golden payload as JSON, the expected output
// is the old system's job turned into the listing contract by legacyToInput, the step-10 conversion,
// so it is an oracle independent of the new connector. Deliberate differences are applied here, each
// with its reason, and nowhere else.
// Run once: pnpm exec tsx src/modules/sources/getonboard/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { PyDict, type PyValue } from "@/platform/py/value";
import { fixture, untag, type Expect, type Tagged } from "../../../../../tests/helpers/golden";

type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };
const plain = (v: PyValue): Plain =>
  typeof v === "bigint" ? Number(v) : Array.isArray(v) ? v.map(plain) : v instanceof PyDict ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v;

const attrs = {
  title: "Part time AI agent backend engineer", description: "<p>Build an AI agent and API.</p>", modality: { data: { id: 42 } },
  remote: true, remote_modality: "fully_remote", countries: ["Remote"], published_at: 1789746632, category_name: "Programming",
  lang: "en", min_salary: 1000, max_salary: 2000,
} as Record<string, unknown>;
const key = (p: unknown) => JSON.stringify(p);
const v = (changes: Record<string, unknown>) =>
  key({ id: "acme-ai-agent", attributes: { ...attrs, ...changes }, links: { public_url: "https://www.getonbrd.com/jobs/acme-ai-agent" } });

/** Old refusals plan D8 turns into an unknown field: the listing is kept with that field null. By the exact payload, each checked by hand. */
const D8_UNKNOWN = new Map<string, { field: string; why: string }>([
  // Countries only feed the location text; the old connector refused a listing whose countries were not a list of text.
  ...[null, [5], "Chile"].map((x) => [v({ countries: x }), { field: "location", why: "countries not a list of text" }] as const),
]);

/** Old refusals the new connector accepts for another reason. */
const ACCEPTED = new Map<string, string>([
  // Python told the float 1500000000.0 from an int; a JSON number in JavaScript cannot, and 1500000000.0 is that second.
  [v({ published_at: 1500000000 }), "JSON has one number type: 1500000000.0 is the epoch second 1500000000"],
]);

/** Old results the new connector refuses. */
const REFUSED = new Map<string, string>([
  // The old fetch looked up str(None) for a missing modality id, which golden's test taxonomy maps; the
  // real taxonomy has no such key, and the source's own rule reads the modality, so the batch fails.
  [v({ modality: {} }), "missing modality id: the source's own rule cannot read the employment type"],
]);

/** Old results the new connector deliberately changes: the expected output is patched, with the reason. */
const PATCHED = new Map<string, { why: string; patch: Record<string, unknown> }>([]);

type FetchExpect = { result: string; jobs: string[] };
type Golden = {
  getonboard_normalize: { item: Tagged; expect: Expect<string> }[];
  getonboard_modalities: Tagged;
  getonboard_fetch: { pages: Record<string, [number, string]>; expect: Expect<FetchExpect> }[];
};
const golden = fixture<Golden>("golden.json");

const expected = (old: string) => {
  const job = JSON.parse(old) as Record<string, unknown>;
  return {
    ...legacyToInput("getonboard", job),
    // New: the board's countries are the listing's location text (old kept them as location_evidence only).
    location: (job.location_evidence as string[]).join(", ") || null,
    // New: extra keeps only what the connector read and the contract has no field for (not the
    // receipt id, received_at (= published_at), the constant attribution or body_available).
    extra: {
      employment_evidence: job.employment_evidence, remote_evidence: job.remote_evidence, remote_modality: job.remote_modality,
      location_evidence: job.location_evidence, category_evidence: job.category_evidence, salary_evidence: job.salary_evidence, language: job.language,
    },
  };
};

const used = new Set<string>();
const normalizeCases = golden.getonboard_normalize.map((c) => {
  const item = plain(untag(c.item)), k = key(item);
  if ("error" in c.expect) {
    const d8 = D8_UNKNOWN.get(k), accepted = ACCEPTED.get(k);
    if (d8) return used.add(k), { item, expect: { unknown: d8.field }, why: `D8: ${d8.why}` };
    if (accepted) return used.add(k), { item, expect: { listing: true }, why: `ACCEPTED: ${accepted}` };
    return { item, expect: { error: true } };
  }
  const refused = REFUSED.get(k);
  if (refused) return used.add(k), { item, expect: { error: true }, why: `REFUSED: ${refused}` };
  const patched = PATCHED.get(k);
  if (patched) used.add(k);
  return { item, expect: { ...expected(c.expect.ok), ...patched?.patch }, ...(patched ? { why: patched.why } : {}) };
});
const unused = [...D8_UNKNOWN.keys(), ...ACCEPTED.keys(), ...REFUSED.keys(), ...PATCHED.keys()].filter((k) => !used.has(k));
if (unused.length) throw new Error(`differences that match no golden case: ${unused.join("\n")}`);

// Fetch scenarios: the pages served and what the old fetch read (seen, pages, truncated, the ids
// kept), or a failure. REFUSED: where the old fetch skipped listings it could not read (rejected_count
// > 0, the run marked partial), the new connector fails the batch (connector checklist section 2).
const MODALITIES_URL = "https://www.getonbrd.com/api/v0/modalities?per_page=120&page=1";
const SEARCH_1 = "https://www.getonbrd.com/api/v0/search/jobs?remote=true&per_page=120&page=1";
/** Fetch scenarios whose old result the new connector deliberately changes, by the exact page body. */
const FETCH_DIFFERENCES: { url: string; body: string; expect: Record<string, unknown>; why: string }[] = [
  // Python's `True == 1` let a boolean total_pages pass as a complete taxonomy; it is no page count.
  { url: MODALITIES_URL, body: '{"data": [{"id": 42, "attributes": {"locale_key": "part_time"}}], "meta": {"total_pages": true}}', expect: { error: true },
    why: "REFUSED: a boolean total_pages is no page count" },
  // Python told the float 1.0 from the int 1; a JSON number in JavaScript cannot, and 1.0 pages is one page.
  { url: SEARCH_1, body: '{"data": [], "meta": {"page": 1, "total_pages": 1.0}}', expect: { seen: 0, ids: [], pages: 1, truncated: false },
    why: "ACCEPTED: JSON has one number type: total_pages 1.0 is 1" },
];
const usedFetch = new Set<number>();
const fetchCases = golden.getonboard_fetch.map((c) => {
  const i = FETCH_DIFFERENCES.findIndex((d) => c.pages[d.url]?.[1] === d.body);
  if (i >= 0) return usedFetch.add(i), { pages: c.pages, expect: FETCH_DIFFERENCES[i].expect, why: FETCH_DIFFERENCES[i].why };
  if ("error" in c.expect) return { pages: c.pages, expect: { error: true } };
  const r = JSON.parse(c.expect.ok.result) as { seen: number; rejected_count: number; pages: number; truncated: boolean };
  if (r.rejected_count > 0) return { pages: c.pages, expect: { error: true }, why: `REFUSED: the old fetch skipped ${r.rejected_count} unreadable listing(s)` };
  const ids = c.expect.ok.jobs.map((j) => (JSON.parse(j) as { external_id: string }).external_id);
  return { pages: c.pages, expect: { seen: r.seen, ids, pages: r.pages, truncated: r.truncated } };
});

if (usedFetch.size !== FETCH_DIFFERENCES.length) throw new Error("a fetch difference matches no golden scenario");

writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify({
  modalities: plain(untag(golden.getonboard_modalities)), normalize: normalizeCases, fetch: fetchCases,
}, null, 1) + "\n");
console.log(`${normalizeCases.length} normalize cases, ${fetchCases.length} fetch cases (${fetchCases.filter((c) => "why" in c).length} with a deliberate difference)`);
