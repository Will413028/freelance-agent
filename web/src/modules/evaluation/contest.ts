import type { Facts } from "./facts";
import { deadlineAt, type Deadline } from "./listing";
import { expired, type Rankable, type Ranked, type Settings } from "./rank";

// The contest rules (opportunity types plan D2, D3): no score and no category. A contest is a candidate
// while its source has not closed it, its submission deadline has not passed and it is not skipped; an
// invite-only contest is shown like any other (D3). The list is ordered by submission deadline, soonest
// first, a contest without a usable deadline last. Contests have no settings (D6).

/** What the contest rules read of one content. */
export type Contest = { listingClosed: boolean | null; publishedAt: Date | null; deadline: Deadline };

/**
 * The stored facts of a contest, under FACTS_VERSION.contest (facts.ts): bump it with any change to what
 * this returns. The job-only facts carry their neutral value: the columns are shared and
 * not null (schema.ts content()), and nothing ranks a contest by them.
 */
export function contestFacts(c: Contest): Facts {
  return {
    category: "其他", categoryScore: 0, confirmedBase: 0, fixedTwdMax: null,
    hardExcluded: c.listingClosed === true, publishedAt: c.publishedAt, deadlineAt: deadlineAt(c.deadline),
  };
}

/** A contest comes from a page source, so it has one content: its versions are not read. */
export function rankContest(r: Rankable, _settings: Settings, now: Date): Ranked {
  const f = r.listing;
  return {
    id: r.id, firstSeenAt: r.firstSeenAt, scoreTenths: 0, basis: f.fingerprint, deadlineAt: f.deadlineAt,
    candidate: !f.hardExcluded && !expired(f, now) && r.feedback !== "skipped",
  };
}

/** Contest order: candidates first, then the sooner deadline with unknown last, then the newer listing, then the higher id. */
export const byDeadline = (a: Ranked, b: Ranked) =>
  Number(b.candidate) - Number(a.candidate)
  // Two unknown deadlines give NaN, which falls through to the next key like 0.
  || (a.deadlineAt?.getTime() ?? Infinity) - (b.deadlineAt?.getTime() ?? Infinity)
  || b.firstSeenAt.getTime() - a.firstSeenAt.getTime() || b.id - a.id;
