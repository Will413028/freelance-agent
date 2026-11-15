import { eq } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { CATEGORIES, listingFeedback, listings, listingVersions, settings } from "@/db/pg/schema";
import { byRank, rank, type Rankable, type RankFacts, type Ranked, type Settings } from "./rank";

// The listing page's ranked read (step-3-design.md core choice 1): SQL reads the stored facts of
// every listing and version, TS ranks them. Measured in 3b on PGlite (tests/rank-scale.test.ts):
// 3,500 listings read and ranked in a 38 ms median, inside half the 500 ms page budget, so there is
// no SQL copy of the ranking to keep in step. Necessary while that holds; 3d measures the VM page.

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ maxWeeklyHours: 30, minFixedTwd: 3000, categories: Object.freeze([...CATEGORIES]) });

/** The stored settings with their revision; the defaults at revision 0 before the first save. */
export async function readSettings(db: PgDb): Promise<{ revision: number; settings: Settings }> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  return row
    ? { revision: row.revision, settings: { maxWeeklyHours: row.maxWeeklyHours, minFixedTwd: row.minFixedTwd, categories: row.categories as Settings["categories"] } }
    : { revision: 0, settings: { ...DEFAULT_SETTINGS, categories: [...DEFAULT_SETTINGS.categories] } };
}

const factColumns = <T extends typeof listings | typeof listingVersions>(t: T) => ({
  fingerprint: t.fingerprint, weeklyHours: t.weeklyHours, category: t.category, categoryScore: t.categoryScore, hardExcluded: t.hardExcluded,
  confirmedBase: t.confirmedBase, fixedTwdMax: t.fixedTwdMax, publishedAt: t.publishedAt, deadlineAt: t.deadlineAt,
});

/** Every listing with its versions and feedback, as ranking reads them. */
export async function readRankables(db: PgDb): Promise<Rankable[]> {
  const [rows, versions] = await Promise.all([
    db.select({ id: listings.id, feedback: listingFeedback.state, ...factColumns(listings) })
      .from(listings).leftJoin(listingFeedback, eq(listingFeedback.listingId, listings.id)),
    db.select({ listingId: listingVersions.listingId, ...factColumns(listingVersions) }).from(listingVersions),
  ]);
  const byListing = new Map<number, RankFacts[]>();
  for (const { listingId, ...v } of versions) {
    const list = byListing.get(listingId);
    if (list) list.push(v as RankFacts);
    else byListing.set(listingId, [v as RankFacts]);
  }
  return rows.map(({ id, feedback, ...f }) => ({ id, feedback: feedback ?? "neutral", listing: f as RankFacts, versions: byListing.get(id) ?? [] }));
}

/** Which listings a page shows: the candidates, the saved, the skipped or all of them. */
export type View = "candidates" | "saved" | "skipped" | "all";
export const VIEWS: readonly View[] = ["candidates", "saved", "skipped", "all"];
export const PAGE_SIZE = 50;

const inView = (view: View, r: Rankable, ranked: Ranked) =>
  view === "candidates" ? ranked.candidate : view === "saved" ? r.feedback === "interested" : view === "skipped" ? r.feedback === "skipped" : true;

/** One page of a view in rank order, and how many listings the view holds. */
export async function rankedPage(db: PgDb, s: Settings, now: Date, view: View, page: number): Promise<{ total: number; items: Ranked[] }> {
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError(`page must be a whole number from 0, not ${page}`);
  const all = (await readRankables(db)).flatMap((r) => {
    const ranked = rank(r, s, now);
    return inView(view, r, ranked) ? [ranked] : [];
  }).sort(byRank);
  return { total: all.length, items: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
}
