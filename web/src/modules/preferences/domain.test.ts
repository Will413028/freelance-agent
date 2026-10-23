import { describe, expect, it } from "vitest";
import { PyDateTime } from "@/platform/py/datetime";
import { emptyTracking, updateTracking } from "./domain";

// The preferences module's own cases (inventory defect 4: backend/tests/preferences/ was empty).
const now = new PyDateTime(2026, 10, 23, 1, 2, 3, 0, 0n);
const err = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as { pyType?: string }).pyType; } };

describe("updateTracking", () => {
  it("rejects a stale or non-int revision", () => {
    expect(err(() => updateTracking(emptyTracking(), 1n, now, { feedback: "interested" }))).toBe("Conflict");
    expect(err(() => updateTracking(emptyTracking(), true, now, { feedback: "interested" }))).toBe("Conflict");
    expect(err(() => updateTracking(emptyTracking(), 0, now, { feedback: "interested" }))).toBe("Conflict");
  });

  it("strips text, bumps the revision and stamps the time", () => {
    const state = updateTracking(emptyTracking(), 0n, now, { feedback: "interested", note: "  keep  " });
    expect([state.req("feedback"), state.req("note"), state.req("revision"), state.req("updated_at")])
      .toEqual(["interested", "keep", 1n, "2026-10-23T01:02:03+00:00"]);
  });

  it("requires a reason note for 'other' and drops the reason when not skipping", () => {
    expect(err(() => updateTracking(emptyTracking(), 0n, now, { feedback: "skipped", reason: "other" }))).toBe("InvalidAction");
    const skipped = updateTracking(emptyTracking(), 0n, now, { feedback: "skipped", reason: "budget" });
    expect(updateTracking(skipped, 1n, now, { feedback: "neutral", reason: "budget" }).req("reason")).toBe("");
  });

  it("records applied only with evidence and follows the stage transitions", () => {
    expect(err(() => updateTracking(emptyTracking(), 0n, now, { stage: "applied" }))).toBe("InvalidAction");
    expect(err(() => updateTracking(emptyTracking(), 0n, now, { stage: "won" }))).toBe("InvalidAction");
    const applied = updateTracking(emptyTracking(), 0n, now, { stage: "applied", evidence: "ref-1" });
    expect(applied.req("evidence")).toBe("ref-1");
    const reset = updateTracking(applied, 1n, now, { stage: "not_applied", note: "mistake" });
    expect([reset.req("stage"), reset.req("evidence")]).toEqual(["not_applied", ""]);
    expect(err(() => updateTracking(applied, 1n, now, { stage: "not_applied" }))).toBe("InvalidAction");
  });

  it("limits lengths in code points and refuses an explicit None note", () => {
    expect(err(() => updateTracking(emptyTracking(), 0n, now, { feedback: "neutral", note: "😀".repeat(2001) }))).toBe("InvalidAction");
    expect(updateTracking(emptyTracking(), 0n, now, { feedback: "neutral", note: "😀".repeat(2000) }).req("revision")).toBe(1n);
    expect(err(() => updateTracking(emptyTracking(), 0n, now, { feedback: "neutral", note: null }))).toBe("InvalidAction");
  });
});
