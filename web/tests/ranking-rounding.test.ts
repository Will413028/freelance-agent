import { describe, expect, it } from "vitest";
import { oneDecimal } from "@/modules/discovery/ranking";
import { roundFloat, roundToInt } from "@/platform/py/format";

// Plan step 10e2 replaced the ported Python round() in recommendation with native rounding. The
// scores are sums of floats (59.49999999999999 happens), so equality is shown on every score
// recommendation can reach, summed in its own order, not argued from "multiples of 0.5".
describe("native rounding in recommendation equals Python's round", () => {
  it("on every reachable score", () => {
    let checked = 0;
    for (const category of [0, 70, 75, 85, 95]) {
      for (let confirmed = 0; confirmed <= 4; confirmed++) {
        for (const interested of [0, 10]) {
          for (const fresh of [0, 6, 10]) {
            let score = category * 0.7;
            score += confirmed * 2.5;
            score += interested;
            score += fresh;
            if (score >= 100) continue;
            expect(oneDecimal(score)).toBe(roundFloat(score, 1));
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(150); // 5 categories × 5 confirmed counts × interest × 3 freshness bonuses; none reaches the cap of 100
  });

  it("on every completeness ratio", () => {
    for (let n = 0; n <= 6; n++) expect(BigInt(Math.round((n / 6) * 100))).toBe(roundToInt((n / 6) * 100));
  });
});
