import type { OpportunityType } from "@/db/pg/schema";
import { FACTS_VERSION, factsOf, type Facts } from "./facts";
import { byDeadline, contestFacts, rankContest, type Contest } from "./contest";
import type { Listing } from "./listing";
import { byRank, rank, type Rankable, type Ranked, type Settings } from "./rank";

// One evaluator per opportunity type (opportunity types plan D1): the facts stored at intake, the version
// they carry and the ranking over them. Intake, re-evaluation and the list reach a type's rules only here.

/** What each type's rules read of one content. */
type Evaluated = { job: Listing; contest: Contest };

export type Evaluator<T extends OpportunityType = OpportunityType> = {
  /** The FACTS_VERSION of this type, stored as evaluated_with. */
  version: number;
  facts: (l: Evaluated[T]) => Facts;
  rank: (r: Rankable, s: Settings, now: Date) => Ranked;
  /** The list order of this type. */
  order: (a: Ranked, b: Ranked) => number;
};

const EVALUATORS: { readonly [T in OpportunityType]: Evaluator<T> } = Object.freeze({
  job: { version: FACTS_VERSION.job, facts: factsOf, rank, order: byRank },
  contest: { version: FACTS_VERSION.contest, facts: contestFacts, rank: rankContest, order: byDeadline },
});

export const evaluatorFor = <T extends OpportunityType>(type: T): Evaluator<T> => EVALUATORS[type];
