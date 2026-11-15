// Writes cases.json from golden.json's public_feeds_normalize entries and public_feeds_batch feeds
// (plan step 5b). The input is the golden entry (as JSON text) or feed body; the expected output is
// the old system's job turned into the listing contract by `oldToInput` below, a direct mapping of the
// old fields that does not call the new connector, so it is an independent oracle. (legacyToInput, which
// step 5a used, was deleted in step 5a2 with D10; the mapping here is the part of it these feeds need.)
// Deliberate differences are listed below by golden index, each with its reason, and applied nowhere
// else. Run once: pnpm exec tsx src/modules/sources/public-feeds/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseListingInput } from "@/modules/listings/public";
import { fixture, type Expect, type Tagged } from "../../../../../tests/helpers/golden";

type Normalize = { source: string; entry: Tagged; expect: { ok: string } | { error: string } };
type Batch = { source: string; input: string; expect: Expect<{ jobs: string[]; truncated: boolean; rejected: number }> };
const golden = fixture<{ public_feeds_normalize: Normalize[]; public_feeds_batch: Batch[] }>("golden.json");

/** A tagged golden value as JSON text, so the test reads it with JSON.parse as a real feed is read. */
function json(t: Tagged): string {
  switch (t[0]) {
    case "n": return "null";
    case "b": return String(t[1]);
    case "i": return t[1];
    case "f": return /^-?(nan|inf)$/.test(t[1]) ? "null" : t[1].includes(".") || t[1].includes("e") ? t[1] : `${t[1]}.0`;
    case "s": return JSON.stringify(t[1]);
    case "l": return `[${t[1].map(json).join(",")}]`;
    case "o": return `{${t[1].map(([k, v]) => `${JSON.stringify(k)}:${json(v)}`).join(",")}}`;
  }
}

/** An old job's JSON; Python wrote float NaN and infinities, which JSON (and jsonb) cannot hold: they become null, as a non-finite JSON input reads. */
const oldJob = (text: string) => JSON.parse(text.replace(/: (?:NaN|-?Infinity)(?=[,}])/g, ": null")) as Record<string, unknown>;

/** The old job in the contract: same fields, the old evidence the contract has no column for in extra. */
function oldToInput(job: Record<string, unknown>) {
  return parseListingInput({
    external_id: job.external_id, title: job.title, description: job.description, url: job.url, canonical_url: job.canonical_url,
    // New: the board's location text is the listing's location (old kept it as location_evidence only).
    location: (job.location_evidence as string | null) || null,
    kind: job.kind, listing_closed: job.listing_closed, complete: false,
    published_at: new Date(job.published_at as string).toISOString(),
    // New: extra keeps only what the connector read, the contract has no field for, and audits use.
    extra: { publication_evidence: job.publication_evidence, employment_evidence: job.employment_evidence, salary_evidence: job.salary_evidence },
  });
}

export type NormalizeCase = { index: number; source: string; input: string; expect: { listing: unknown } | { setAside: true } | { unknown: readonly string[] } | { accepted: string }; why?: string };
export type BatchCase = {
  index: number; source: string; input: string;
  expect: { error: true } | { seen: number; listings: unknown[]; truncated: boolean; rejected: number } | { seen: number; ids: string[]; unknown: string[]; truncated: boolean; rejected: number };
  why?: string;
};

/** D8_UNKNOWN (normalize): old refusals of a field that is not identity; the new connector keeps the listing with those fields unknown. */
const D8_UNKNOWN = new Map<number, { fields: readonly string[]; why: string }>([
  ...[34, 36, 97].map((i) => [i, { fields: ["kind"], why: "tags not a list of text (old: entry dropped); the employment type is unknown without them" }] as const),
  ...[54, 56].map((i) => [i, { fields: ["location"], why: "location not text (old: entry dropped)" }] as const),
  ...[82, 83, 105, 106, 107, 117, 118].map((i) => [i, { fields: ["published_at"], why: "publication time missing or not text (old: entry dropped)" }] as const),
  ...[84, 85, 88, 121].map((i) => [i, { fields: ["published_at"], why: "publication time without a zone (old: entry dropped)" }] as const),
  [89, { fields: ["published_at"], why: "publication time unreadable (old: entry dropped)" }],
  ...[90, 91].map((i) => [i, { fields: ["published_at"], why: "publication time outside years 1-9999 in UTC (old: OverflowError failed the feed)" }] as const),
]);
/** ACCEPTED (normalize): old refusals the new connector accepts for another reason. */
const ACCEPTED = new Map<number, string>([
  [7, "id 1.0: JSON numbers do not tell 1.0 from 1 in JavaScript, so it is id 1"],
  [35, "tags null reads as no tags (old: get(entry, 'tags', []) returned None and dropped the entry)"],
  [72, "a default port names the same job URL (connector checklist section 3: different spellings, one id)"],
]);
/** PATCHED (normalize): old results deliberately changed; the expected listing is patched. */
const evidence = (text: string) => ({ extra: { publication_evidence: "2026-09-18T12:00:00+00:00", employment_evidence: text, salary_evidence: { min: null, max: null, period: null } } });
const PATCHED = new Map<number, { why: string; patch: Record<string, unknown> }>([
  // employment_type that is not text joins the evidence as JavaScript's String() spells it, not Python's str(); extra only, kind unchanged.
  [40, { why: "employment_type object spelled by String()", patch: evidence("Contract Backend API engineer [object Object]") }],
  [41, { why: "employment_type list spelled by String()", patch: evidence("Contract Backend API engineer part,time") }],
  [43, { why: "employment_type true spelled by String()", patch: evidence("Contract Backend API engineer contract backend true") }],
  // The standard URL parser (plan D10) percent-encodes a non-ASCII path and resolves dot segments, as a browser sends the link.
  [76, { why: "non-ASCII path percent-encoded by the URL parser", patch: { url: "https://remoteok.com/remote-jobs/%F0%9F%98%80", canonical_url: "https://remoteok.com/remote-jobs/%F0%9F%98%80" } }],
  [78, { why: "dot segments resolved by the URL parser", patch: { url: "https://remoteok.com/remote-jobs/y", canonical_url: "https://remoteok.com/remote-jobs/y" } }],
]);
/** REFUSED (normalize): old acceptances the new connector sets aside. */
const REFUSED = new Map<number, string>([
  // Python's isdigit() accepted any Unicode digit; the boards' ids are ASCII, and two spellings of one number would be two ids.
  [9, "Remote OK id in Arabic-Indic digits"],
  [10, "Remote OK id '²' (a superscript digit)"],
  [101, "Working Nomads job number in Arabic-Indic digits (the URL parser percent-encodes it, so the path is not /job/go/<digits>/)"],
]);
/** Batch differences, by golden index. */
const BATCH_PATCHED = new Map<number, { why: string; expect: BatchCase["expect"] }>([
  [16, { why: "an id listed twice keeps its last entry (connector checklist section 2); its publication time past year 9999 in UTC is unknown (D8; old: OverflowError failed the feed)",
    expect: { seen: 2, ids: ["123"], unknown: ["published_at"], truncated: false, rejected: 0 } }],
  // Each still fails the source: one entry of one is set aside, more than half (services/collect).
  [21, { why: "an entry that is not an object is set aside, not the feed refused (old: int-to-str limit failed the feed)", expect: { seen: 1, listings: [], truncated: false, rejected: 1 } }],
  // JSON has no NaN and the feeds are UTF-8 (RFC 8259); Python's json.loads accepted NaN and sniffed UTF-16.
  [19, { why: "UTF-16 JSON refused: JSON feeds are read as UTF-8", expect: { error: true } }],
  [22, { why: "NaN is not JSON", expect: { error: true } }],
  [23, { why: "NaN is not JSON", expect: { error: true } }],
]);

const normalize: NormalizeCase[] = golden.public_feeds_normalize.map((c, i) => {
  const base = { index: i, source: c.source, input: json(c.entry) };
  const d8 = D8_UNKNOWN.get(i), accepted = ACCEPTED.get(i), refused = REFUSED.get(i), patched = PATCHED.get(i);
  if (d8 || accepted) {
    if ("ok" in c.expect) throw new Error(`normalize ${i}: the old reader accepted it`);
  }
  if (d8) return { ...base, expect: { unknown: d8.fields }, why: `D8_UNKNOWN: ${d8.why}` };
  if (accepted) return { ...base, expect: { accepted }, why: `ACCEPTED: ${accepted}` };
  if (!("ok" in c.expect)) return { ...base, expect: { setAside: true } };
  if (refused) return { ...base, expect: { setAside: true }, why: `REFUSED: ${refused}` };
  const listing = { ...oldToInput(oldJob(c.expect.ok)), ...patched?.patch };
  return { ...base, expect: { listing }, ...(patched ? { why: `PATCHED: ${patched.why}` } : {}) };
});

const batch: BatchCase[] = golden.public_feeds_batch.map((c, i) => {
  const base = { index: i, source: c.source, input: c.input };
  const patched = BATCH_PATCHED.get(i);
  if (patched) return { ...base, expect: patched.expect, why: `PATCHED: ${patched.why}` };
  if (!("ok" in c.expect)) return { ...base, expect: { error: true } };
  const jobs = c.expect.ok.jobs.map((j) => oldToInput(oldJob(j)));
  const rejected = Number(c.expect.ok.rejected);
  return { ...base, expect: { seen: jobs.length + rejected, listings: [...new Map(jobs.map((l) => [l.external_id, l])).values()], truncated: c.expect.ok.truncated, rejected } };
});

writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify({ normalize, batch }, null, 1) + "\n");
console.log(`${normalize.length} normalize, ${batch.length} batch cases`);
