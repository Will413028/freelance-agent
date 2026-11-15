import { describe, expect, it } from "vitest";
import { legacyListingInputSchema, listingOf } from "@/modules/listings/public";
import { evaluate, recommend, rankFactsOf } from "./evaluate";
import evaluateFixtures from "./evaluate.fixtures.json";
import recommendationFixtures from "./recommendation.fixtures.json";
import { excluded, rank, type FeedbackState, type Settings } from "./rank";

// Plan steps 3b, 3b2: the golden evaluate and recommendation cases. Each input is the old job through
// legacyToInput (a contract input); each expectation is golden's result, unedited (see each file's
// `about` and `dropped`).

const now = new Date(evaluateFixtures.now);
// The inputs came from old jobs through legacyToInput, so they parse with the legacy contract.
const listing = (input: unknown) => listingOf(legacyListingInputSchema.parse(input));

const mismatches = <C extends { index: number; expect: unknown }>(cases: readonly C[], run: (c: C) => unknown) =>
  cases.flatMap((c) => {
    const got = run(c);
    return JSON.stringify(got) === JSON.stringify(c.expect) ? [] : [{ index: c.index, got, expect: c.expect }];
  });

describe("evaluate", () => {
  it(`${evaluateFixtures.cases.length} golden cases`, () => {
    expect(mismatches(evaluateFixtures.cases, (c) => evaluate(listing(c.input), c.settings as Settings, now))).toEqual([]);
  });

  it("excludes exactly when ranking over the stored facts excludes", () => {
    const disagree = evaluateFixtures.cases.filter((c) => {
      const l = listing(c.input), s = c.settings as Settings;
      return (evaluate(l, s, now).status === "excluded") !== excluded(rankFactsOf("fp", l), s, now);
    });
    expect(disagree.map((c) => c.index)).toEqual([]);
  });
});

describe("recommendation", () => {
  it(`${recommendationFixtures.cases.length} golden cases`, () => {
    expect(mismatches(recommendationFixtures.cases, (c) =>
      recommend({ fingerprint: c.listing.fingerprint, listing: listing(c.listing.input) }, [], c.feedback as FeedbackState, c.settings as Settings, now))).toEqual([]);
  });

  it("scores as ranking over the stored facts scores", () => {
    const disagree = recommendationFixtures.cases.filter((c) => {
      const r = rank({ id: 1, feedback: c.feedback as FeedbackState, listing: rankFactsOf(c.listing.fingerprint, listing(c.listing.input)), versions: [] }, c.settings as Settings, now);
      return r.scoreTenths !== Math.round(c.expect.score * 10);
    });
    expect(disagree.map((c) => c.index)).toEqual([]);
  });
});
