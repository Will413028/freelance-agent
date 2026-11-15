import { describe, expect, it } from "vitest";
import { evaluate, recommend, rankFactsOf } from "./evaluate";
import evaluateFixtures from "./evaluate.fixtures.json";
import recommendationFixtures from "./recommendation.fixtures.json";
import { excluded, rank, type Settings } from "./rank";

// Plan step 3b: the golden evaluate and recommendation cases, native (see each file's `about` and
// `dropped`; a case with `change` carries a deliberate change named there).

type EvalCase = (typeof evaluateFixtures.cases)[number];
type RecCase = (typeof recommendationFixtures.cases)[number];
const now = new Date(evaluateFixtures.now);

const mismatches = <C extends { index: number; expect: unknown }>(cases: readonly C[], run: (c: C) => unknown) =>
  cases.flatMap((c) => {
    const got = run(c);
    return JSON.stringify(got) === JSON.stringify(c.expect) ? [] : [{ index: c.index, got, expect: c.expect }];
  });

describe("evaluate, native", () => {
  it(`${evaluateFixtures.cases.length} golden cases`, () => {
    expect(mismatches(evaluateFixtures.cases as EvalCase[], (c) => evaluate(c.source, c.job, c.settings as Settings, now))).toEqual([]);
  });

  it("excludes exactly when ranking over the stored facts excludes", () => {
    const disagree = (evaluateFixtures.cases as EvalCase[]).filter((c) =>
      (evaluate(c.source, c.job, c.settings as Settings, now).status === "excluded") !== excluded(rankFactsOf(c.source, "fp", c.job), c.settings as Settings, now));
    expect(disagree.map((c) => c.index)).toEqual([]);
  });
});

describe("recommendation, native", () => {
  it(`${recommendationFixtures.cases.length} golden cases`, () => {
    expect(mismatches(recommendationFixtures.cases as RecCase[], (c) =>
      recommend(c.source, c.listing, c.versions, c.feedback as "neutral", c.settings as Settings, now))).toEqual([]);
  });

  it("scores as ranking over the stored facts scores", () => {
    const disagree = (recommendationFixtures.cases as RecCase[]).filter((c) => {
      const r = rank({ id: "x", feedback: c.feedback as "neutral", listing: rankFactsOf(c.source, c.listing.fingerprint, c.listing.job), versions: [] }, c.settings as Settings, now);
      return r.scoreTenths !== Math.round(c.expect.score * 10);
    });
    expect(disagree.map((c) => c.index)).toEqual([]);
  });
});
