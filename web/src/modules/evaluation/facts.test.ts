import { describe, expect, it } from "vitest";
import { factsOf } from "./facts";
import { taipeiDayAfter } from "./time";

// Plan step 3a: the evaluation facts stored with each listing (step-3-design.md core choice 1).

const job = (externalId: string, extra: Record<string, unknown> = {}) => ({
  source: "jobicy", external_id: externalId, title: "Backend API contractor", description: "Build an LLM automation backend",
  url: `https://example.com/jobs/${externalId}`, kind: "contract", ...extra,
});

describe("evaluation facts", () => {
  it("stores what depends on neither settings nor time, unknown kept unknown", () => {
    const f = factsOf("jobicy", job("1"));
    expect(f).toMatchObject({ category: "AI 整合／自動化", categoryScore: 85, hardExcluded: false, confirmedBase: 0, fixedTwdMax: null, deadlineAt: null });
    expect(factsOf("jobicy", job("1", { kind: "full_time" })).hardExcluded).toBe(true);
    expect(factsOf("jobicy", job("1", { taiwan_eligible: false })).hardExcluded).toBe(true);
    expect(factsOf("jobicy", job("1", { taiwan_eligible: null })).hardExcluded).toBe(false);
    expect(factsOf("jobicy", job("1", { title: "Barista", description: "coffee" })).hardExcluded).toBe(true);
    expect(factsOf("jobicy", job("1", { taiwan_eligible: true, timezone_compatible: true, complete: true })).confirmedBase).toBe(3);
  });

  it("keeps the TWD fixed-price ceiling only for a valid range", () => {
    expect(factsOf("x", job("1", { kind: "fixed", currency: "TWD", budget_min: 1000, budget_max: 5000 })).fixedTwdMax).toBe(5000);
    expect(factsOf("x", job("1", { kind: "fixed", currency: "TWD", budget_min: 6000, budget_max: 5000 })).fixedTwdMax).toBeNull();
    expect(factsOf("x", job("1", { kind: "fixed", currency: "USD", budget_max: 5000 })).fixedTwdMax).toBeNull();
  });

  it("expires a date-only deadline at the next Asia/Taipei midnight (plan D7)", () => {
    const at = factsOf("x", job("1", { deadline: "2026-12-01" })).deadlineAt!;
    expect(at.toISOString()).toBe("2026-12-01T16:00:00.000Z");
    // 00:30 in Taipei on the next day (16:30 UTC on the deadline day) is past it; the old UTC rule was not.
    expect(new Date("2026-12-01T16:30:00Z") >= at).toBe(true);
    expect(taipeiDayAfter(2026, 12, 31).toISOString()).toBe("2026-12-31T16:00:00.000Z");
    expect(factsOf("x", job("1", { deadline: "2026-12-01T10:00:00Z" })).deadlineAt!.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(factsOf("x", job("1", { deadline: "2026-12-01T10:00:00" })).deadlineAt).toBeNull();
    expect(factsOf("x", job("1", { deadline: "2026-02-30" })).deadlineAt).toBeNull();
  });

  it("reads publication per source rules", () => {
    expect(factsOf("himalayas", job("1", { received_at: "2026-11-01T00:00:00+08:00" })).publishedAt!.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(factsOf("jobicy", job("1", { publication_evidence: "2026-11-01 08:00:00" })).publishedAt!.toISOString()).toBe("2026-11-01T08:00:00.000Z");
    expect(factsOf("tasker", job("1", { received_at: "2026-11-01T00:00:00Z" })).publishedAt).toBeNull();
    expect(factsOf("x", job("1", { published_at: "2026-11-01T08:00:00" })).publishedAt).toBeNull();
    expect(factsOf("x", job("1", { published_at: 1_700_000_000 })).publishedAt!.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });
});

