import { createHash } from "node:crypto";

/** JSON with object keys sorted at every depth, so equal content gives equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    // Absent, undefined and null are one unknown, so a field added to the contract later changes no fingerprint.
    const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] != null).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The content identity of a listing (step-3-design.md core choice 3, plan D8): sha256 of the parsed
 * contract without `extra`, so only what is shown or evaluated makes a new content. Without
 * `opportunity_type` too: a source has one type (its catalog entry), so the type never tells two contents
 * of one (source, external_id) apart, and leaving it out keeps every fingerprint stored before it existed.
 */
export function fingerprint(input: Readonly<Record<string, unknown>>): string {
  const { extra: _, opportunity_type: _type, ...content } = input;
  return createHash("sha256").update(canonical(content), "utf8").digest("hex");
}
