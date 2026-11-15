// Writes cases.json from golden.json's cryptojobslist_parse feeds (plan step 5a): the input is the
// golden RSS body, the expected output is the old system's jobs turned into the listing contract by
// legacyToInput, the step-10 conversion, so it is an oracle independent of the new connector.
// Deliberate differences are applied here, each with its reason, and nowhere else. golden.json is
// frozen, so a case is named by its index; each entry also asserts the old outcome it overrides.
// Run once: pnpm exec tsx src/modules/sources/cryptojobslist/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { fixture, type Expect } from "../../../../../tests/helpers/golden";

type Golden = { input: string; latin1?: boolean; expect: Expect<{ result: string; jobs: string[] }> };
const golden = fixture<{ cryptojobslist_parse: Golden[] }>("golden.json").cryptojobslist_parse;

const ACME = "https://cryptojobslist.com/jobs/backend-engineer-acme";

/**
 * SET_ASIDE: the old reader dropped one item for lacking its identity and kept the run as partial; the
 * new one does the same (Will 2026-11-15: set aside and count), so the expectation is the old result
 * with its rejected count. By golden index, with the old per-item error; each asserts the old outcome.
 */
const SET_ASIDE = new Map<number, string>([
  ...[17].map((i) => [i, "title or description shows no text"] as const),
  ...[18, 19, 22, 23, 25, 26, 88].map((i) => [i, "title or description missing or blank"] as const),
  ...[20, 21, 24].map((i) => [i, "title over 500 or description over 100,000 characters"] as const),
  ...[28, 98].map((i) => [i, "job link missing"] as const),
  ...[29, 30, 32, 33, 35, 36, 37, 38, 39, 40].map((i) => [i, "job link not https://cryptojobslist.com/jobs/<slug> as written"] as const),
  ...[47, 48].map((i) => [i, "media:canonical disagrees with the link or is not a job link"] as const),
]);

/** D8_UNKNOWN: old refusals of a field that is not identity; the new connector keeps the listing with the field unknown. */
const D8_UNKNOWN = new Map<number, { field: string; why: string }>([
  ...[78, 79, 80].map((i) => [i, { field: "published_at", why: "pubDate without a time zone (old: item dropped)" }] as const),
  [81, { field: "published_at", why: "pubDate unreadable (old: item dropped)" }],
  [84, { field: "published_at", why: "pubDate past year 9999 in UTC (old: OverflowError failed the feed)" }],
]);

/** ACCEPTED: old refusals the new connector accepts for another reason. */
const ACCEPTED = new Map<number, string>([
  // A tag link urlsplit could not split (unbalanced "[") dropped the item; a tag link is not identity, the new reader skips it.
  [11, "unsplittable tag link is skipped, not the item"],
]);

/** PATCHED: old results the new connector deliberately changes, by golden index; the expected listing is patched. */
const PATCHED = new Map<number, { why: string; patch: Record<string, unknown> }>([
  // shared/html.ts breaks words only at p, div, li and br (connector-checklist section 4); the old text also broke at h1-h3 and tr.
  [9, { why: "an h3 inside the text is no word break in shared/html.ts", patch: { description: "Tags: ha" } }],
  // An attribute written twice: HTML keeps the first (WHATWG tokenizer), Python's dict(attrs) kept the last.
  [12, { why: "duplicate href attribute: the first one counts, as in a browser", patch: { kind: "contract", extra: { employment_tags: ["part-time"], remote_evidence: true } } }],
]);

const collapse = (s: unknown) => (typeof s === "string" ? s.split(/\s+/u).filter(Boolean).join(" ") : s);

const cases = golden.map((c, i) => {
  const base = { index: i, input: c.input, ...(c.latin1 ? { latin1: true } : {}) };
  const setAside = SET_ASIDE.get(i), d8 = D8_UNKNOWN.get(i), accepted = ACCEPTED.get(i);
  const old = "ok" in c.expect ? { result: JSON.parse(c.expect.ok.result) as { seen: number; rejected_count: number }, jobs: c.expect.ok.jobs.map((j) => JSON.parse(j) as Record<string, unknown>) } : null;
  const overridden = setAside ?? d8 ?? accepted;
  if (overridden && (d8 && i === 84 ? old !== null : old?.result.rejected_count !== 1)) throw new Error(`case ${i}: old outcome is not the one overridden`);
  if (d8) return { ...base, expect: { seen: 1, unknown: { external_id: ACME, field: d8.field } }, why: `D8_UNKNOWN: ${d8.why}` };
  if (accepted) return { ...base, expect: { seen: 1, ids: [ACME] }, why: `ACCEPTED: ${accepted}` };
  if (!old) return { ...base, expect: { error: true } };
  if (old.result.rejected_count && !setAside) throw new Error(`case ${i}: unclassified old rejection`);
  return {
    ...base,
    expect: {
      seen: old.result.seen,
      listings: old.jobs.map((job) => ({
        ...legacyToInput("cryptojobslist", job),
        // PATCHED (every case): text comes from shared/html.ts, which joins the lines with spaces (old: newlines).
        title: collapse(job.title), description: collapse(job.description),
        // New: the board's location text is the listing's location (old kept it as location_evidence only).
        location: (job.location_evidence as string | null) || null,
        // New: extra keeps only what the connector read, the contract has no field for, and its own rule uses.
        extra: { employment_tags: job.employment_tags, remote_evidence: job.remote_evidence },
        ...PATCHED.get(i)?.patch,
      })),
      ...(setAside ? { rejected: old.result.rejected_count } : {}),
    },
    ...(PATCHED.has(i) ? { why: `PATCHED: ${PATCHED.get(i)!.why}` } : setAside ? { why: `SET_ASIDE: ${setAside}` } : {}),
  };
});
writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
console.log(`${cases.length} cases`);
