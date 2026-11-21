import type { OpportunityType } from "@/db/pg/schema";
import { FACTS_VERSION, factsOf, type Facts } from "./facts";
import type { Listing } from "./listing";
import { rank, type Rankable, type Ranked, type Settings } from "./rank";

// One evaluator per opportunity type (opportunity types plan D1): the facts stored at intake, the version
// they carry and the ranking over them. Intake, re-evaluation and the list reach a type's rules only here.

export type Evaluator = {
  /** The FACTS_VERSION of this type, stored as evaluated_with. */
  version: number;
  facts: (l: Listing) => Facts;
  rank: (r: Rankable, s: Settings, now: Date) => Ranked;
};

const EVALUATORS: Readonly<Record<OpportunityType, Evaluator>> = Object.freeze({
  job: { version: FACTS_VERSION.job, facts: factsOf, rank },
});

export const evaluatorFor = (type: OpportunityType): Evaluator => EVALUATORS[type];
