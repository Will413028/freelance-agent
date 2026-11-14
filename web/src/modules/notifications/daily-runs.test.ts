import { beforeEach, describe, expect, it } from "vitest";
import { PyDateTime } from "@/platform/py/datetime";
import { db, resetSchema } from "../../../tests/helpers/db";
import { claimDailyRun, finishDailyRun, getDailyRun, taipeiLocal } from "./daily-runs";

const at = (h: number) => new PyDateTime(2026, 10, 24, h, 0, 0, 0, 0n);

beforeEach(resetSchema);

describe("daily runs", () => {
  it("uses the Asia/Taipei day and hour", () => {
    expect(taipeiLocal(new PyDateTime(2026, 10, 23, 16, 0, 0, 0, 0n))).toEqual({ date: "2026-10-24", hour: 0 });
    expect(taipeiLocal(at(1))).toEqual({ date: "2026-10-24", hour: 9 });
  });

  it("claims once per day", async () => {
    expect(await claimDailyRun(db, "2026-10-24", at(1))).toBe(true);
    expect(await claimDailyRun(db, "2026-10-24", at(4))).toBe(false);
    expect(await claimDailyRun(db, "2026-10-25", at(4))).toBe(true);
    const row = await getDailyRun(db, "2026-10-24");
    expect([row!.status, row!.startedAt]).toEqual(["running", "2026-10-24T01:00:00+00:00"]);
  });

  it("finishes only a running claim and never rewrites a finished day", async () => {
    await claimDailyRun(db, "2026-10-24", at(1));
    await finishDailyRun(db, "2026-10-24", "failed", null, at(2));
    await finishDailyRun(db, "2026-10-24", "complete", null, at(3));
    expect((await getDailyRun(db, "2026-10-24"))!.status).toBe("failed");
    await expect(finishDailyRun(db, "2026-10-24", "running", null, at(3))).rejects.toThrow("Invalid daily run outcome");
  });
});
