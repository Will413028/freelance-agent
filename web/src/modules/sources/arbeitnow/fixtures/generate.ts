// Writes cases.json from golden.json's arbeitnow cases (plan step 5, connector checklist section 4):
// - normalize: the input is the golden entry as JSON, the expected output is the old system's job turned
//   into the listing contract by legacyToInput (the step-10 conversion), an oracle independent of the
//   new connector;
// - page: the golden page body and page number, expected the old listing count, ids and next page;
// - scan: the golden responses per URL, expected the old seen count, ids and requested URLs.
// Deliberate differences are listed here, each with its reason, and nowhere else.
// Run once: pnpm exec tsx src/modules/sources/arbeitnow/fixtures/generate.ts
import { pageShapeOk } from "..";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { PyDict, type PyValue } from "@/platform/py/value";
import { fixture, untag, type Expect, type Tagged } from "../../../../../tests/helpers/golden";

type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };
const plain = (v: PyValue): Plain =>
  typeof v === "bigint" ? Number(v) : Array.isArray(v) ? v.map(plain) : v instanceof PyDict ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v;
const key = (p: unknown) => JSON.stringify(p);

const golden = fixture<{
  arbeitnow_normalize: { entry: Tagged; expect: Expect<string> }[];
  arbeitnow_batch: { input: string; page: number; expect: Expect<{ jobs: string[]; rejected: number; next: string | null }> }[];
  arbeitnow_scan: { pages: Record<string, [number, string]>; kw: Record<string, unknown>; ticks: number[] | null; expect: Expect<string>; calls: [string, number][] }[];
}>("golden.json");
const base = plain(untag(golden.arbeitnow_normalize[0].entry)) as Record<string, Plain>;

/** Old refusals plan D8 turns into an unknown field: the listing is kept with that field null. */
const D8_UNKNOWN = new Map<string, { field: string; why: string }>([
  [key({ ...base, location: 5 }), { field: "location", why: "location not text" }],
]);

/** Old refusals the new connector accepts for another reason. */
const ACCEPTED = new Map<string, string>([
  // Python told the float 1790000000.0 from the int; a JSON number in JavaScript cannot.
  [key({ ...base, created_at: 1790000000 }), "JSON has one number type: created_at 1790000000.0 is second 1790000000"],
]);
/** Pages (by golden index) the old refused and the new accepts. */
const ACCEPTED_PAGES = new Map<number, string>([
  [11, "JSON has one number type: current_page 1.0 is page 1"],
]);

/** Scan cases (by golden index) the old marked inconsistent and the new accepts. */
const ACCEPTED_SCAN = new Map<number, string>([
  [20, "JSON has one number type: per_page 1.0 is 1"],
  [21, "JSON has one number type: from 1.0 is 1"],
  // Old refused a listing met again with other content ("Listing changed during pagination"); the board updates
  // while it is read, so the last read is kept (Will 2026-11-15, plan D6).
  [3, "a listing changed during pagination is kept as last read (Will 2026-11-15)"],
]);

/** Old results the new connector deliberately changes: the expected output is patched, with the reason. */
const PATCHED = new Map<string, { why: string; patch: (e: Record<string, unknown>) => Record<string, unknown> }>([
  // Whitespace is JavaScript's \s, which holds the BOM; Python's str.split() did not (accepted, step 4 review, shared/html.test.ts).
  [key({ ...base, description: '<p>Build an AI agent and API.</p><p>Find more <a href="https://www.arbeitnow.com/english-speaking-jobs">English Speaking Jobs in Germany</a> on Arbeitnow</a>\ufeff' }),
    { why: "BOM is whitespace in JavaScript", patch: (e) => ({ description: (e.description as string).replace(/\s*\ufeff$/u, "") }) }],
]);

/**
 * Old results the new connector refuses: the old connector finished a scan with inconsistent pagination
 * and marked the run failed; the new one fails the whole run and writes nothing. A row the old connector
 * set aside (rejected > 0) is set aside and counted by the new one too (Will 2026-11-15), so those cases
 * carry the old result and its rejected count. (A scan cut short by the page cap is written and marked
 * truncated, as the old partial run was; no case here reaches the fixed cap.)
 */
const REFUSED_PAGE = new Map<number, string>([
  [37, "body not UTF-8: the official API sends UTF-8, Python's json also read UTF-16/32"],
]);
const SET_ASIDE = "SET_ASIDE: old set rows aside (rejected > 0); the new connector does the same";
const CROSS_PAGE_ONLY = "old flagged only cross-page meta and still wrote these listings; the real API's meta is per page and wrong as a range (VM 2026-11-15), so it is no longer compared across pages";
/**
 * Whether an old inconsistent scan failed only on cross-page meta (from/to, per_page changing, a short page with a next link): every page answers 200 and parses
 * as an object, and passes the connector's own shape rule (pageShapeOk, one definition). per_page is
 * read from the raw JSON text so that a float like 2.0, which Python's int check refused, does not count.
 */
function crossPageOnly(pages: Record<string, [number, string]>): boolean {
  for (const [status, body] of Object.values(pages)) {
    if (status !== 200) return false;
    let p: { data?: unknown[]; meta?: { per_page?: unknown } };
    try { p = JSON.parse(body); } catch { return false; }
    // meta's own per_page as written: an integer literal, as Python's int check required (a float like 2.0 does not count).
    if (!/"meta"\s*:\s*\{[^{}]*"per_page"\s*:\s*\d+\s*[,}]/.test(body)) return false;
    const count = Array.isArray(p.data) ? p.data.length : -1;
    if (count < 0 || !pageShapeOk(p.meta?.per_page, count)) return false;
  }
  return true;
}
const INCOMPLETE_SCAN = "old scan had inconsistent pagination and marked the run failed; new fails the run";
/** Old scan cases that exercise the old scan options (max_pages, max_seconds, the monotonic clock), which the new connector has no counterpart for: the Fetcher bounds each request, the page cap is fixed. */
const NOT_APPLICABLE = "old scan options or time budget, replaced by the Fetcher's per-request timeout and the fixed page cap";

const normalize = golden.arbeitnow_normalize.map((c) => {
  const payload = plain(untag(c.entry));
  if ("error" in c.expect) {
    const d8 = D8_UNKNOWN.get(key(payload)), accepted = ACCEPTED.get(key(payload));
    if (d8) return { payload, expect: { unknown: d8.field }, why: `D8: ${d8.why}` };
    if (accepted) return { payload, expect: { listing: true }, why: accepted };
    return { payload, expect: { error: true } };
  }
  const job = JSON.parse(c.expect.ok) as Record<string, unknown>;
  const input = legacyToInput("arbeitnow", job), patched = PATCHED.get(key(payload));
  return {
    payload,
    ...(patched ? { why: patched.why } : {}),
    expect: {
      ...input,
      ...patched?.patch(input),
      // New: the board's location text is the listing's location (old kept it as location_evidence only).
      location: (job.location_evidence as string) || null,
      // New: extra keeps only what the connector read and the contract has no field for.
      extra: { employment_types: job.employment_types, remote_evidence: job.remote_evidence },
    },
  };
});

const page = golden.arbeitnow_batch.map((c, i) => {
  const input = { body: c.input, page: c.page };
  if (REFUSED_PAGE.has(i)) return { input, expect: { error: true }, why: REFUSED_PAGE.get(i) };
  if ("error" in c.expect) {
    if (ACCEPTED_PAGES.has(i)) return { input, expect: { listing: true }, why: ACCEPTED_PAGES.get(i) };
    return { input, expect: { error: true } };
  }
  const ids = c.expect.ok.jobs.map((j) => (JSON.parse(j) as { external_id: string }).external_id);
  const rejected = c.expect.ok.rejected;
  // count is every entry on the page, kept or set aside.
  return { input, expect: { count: ids.length + rejected, ids, next: c.expect.ok.next, ...(rejected > 0 ? { rejected } : {}) }, ...(rejected > 0 ? { why: SET_ASIDE } : {}) };
});

type ScanCase = { input: Record<string, [number, string]>; expect: Record<string, unknown>; why?: string };
const scan = golden.arbeitnow_scan.flatMap((c, i): ScanCase[] => {
  if (Object.keys(c.kw).length || c.ticks !== null) return [];
  const input = c.pages;
  if (ACCEPTED_SCAN.has(i)) return [{ input, expect: { listing: true }, why: ACCEPTED_SCAN.get(i) }];
  if ("error" in c.expect) return [{ input, expect: { error: true } }];
  const [jobs, coverage] = JSON.parse(c.expect.ok) as [{ external_id: string }[], { seen: number; complete_scan: boolean; rejected_count: number; pagination_consistent: boolean; truncated: boolean }];
  if (!coverage.pagination_consistent && !crossPageOnly(input)) return [{ input, expect: { error: true }, why: INCOMPLETE_SCAN }];
  const range = !coverage.pagination_consistent;
  if (coverage.truncated) throw new Error(`scan ${i}: truncated old scan, no counterpart at the fixed cap`);
  const rejected = coverage.rejected_count;
  const why = [rejected > 0 ? SET_ASIDE : null, range ? CROSS_PAGE_ONLY : null].filter(Boolean).join("; ");
  return [{ input, expect: { seen: coverage.seen, ids: jobs.map((j) => j.external_id), requests: c.calls.map(([u]) => u), ...(rejected > 0 ? { rejected } : {}) }, ...(why ? { why } : {})}];
});
const skipped = golden.arbeitnow_scan.length - scan.length;

writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify({ normalize, page, scan, skipped_scan: { count: skipped, why: NOT_APPLICABLE } }, null, 1) + "\n");
console.log(`normalize ${normalize.length}, page ${page.length}, scan ${scan.length} (${skipped} not applicable)`);
