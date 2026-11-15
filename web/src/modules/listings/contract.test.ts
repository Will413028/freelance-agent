import { describe, expect, it } from "vitest";
import { legacyListingInputSchema, parseListingInput } from "./contract";

// Plan step 3b2 (D8): the listing contract refuses what it does not define, so nothing downstream guesses.

const base = { external_id: "1", title: "Backend API" };
const refuses = (extra: Record<string, unknown>) => expect(() => parseListingInput({ ...base, ...extra })).toThrow();

describe("listing contract", () => {
  it("fills every optional field with null (unknown), never false", () => {
    expect(parseListingInput(base)).toMatchObject({ kind: null, taiwan_eligible: null, budget_max: null, published_at: null, deadline: null, extra: {} });
  });

  it("takes RFC 3339 only: a date YYYY-MM-DD, an instant with its offset", () => {
    expect(parseListingInput({ ...base, published_at: "2026-11-01T08:00:00+08:00" }).published_at).toBe("2026-11-01T08:00:00+08:00");
    expect(parseListingInput({ ...base, deadline: { kind: "date", date: "2026-12-01" } }).deadline).toEqual({ kind: "date", date: "2026-12-01" });
    refuses({ published_at: "2026-11-01T08:00:00" });
    refuses({ published_at: "2026-11-01 08:00:00Z" });
    refuses({ published_at: 1_700_000_000 });
    refuses({ deadline: { kind: "instant", at: "2026-12-01T10:00:00" } });
    refuses({ deadline: { kind: "date", date: "20261201" } });
    refuses({ deadline: { kind: "date", date: "2026-02-30" } });
    refuses({ deadline: "2026-12-01" });
  });

  it("keeps an unusable deadline as unknown with what the source said", () => {
    expect(parseListingInput({ ...base, deadline: { kind: "no_timezone", text: "2026-12-01 10:00" } }).deadline).toEqual({ kind: "no_timezone", text: "2026-12-01 10:00" });
    refuses({ deadline: { kind: "unknown", text: "x" } });
  });

  it("refuses wrong types, unknown fields and a missing title or external_id", () => {
    refuses({ weekly_hours: "10" });
    refuses({ weekly_hours: Number.NaN });
    refuses({ taiwan_eligible: "yes" });
    refuses({ kind: "part_time" });
    refuses({ received_at: "2026-11-01T00:00:00Z" });
    refuses({ title: null });
    refuses({ external_id: "" });
    refuses({ published_at: "0000-01-01T00:00:00Z" });
    refuses({ deadline: { kind: "date", date: "0000-12-31" } });
    expect(() => parseListingInput({ external_id: "1" })).toThrow();
    expect(() => parseListingInput({ title: "x" })).toThrow();
  });

  it("refuses an empty title from a connector; only old rows may keep one (plan D8)", () => {
    refuses({ title: "" });
    expect(legacyListingInputSchema.parse({ ...base, title: "" }).title).toBe("");
  });

  it("keeps source-specific facts under extra", () => {
    expect(parseListingInput({ ...base, extra: { received_at: "2026-11-01T00:00:00Z" } }).extra).toEqual({ received_at: "2026-11-01T00:00:00Z" });
  });
});
