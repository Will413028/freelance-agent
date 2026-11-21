import { describe, expect, it } from "vitest";
import { listingOf, parseListingInput } from "@/modules/listings/public";
import { factsOf } from "./facts";
import { taipeiDayAfter } from "./time";

// Plan steps 3a, 3b2: the evaluation facts stored with each listing (step-3-design.md core choice 1),
// over the typed listing.

const l = (extra: Record<string, unknown> = {}) => listingOf(parseListingInput({
  external_id: "1", title: "Backend API contractor", description: "Build an LLM automation backend", kind: "contract", ...extra,
}));

describe("evaluation facts", () => {
  it("stores what depends on neither settings nor time, unknown kept unknown", () => {
    expect(factsOf(l())).toMatchObject({ category: "AI 整合／自動化", categoryScore: 85, hardExcluded: false, confirmedBase: 0, fixedTwdMax: null, deadlineAt: null });
    expect(factsOf(l({ kind: "full_time" })).hardExcluded).toBe(true);
    expect(factsOf(l({ taiwan_eligible: false })).hardExcluded).toBe(true);
    expect(factsOf(l({ taiwan_eligible: null })).hardExcluded).toBe(false);
    expect(factsOf(l({ compensation_evidence: "unpaid_or_equity_only" })).hardExcluded).toBe(true);
    expect(factsOf(l({ title: "Barista", description: "coffee" })).hardExcluded).toBe(true);
    expect(factsOf(l({ taiwan_eligible: true, timezone_compatible: true, complete: true })).confirmedBase).toBe(3);
  });

  it("keeps the TWD fixed-price ceiling only for a valid range", () => {
    expect(factsOf(l({ kind: "fixed", currency: "TWD", budget_min: 1000, budget_max: 5000 })).fixedTwdMax).toBe(5000);
    expect(factsOf(l({ kind: "fixed", currency: "TWD", budget_min: 6000, budget_max: 5000 })).fixedTwdMax).toBeNull();
    expect(factsOf(l({ kind: "fixed", currency: "USD", budget_max: 5000 })).fixedTwdMax).toBeNull();
  });

  it("expires a date at the next Asia/Taipei midnight (plan D7), an instant at itself, an unusable deadline never", () => {
    const at = factsOf(l({ deadline: { kind: "date", date: "2026-12-01" } })).deadlineAt!;
    expect(at.toISOString()).toBe("2026-12-01T16:00:00.000Z");
    expect(taipeiDayAfter("2026-12-31").toISOString()).toBe("2026-12-31T16:00:00.000Z");
    expect(taipeiDayAfter("2025-02-28").toISOString()).toBe("2025-02-28T16:00:00.000Z");
    expect(taipeiDayAfter("0050-03-01").getUTCFullYear()).toBe(50);
    expect(factsOf(l({ deadline: { kind: "instant", at: "2026-12-01T18:00:00+08:00" } })).deadlineAt!.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(factsOf(l({ deadline: { kind: "no_timezone", text: "2026-12-01T10:00:00" } })).deadlineAt).toBeNull();
    expect(factsOf(l({ deadline: { kind: "invalid", text: "soon" } })).deadlineAt).toBeNull();
  });

  it("takes the publication time as the contract gives it, whatever the source", () => {
    expect(factsOf(l({ published_at: "2026-11-01T00:00:00+08:00" })).publishedAt!.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(factsOf(l()).publishedAt).toBeNull();
  });
});

describe("FACTS_VERSION (plan D26)", () => {
  it("is pinned to what factsOf returns over the evaluate fixtures: a rule change must bump the version", async () => {
    const { createHash } = await import("node:crypto");
    const { default: fixtures } = await import("./evaluate.fixtures.json");
    const { FACTS_VERSION } = await import("./facts");
    const { evaluatorFor } = await import("./registry");
    const { legacyListingInputSchema } = await import("@/modules/listings/public");
    // Through the registry, as intake and re-evaluation reach the job rules (opportunity types plan D1).
    const job = evaluatorFor("job");
    const facts = fixtures.cases.map((c) => job.facts(listingOf(legacyListingInputSchema.parse(c.input))));
    const digest = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
    expect(job.version).toBe(FACTS_VERSION.job);
    // On a deliberate rule change: bump FACTS_VERSION.job in facts.ts and put the new digest here, in the same commit.
    expect({ version: FACTS_VERSION.job, digest }).toEqual({ version: 1, digest: "cf78286b9b2dbfa443f5e379990bd3876d039e8958362eca09108e27ce296385" });
  });
});
