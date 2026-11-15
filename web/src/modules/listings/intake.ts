import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings, listingVersions } from "@/db/pg/schema";
import { bool, factsOf, kindOf, num, str, type Job } from "@/modules/evaluation/public";
import { fingerprint, listingId } from "./id";

// Listing intake (step-3-design.md core choices 2–4): one transaction per batch; a listing is keyed
// by (source, external_id). A source page is the source's current state, so new content overwrites
// the row, also when it returns to an earlier content (plan D6). Mail has no current state: the row
// keeps the content first written and each different content is kept in listing_versions.

export type IntakeMode = "page" | "mail";
export type IntakeOutcome = "inserted" | "updated" | "unchanged" | "versioned";
export type IntakeCounts = Record<IntakeOutcome, number>;

const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The job as Postgres can store it and as it reads back: JSON round trip (undefined keys dropped),
 * NUL removed and lone surrogates replaced by U+FFFD in every string, which text and jsonb refuse.
 * Fingerprints are computed on this form, so a stored row's raw gives back its own fingerprint.
 */
export function storable(job: Job): Job {
  const clean = (v: unknown): unknown =>
    typeof v === "string" ? v.replaceAll("\0", "").replace(LONE_SURROGATES, "\ufffd")
    : Array.isArray(v) ? v.map(clean)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k) as string, clean(x)]))
    : v;
  return clean(JSON.parse(JSON.stringify(job))) as Job;
}

/** The stored columns of one content: shown fields, raw JSON and the evaluation facts. */
export function contentColumns(source: string, job: Job) {
  const title = str(job.title);
  if (!title) throw new Error(`listing ${source}/${String(job.external_id)} has no title`);
  return {
    fingerprint: fingerprint(job),
    raw: job,
    title,
    company: str(job.company),
    description: str(job.description),
    url: str(job.url),
    canonicalUrl: str(job.canonical_url),
    location: str(job.location),
    kind: kindOf(job),
    currency: str(job.currency),
    budgetMin: num(job.budget_min),
    budgetMax: num(job.budget_max),
    weeklyHours: num(job.weekly_hours),
    taiwanEligible: bool(job.taiwan_eligible),
    timezoneCompatible: bool(job.timezone_compatible),
    complete: bool(job.complete),
    listingClosed: bool(job.listing_closed),
    ...factsOf(source, job),
  };
}

function identity(source: string, job: Job) {
  const externalId = str(job.external_id);
  if (!externalId) throw new Error(`a ${source} listing has no external_id`);
  if (job.source !== undefined && job.source !== source) throw new Error(`a listing of ${String(job.source)} given as ${source}`);
  return { id: listingId(source, externalId), externalId };
}

/**
 * Writes one source's listings in one transaction and says what happened to each. A batch with the
 * same external_id twice is refused: which content wins would depend on order.
 */
export async function intakeListings(db: PgDb, source: string, jobs: readonly Job[], mode: IntakeMode, observedAt = new Date()): Promise<IntakeCounts> {
  const items = jobs.map((given) => {
    const job = storable(given);
    return { ...identity(source, job), columns: contentColumns(source, job) };
  });
  const ids = items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${source} batch lists the same external_id twice`);
  const counts: IntakeCounts = { inserted: 0, updated: 0, unchanged: 0, versioned: 0 };
  if (!items.length) return counts;
  await db.transaction(async (tx) => {
    const existing = new Map((await tx.select({ id: listings.id, fingerprint: listings.fingerprint, raw: listings.raw, updatedAt: listings.updatedAt })
      .from(listings).where(inArray(listings.id, ids)).for("update")).map((r) => [r.id, r]));
    for (const { id, externalId, columns } of items) {
      const old = existing.get(id);
      if (!old) {
        await tx.insert(listings).values({ id, source, externalId, ...columns, firstSeenAt: observedAt, updatedAt: observedAt });
        counts.inserted++;
      } else if (old.fingerprint === columns.fingerprint) {
        counts.unchanged++;
      } else if (mode === "page") {
        await tx.update(listings).set({ ...columns, updatedAt: observedAt }).where(eq(listings.id, id));
        counts.updated++;
      } else {
        // The row's content becomes a version too, as first seen; its stored fingerprint is kept.
        const first = { ...contentColumns(source, old.raw as Job), fingerprint: old.fingerprint };
        const added = await tx.insert(listingVersions).values([{ listingId: id, ...first, observedAt: old.updatedAt }, { listingId: id, ...columns, observedAt }])
          .onConflictDoNothing({ target: [listingVersions.listingId, listingVersions.fingerprint] }).returning({ fingerprint: listingVersions.fingerprint });
        if (added.some((r) => r.fingerprint === columns.fingerprint)) counts.versioned++;
        else counts.unchanged++;
      }
    }
  });
  return counts;
}

/** The listing row of (source, external_id), for tests and pages. */
export async function listingBy(db: PgDb, source: string, externalId: string) {
  const [row] = await db.select().from(listings).where(and(eq(listings.source, source), eq(listings.externalId, externalId)));
  return row ?? null;
}

export const versionCount = async (db: PgDb, id: string) =>
  Number((await db.select({ n: sql<number>`count(*)` }).from(listingVersions).where(eq(listingVersions.listingId, id)))[0].n);
