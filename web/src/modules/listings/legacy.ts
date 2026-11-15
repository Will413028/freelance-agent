import { KINDS } from "@/db/pg/schema";
import { legacyListingInputSchema, type ListingInput } from "./contract";
import { parseIsoTime, utc } from "./legacy-time";

// Old-system job JSON into the listing contract (plan D8), for the step 10 migration and the golden
// conversion: the old evaluation's lenient reading happens here, once, and nowhere after. A field the
// old rules could not use becomes unknown; a row is refused only without a text title or external_id,
// or under another source's name: what the old system could not have stored (its evaluation raised).

type OldJob = Readonly<Record<string, unknown>>;

const PUBLISHED_FROM_RECEIVED = ["himalayas", "hackernews", "v2ex"];
const PUBLISHED_FROM_EVIDENCE = ["jobicy", "remotive"];
const KNOWN = new Set(["source", "external_id", "title", "company", "description", "url", "canonical_url", "location", "kind", "currency",
  "budget_min", "budget_max", "weekly_hours", "taiwan_eligible", "timezone_compatible", "complete", "listing_closed", "compensation_evidence",
  "published_at", "deadline"]);

const str = (v: unknown) => (typeof v === "string" ? v : null);
const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const tri = (v: unknown) => (typeof v === "boolean" ? v : null);
/** Python truthiness of a JSON value. */
const truthy = (v: unknown) =>
  v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && !v.length)
  && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);

/** An instant as RFC 3339, or null outside the years 1–9999 Python could represent. */
function rfc3339(d: Date): string | null {
  const y = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && y >= 1 && y <= 9999 ? d.toISOString() : null;
}

/** The old publication rule: published_at, else received_at for some sources, else publication_evidence (naive read as UTC) for others. */
function publishedAt(source: string, job: OldJob): string | null {
  let value = job.published_at ?? null, assumeUtc = false;
  if (value === null && PUBLISHED_FROM_RECEIVED.includes(source)) value = job.received_at ?? null;
  if (value === null && PUBLISHED_FROM_EVIDENCE.includes(source)) {
    value = job.publication_evidence ?? null;
    assumeUtc = true;
  }
  if (typeof value === "number") return Number.isFinite(value) ? rfc3339(new Date(value * 1000)) : null;
  if (typeof value !== "string") return null;
  const p = parseIsoTime(value.replaceAll("Z", "+00:00"));
  if (!p) return null;
  if (p.kind === "aware") return rfc3339(p.instant);
  if (!assumeUtc) return null;
  return rfc3339(p.kind === "naive" ? p.utcIfAssumed : new Date(utc(p.year, p.month, p.day)));
}

/** The old deadline rule: a `YYYY-MM-DD` date, an aware instant, other parsed text without a zone, or invalid. */
function deadline(value: unknown): ListingInput["deadline"] {
  if (!truthy(value)) return null;
  if (typeof value !== "string") return { kind: "invalid", text: JSON.stringify(value) ?? String(value) };
  const p = parseIsoTime(value.replaceAll("Z", "+00:00"));
  if (!p) return { kind: "invalid", text: value };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "date", date: value };
  if (p.kind === "aware") {
    const at = rfc3339(p.instant);
    return at === null ? { kind: "invalid", text: value } : { kind: "instant", at };
  }
  return { kind: "no_timezone", text: value };
}

/** A budget the old rules could read: a non-numeric lower bound made the whole range unusable. */
function budget(job: OldJob): { budget_min: number | null; budget_max: number | null } {
  const low = job.budget_min ?? null;
  if (low !== null && finite(low) === null) return { budget_min: null, budget_max: null };
  return { budget_min: finite(low), budget_max: finite(job.budget_max) };
}

export function legacyToInput(source: string, job: OldJob): ListingInput {
  if (typeof job.title !== "string") throw new Error(`an old ${source} listing has no text title`);
  if (job.source !== undefined && job.source !== source) throw new Error(`an old listing of ${String(job.source)} given as ${source}`);
  if (typeof job.external_id !== "string" || !job.external_id) throw new Error(`an old ${source} listing has no external_id`);
  const kind = (KINDS as readonly unknown[]).includes(job.kind) ? (job.kind as ListingInput["kind"]) : null;
  return legacyListingInputSchema.parse({
    external_id: job.external_id, title: job.title, company: str(job.company), description: str(job.description), url: str(job.url),
    canonical_url: str(job.canonical_url), location: str(job.location), kind, currency: str(job.currency), ...budget(job),
    weekly_hours: finite(job.weekly_hours), taiwan_eligible: tri(job.taiwan_eligible), timezone_compatible: tri(job.timezone_compatible),
    complete: tri(job.complete), listing_closed: tri(job.listing_closed), compensation_evidence: str(job.compensation_evidence),
    published_at: publishedAt(source, job), deadline: deadline(job.deadline),
    extra: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(job).filter(([k]) => !KNOWN.has(k))))),
  });
}
