import type { CATEGORIES, FEEDBACK_STATES } from "@/db/pg/schema";
import type { Facts } from "./facts";

// The settings- and time-dependent half of the evaluation (step-3-design.md core choice 1), over the
// stored facts only: whether a listing is excluded now, its recommendation score in tenths, whether it
// is a candidate, and the rank order. The rules are those of the old evaluate, recommendation and
// is_candidate (web/src/modules/discovery/rules.ts, ranking.ts); evaluate.ts gives the same verdicts
// with their wording, and the fixtures check that both agree.

export type Settings = { maxWeeklyHours: number | null; minFixedTwd: number; categories: readonly (typeof CATEGORIES)[number][] };
export type FeedbackState = (typeof FEEDBACK_STATES)[number];

/** What ranking reads of one content (a listing row or a listing version). */
export type RankFacts = Pick<Facts, "category" | "categoryScore" | "hardExcluded" | "confirmedBase" | "fixedTwdMax" | "publishedAt" | "deadlineAt">
  & { fingerprint: string; weeklyHours: number | null };

export type Rankable = { id: string; feedback: FeedbackState; listing: RankFacts; versions: readonly RankFacts[] };

const DAY_MS = 86_400_000;
export const RECENT_MS = 2 * DAY_MS;
export const WEEK_MS = 7 * DAY_MS;

export const hoursKnown = (f: Pick<RankFacts, "weeklyHours">) => f.weeklyHours !== null && f.weeklyHours > 0;
export const hoursOk = (f: Pick<RankFacts, "weeklyHours">, s: Settings) =>
  hoursKnown(f) && (s.maxWeeklyHours === null || f.weeklyHours! <= s.maxWeeklyHours);

/** A date passed: a deadline at or before now expires the listing. */
export const expired = (f: Pick<RankFacts, "deadlineAt">, now: Date) => f.deadlineAt !== null && f.deadlineAt.getTime() <= now.getTime();

/** Excluded whatever its wording: a hard reason, hours over the limit, a TWD budget under the floor, an expired deadline, a category left out. */
export function excluded(f: RankFacts, s: Settings, now: Date): boolean {
  return f.hardExcluded
    || (hoursKnown(f) && s.maxWeeklyHours !== null && f.weeklyHours! > s.maxWeeklyHours)
    || (f.fixedTwdMax !== null && f.fixedTwdMax < s.minFixedTwd)
    || expired(f, now)
    || !(s.categories as readonly string[]).includes(f.category);
}

/** The freshness bonus in tenths: published at most 2 days ago 100, at most 7 days 60, else (older, future, unknown) 0. */
export function freshTenths(publishedAt: Date | null, now: Date): 0 | 60 | 100 {
  if (publishedAt === null) return 0;
  const age = now.getTime() - publishedAt.getTime();
  return age >= 0 && age <= RECENT_MS ? 100 : age > RECENT_MS && age <= WEEK_MS ? 60 : 0;
}

/** One content's score in tenths before the saved bonus: category × 0.7, 2.5 per confirmed condition, freshness. */
export const optionTenths = (f: RankFacts, s: Settings, now: Date) =>
  f.categoryScore * 7 + 25 * (f.confirmedBase + (hoursOk(f, s) ? 1 : 0)) + freshTenths(f.publishedAt, now);

export type Ranked = { id: string; candidate: boolean; scoreTenths: number; basis: string };

/**
 * The best still-possible content (the listing or one of its differing versions) gives the score; when
 * none is possible, the listing's own. Saved adds 10 points, capped at 100. A candidate has a possible
 * content and is not skipped.
 */
export function rank(r: Rankable, s: Settings, now: Date): Ranked {
  const options = [r.listing, ...r.versions.filter((v) => v.fingerprint !== r.listing.fingerprint)];
  const possible = options.filter((o) => !excluded(o, s, now));
  let best = possible[0] ?? r.listing, bestTenths = optionTenths(best, s, now);
  for (const o of possible.slice(1)) {
    const t = optionTenths(o, s, now);
    if (t > bestTenths) [best, bestTenths] = [o, t];
  }
  return {
    id: r.id,
    candidate: possible.length > 0 && r.feedback !== "skipped",
    scoreTenths: Math.min(1000, bestTenths + (r.feedback === "interested" ? 100 : 0)),
    basis: best.fingerprint,
  };
}

/** Rank order: candidates first, then the higher score, then the id. */
export const byRank = (a: Ranked, b: Ranked) =>
  Number(b.candidate) - Number(a.candidate) || b.scoreTenths - a.scoreTenths || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
