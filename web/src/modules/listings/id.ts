import { createHash } from "node:crypto";

// Listing identity (plan global constraint "職缺 id 不變"): the old id is sha256 of Python's
// json.dumps([source, external_id], sort_keys=True, ensure_ascii=False), so ", " between items and
// non-ASCII left unescaped. JSON.stringify escapes a string the way Python does with ensure_ascii off
// (quote, backslash, \b \f \n \r \t, other controls as lowercase \u00XX) except for lone surrogates,
// which Python could not encode as UTF-8 anyway; those are refused. id.fixtures.json pins the values.

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function listingId(source: string, externalId: string): string {
  for (const part of [source, externalId]) {
    if (!part) throw new Error("source and external_id must be non-empty");
    if (LONE_SURROGATE.test(part)) throw new Error("source and external_id must be well-formed Unicode");
  }
  return createHash("sha256").update(`[${JSON.stringify(source)}, ${JSON.stringify(externalId)}]`, "utf8").digest("hex");
}

/** Fields that describe an observation, not the content: they never change the fingerprint. */
const OBSERVATION_FIELDS = new Set(["received_at", "receipt_id", "evidence_ref", "raw_evidence_ref"]);

/** JSON with object keys sorted at every depth, so equal content gives equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The content identity of a listing: whether a source now says something different (step-3-design.md core choice 3). */
export function fingerprint(job: Readonly<Record<string, unknown>>): string {
  const content = Object.fromEntries(Object.entries(job).filter(([k]) => !OBSERVATION_FIELDS.has(k)));
  return createHash("sha256").update(canonical(content), "utf8").digest("hex");
}
