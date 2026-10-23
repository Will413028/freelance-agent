import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PyDateTime } from "@/platform/py/datetime";
import { db, pool, resetSchema } from "../../../tests/helpers/db";
import { claimDailyRun, dailyRecipient, finishDailyRun, getDailyRun, taipeiLocal } from "./daily-runs";

const at = (h: number) => new PyDateTime(2026, 10, 24, h, 0, 0, 0, 0n);

beforeEach(resetSchema);
afterAll(async () => { await pool.end(); });

describe("daily runs", () => {
  it("uses the Asia/Taipei day and hour", () => {
    expect(taipeiLocal(new PyDateTime(2026, 10, 23, 16, 0, 0, 0, 0n))).toEqual({ date: "2026-10-24", hour: 0 });
    expect(taipeiLocal(at(1))).toEqual({ date: "2026-10-24", hour: 9 });
  });

  it("normalizes the recipient like run_daily and refuses unsafe values", () => {
    expect(dailyRecipient("  Owner@Example.INVALID ")).toBe("owner@example.invalid");
    for (const bad of [undefined, "", "  ", "a@b\nc"]) expect(() => dailyRecipient(bad)).toThrow("Explicit recipient required");
  });

  it("claims once per day and recipient", async () => {
    expect(await claimDailyRun(db, "2026-10-24", "r", at(1))).toBe(true);
    expect(await claimDailyRun(db, "2026-10-24", "r", at(4))).toBe(false);
    expect(await claimDailyRun(db, "2026-10-24", "other", at(4))).toBe(true);
    const row = await getDailyRun(db, "2026-10-24", "r");
    expect([row!.status, row!.startedAt]).toEqual(["running", "2026-10-24T01:00:00+00:00"]);
  });

  it("finishes only a running claim and never rewrites a finished day", async () => {
    await claimDailyRun(db, "2026-10-24", "r", at(1));
    await finishDailyRun(db, "2026-10-24", "r", "failed", null, at(2));
    await finishDailyRun(db, "2026-10-24", "r", "complete", null, at(3));
    expect((await getDailyRun(db, "2026-10-24", "r"))!.status).toBe("failed");
    await expect(finishDailyRun(db, "2026-10-24", "r", "running", null, at(3))).rejects.toThrow("Invalid daily run outcome");
  });
});
