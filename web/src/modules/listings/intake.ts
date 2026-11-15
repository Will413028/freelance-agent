import { and, eq, getTableColumns, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings, listingVersions } from "@/db/pg/schema";
import { factsOf, type Listing } from "@/modules/evaluation/public";
import { deadlineColumns, deadlineOfColumns, listingOf, parseListingInput, type ListingInput } from "./contract";
import { fingerprint } from "./id";

// Listing intake (step-3-design.md core choices 2–4, plan D8): every listing is parsed into the
// contract first, so nothing unparsed is stored; one transaction per batch; a listing is keyed
// by (source, external_id). A source page is the source's current state, so new content overwrites
// the row, also when it returns to an earlier content (plan D6). Mail has no current state: the row
// keeps the content first written and each different content is kept in listing_versions.

/** The content columns listings and listing_versions share (schema.ts content()). */
const CONTENT_KEYS = Object.keys(getTableColumns(listingVersions)).filter((k) => k !== "listingId" && k !== "observedAt") as (keyof ReturnType<typeof contentColumns>)[];

export type IntakeMode = "page" | "mail";
export type IntakeOutcome = "inserted" | "updated" | "unchanged" | "versioned";
export type IntakeCounts = Record<IntakeOutcome, number>;

const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A connector's listing as Postgres can store it: JSON round trip (undefined keys dropped), NUL
 * removed and lone surrogates replaced by U+FFFD in every string, which text and jsonb refuse.
 */
export function storable(value: unknown): unknown {
  const clean = (v: unknown): unknown =>
    typeof v === "string" ? v.replaceAll("\0", "").replace(LONE_SURROGATES, "\ufffd")
    : Array.isArray(v) ? v.map(clean)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k) as string, clean(x)]))
    : v;
  return clean(JSON.parse(JSON.stringify(value)));
}

/** The stored columns of one content: shown fields, the contract as raw JSON, and the evaluation facts. */
export function contentColumns(input: ListingInput) {
  const l = listingOf(input);
  return {
    fingerprint: fingerprint(input),
    raw: input,
    title: input.title,
    company: input.company,
    description: input.description,
    url: input.url,
    canonicalUrl: input.canonical_url,
    location: input.location,
    kind: input.kind,
    currency: input.currency,
    budgetMin: input.budget_min,
    budgetMax: input.budget_max,
    weeklyHours: input.weekly_hours,
    taiwanEligible: input.taiwan_eligible,
    timezoneCompatible: input.timezone_compatible,
    complete: input.complete,
    listingClosed: input.listing_closed,
    compensationEvidence: input.compensation_evidence,
    ...deadlineColumns(input.deadline),
    ...factsOf(l),
  };
}

type ContentRow = { title: string; description: string | null; kind: Listing["kind"]; currency: string | null; budgetMin: number | null;
  budgetMax: number | null; weeklyHours: number | null; taiwanEligible: boolean | null; timezoneCompatible: boolean | null;
  complete: boolean | null; listingClosed: boolean | null; compensationEvidence: string | null; publishedAt: Date | null;
  deadlineKind: string | null; deadlineText: string | null; deadlineAt: Date | null };

/** A stored listing or version row as evaluation reads it, from its typed columns only. */
export function listingOfRow(r: ContentRow): Listing {
  const deadline = deadlineOfColumns(r.deadlineKind, r.deadlineText, r.deadlineAt);
  return {
    title: r.title, description: r.description, kind: r.kind, currency: r.currency, budgetMin: r.budgetMin, budgetMax: r.budgetMax,
    weeklyHours: r.weeklyHours, taiwanEligible: r.taiwanEligible, timezoneCompatible: r.timezoneCompatible, complete: r.complete,
    listingClosed: r.listingClosed, compensationEvidence: r.compensationEvidence, publishedAt: r.publishedAt, deadline,
  };
}

/**
 * How a batch was read. `sourceKept`: the source's own rule per listing (plan D9), stored as
 * listings.source_kept; absent, every listing passes (mail has no source rule). `complete`: the batch is
 * a complete read of the source (catalog flag, read not truncated, run not failed): every stored
 * listing of the source it does not show gets gone_at.
 */
export type IntakeOptions = { sourceKept?: (externalId: string) => boolean; complete?: boolean };

/**
 * Writes one source's listings in one transaction and says what happened to each. A listing outside
 * the contract refuses the batch (ZodError); a batch with the same external_id twice is refused: which content wins would depend on order.
 * Every listing read is stored (plan D9); each sighting writes last_seen_at and clears gone_at, while
 * updated_at moves only when the content changes.
 */
export async function intakeListings(db: PgDb, source: string, given: readonly unknown[], mode: IntakeMode, observedAt = new Date(), options: IntakeOptions = {}): Promise<IntakeCounts> {
  if (!source) throw new Error("source must be non-empty");
  const items = given.map((value) => {
    const input = parseListingInput(storable(value));
    return { externalId: input.external_id, columns: contentColumns(input), sourceKept: options.sourceKept?.(input.external_id) ?? true };
  });
  const externalIds = items.map((i) => i.externalId);
  if (new Set(externalIds).size !== externalIds.length) throw new Error(`${source} batch lists the same external_id twice`);
  const counts: IntakeCounts = { inserted: 0, updated: 0, unchanged: 0, versioned: 0 };
  // An empty read is never taken as complete: nothing is marked gone.
  if (!items.length) return counts;
  const seen = { lastSeenAt: observedAt, goneAt: null };
  await db.transaction(async (tx) => {
    const existing = new Map((await tx.select().from(listings).where(and(eq(listings.source, source), inArray(listings.externalId, externalIds))).for("update")).map((r) => [r.externalId, r]));
    const sighted = { kept: [] as number[], out: [] as number[] };
    for (const { externalId, columns, sourceKept } of items) {
      const old = existing.get(externalId);
      if (!old) {
        await tx.insert(listings).values({ source, externalId, ...columns, sourceKept, firstSeenAt: observedAt, updatedAt: observedAt, ...seen });
        counts.inserted++;
        continue;
      }
      if (old.fingerprint === columns.fingerprint) {
        counts.unchanged++;
      } else if (mode === "page") {
        await tx.update(listings).set({ ...columns, sourceKept, updatedAt: observedAt, ...seen }).where(eq(listings.id, old.id));
        counts.updated++;
        continue;
      } else {
        // The row's content becomes a version too, as first seen: its stored columns, never a re-parse of raw.
        const first = Object.fromEntries(CONTENT_KEYS.map((k) => [k, old[k]])) as Pick<typeof old, (typeof CONTENT_KEYS)[number]>;
        const added = await tx.insert(listingVersions).values([{ listingId: old.id, ...first, observedAt: old.updatedAt }, { listingId: old.id, ...columns, observedAt }])
          .onConflictDoNothing({ target: [listingVersions.listingId, listingVersions.fingerprint] }).returning({ fingerprint: listingVersions.fingerprint });
        if (added.some((r) => r.fingerprint === columns.fingerprint)) counts.versioned++;
        else counts.unchanged++;
      }
      (sourceKept ? sighted.kept : sighted.out).push(old.id);
    }
    // Every other sighting of a stored row (unchanged, or mail); the rule is re-read each time (it may depend on the date).
    if (sighted.kept.length) await tx.update(listings).set({ sourceKept: true, ...seen }).where(inArray(listings.id, sighted.kept));
    if (sighted.out.length) await tx.update(listings).set({ sourceKept: false, ...seen }).where(inArray(listings.id, sighted.out));
    // A complete read that no longer shows a stored listing: it left the source.
    if (options.complete) {
      await tx.update(listings).set({ goneAt: observedAt })
        .where(and(eq(listings.source, source), isNull(listings.goneAt), notInArray(listings.externalId, externalIds)));
    }
  });
  return counts;
}

/** The listing row of (source, external_id), or null: how tests and pages find a surrogate id. */
export async function listingBy(db: PgDb, source: string, externalId: string) {
  const [row] = await db.select().from(listings).where(and(eq(listings.source, source), eq(listings.externalId, externalId)));
  return row ?? null;
}

export const versionCount = async (db: PgDb, id: number) =>
  Number((await db.select({ n: sql<number>`count(*)` }).from(listingVersions).where(eq(listingVersions.listingId, id)))[0].n);
