import { describe, expect, it } from "vitest";
import { legacyToInput } from "./legacy";

// Plan step 3b2 (D8): old-system job JSON into the contract (step 10 migration, golden conversion).
// What the old rules could not use becomes unknown; only a row without a text title or external_id
// or under another source's name is refused (production D1 2026-11-15: 0 of 3,475 rows without a text title).

const old = (extra: Record<string, unknown> = {}) => ({ source: "freelancer", external_id: "1", title: "AI agent workflow", ...extra });

describe("legacyToInput", () => {
  it("reads deadlines as the old rules did: date, instant, no time zone, invalid", () => {
    expect(legacyToInput("freelancer", old({ deadline: "2026-12-01" })).deadline).toEqual({ kind: "date", date: "2026-12-01" });
    expect(legacyToInput("freelancer", old({ deadline: "2026-12-01T10:00:00Z" })).deadline).toEqual({ kind: "instant", at: "2026-12-01T10:00:00.000Z" });
    expect(legacyToInput("freelancer", old({ deadline: "2026-12-01 10:00:00" })).deadline).toEqual({ kind: "no_timezone", text: "2026-12-01 10:00:00" });
    // A basic-form or week date was parsed without a zone by fromisoformat and failed the YYYY-MM-DD check.
    expect(legacyToInput("freelancer", old({ deadline: "20991231" })).deadline).toEqual({ kind: "no_timezone", text: "20991231" });
    expect(legacyToInput("freelancer", old({ deadline: "2099-W01-1" })).deadline).toEqual({ kind: "no_timezone", text: "2099-W01-1" });
    expect(legacyToInput("freelancer", old({ deadline: "soon" })).deadline).toEqual({ kind: "invalid", text: "soon" });
    expect(legacyToInput("freelancer", old({ deadline: 20260917 })).deadline).toEqual({ kind: "invalid", text: "20260917" });
    expect(legacyToInput("freelancer", old({ deadline: ["2099-01-01"] })).deadline).toEqual({ kind: "invalid", text: '["2099-01-01"]' });
    expect(legacyToInput("freelancer", old({ deadline: "" })).deadline).toBeNull();
    // Years 1–99 are real dates for fromisoformat (Date.UTC alone would read them as 1900–1999).
    expect(legacyToInput("freelancer", old({ deadline: "0050-03-01T00:00:00Z" })).deadline).toEqual({ kind: "instant", at: "0050-03-01T00:00:00.000Z" });
  });

  it("applies the old per-source publication rules", () => {
    expect(legacyToInput("himalayas", old({ source: "himalayas", received_at: "2026-11-01T00:00:00+08:00" })).published_at).toBe("2026-10-31T16:00:00.000Z");
    expect(legacyToInput("jobicy", old({ source: "jobicy", publication_evidence: "2026-11-01 08:00:00" })).published_at).toBe("2026-11-01T08:00:00.000Z");
    expect(legacyToInput("tasker", old({ source: "tasker", received_at: "2026-11-01T00:00:00Z" })).published_at).toBeNull();
    expect(legacyToInput("freelancer", old({ published_at: "2026-11-01T08:00:00" })).published_at).toBeNull();
    expect(legacyToInput("freelancer", old({ published_at: 1_700_000_000 })).published_at).toBe("2023-11-14T22:13:20.000Z");
    expect(legacyToInput("freelancer", old({ published_at: 1e20 })).published_at).toBeNull();
  });

  it("turns values the old rules could not use into unknown, never refusing the row", () => {
    const i = legacyToInput("freelancer", old({ weekly_hours: Number.NaN, taiwan_eligible: "yes", kind: "part_time", description: 7, budget_max: true }));
    expect(i).toMatchObject({ weekly_hours: null, taiwan_eligible: null, kind: null, description: null, budget_max: null });
    // A non-numeric lower bound made the old range unusable, so both bounds become unknown.
    expect(legacyToInput("freelancer", old({ budget_min: "4000", budget_max: 8000 }))).toMatchObject({ budget_min: null, budget_max: null });
  });

  it("keeps the other old fields under extra and refuses only a row without text title or external_id", () => {
    expect(legacyToInput("freelancer", old({ language: "en", received_at: "x" })).extra).toEqual({ language: "en", received_at: "x" });
    expect(() => legacyToInput("freelancer", old({ title: null }))).toThrow(/title/);
    expect(legacyToInput("freelancer", old({ title: "" })).title).toBe("");
    expect(() => legacyToInput("tasker", old())).toThrow(/freelancer given as tasker/);
    expect(() => legacyToInput("freelancer", old({ external_id: 1 }))).toThrow(/external_id/);
  });
});
