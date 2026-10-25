import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { enabledSources, sourcesIn } from "@/modules/collection/public";
import { getDailyRun } from "@/modules/notifications/public";
import { PyDateTime } from "@/platform/py/datetime";
import { asDict, PyDict } from "@/platform/py/value";
import { beginDailyRun, finishDailySources, syncDailySource } from "@/services/daily";
import { syncInOrder } from "@/workflows/in-order";
import { db, pool, resetSchema } from "./helpers/db";

// Plan step 5: the daily entry claims daily_runs first; a second trigger the same day returns.
const at = (h: number, m = 0) => new PyDateTime(2026, 10, 24, h, m, 0, 0, 0n);

beforeEach(async () => { await resetSchema(); process.env.DIGEST_RECIPIENT = "Owner@Example.invalid"; });
afterAll(async () => { delete process.env.DIGEST_RECIPIENT; await pool.end(); });

describe("daily run entry", () => {
  it("runs once when the 09:00 and 12:00 triggers both fire", async () => {
    let runs = 0;
    const trigger = async (now: PyDateTime) => {
      const begin = await beginDailyRun(db, now);
      if (begin.outcome === "claimed") { runs++; await finishDailySources(db, begin.localDate, {}, now); }
      return begin.outcome;
    };
    expect(await trigger(at(1, 5))).toBe("claimed");
    expect(await trigger(at(4, 5))).toBe("already_run");
    expect(runs).toBe(1);
    const row = await getDailyRun(db, "2026-10-24", "owner@example.invalid");
    expect(row!.status).toBe("complete");
  });

  it("is not due before 09:00 Asia/Taipei and writes nothing", async () => {
    expect(await beginDailyRun(db, at(0, 59))).toEqual({ outcome: "not_due", localDate: "2026-10-24" });
    expect(await getDailyRun(db, "2026-10-24", "owner@example.invalid")).toBeNull();
  });

  it("fails closed without a recipient", async () => {
    delete process.env.DIGEST_RECIPIENT;
    await expect(beginDailyRun(db, at(1))).rejects.toThrow("Explicit recipient required");
  });

  it("records failed health for a source that throws and marks the day failed", async () => {
    const begin = await beginDailyRun(db, at(1));
    const status = await syncDailySource(db, "guru", { guru: async () => { throw new Error("down"); } });
    expect(status).toBe("failed");
    expect((await sourcesIn(db)).req("guru")).toBe("failed");
    expect(await finishDailySources(db, begin.localDate, { guru: status }, at(1, 30))).toBe("failed");
    const row = await getDailyRun(db, "2026-10-24", "owner@example.invalid");
    expect(asDict(row!.result).dict("source_details").dict("guru").req("status")).toBe("failed");
  });

  it("treats a partial source as a failed day, as collection/service.py does", async () => {
    const begin = await beginDailyRun(db, at(1));
    const partial = await syncDailySource(db, "guru", { guru: async () => PyDict.of({ status: "partial", jobs: 1n }) });
    const ok = await syncDailySource(db, "tasker", { tasker: async () => PyDict.of({ status: "ok" }) });
    expect([partial, ok]).toEqual(["partial", "ok"]);
    expect(await finishDailySources(db, begin.localDate, { guru: partial, tasker: ok }, at(1, 30))).toBe("failed");
    const row = await getDailyRun(db, "2026-10-24", "owner@example.invalid");
    expect(asDict(row!.result).dict("source_details").dict("guru").req("status")).toBe("partial");
  });

  it("runs sources one at a time and keeps going after a failed one", async () => {
    let running = 0, peak = 0;
    const order: string[] = [];
    const statuses = await syncInOrder(["a", "b", "c"], async (source) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      order.push(source);
      running--;
      if (source === "b") throw new Error("down");
      return "ok";
    });
    expect(peak).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
    expect(statuses).toEqual({ a: "ok", b: "failed", c: "ok" });
  });

  it("fans out only to implemented, enabled sources in catalog priority order", () => {
    const noop = async () => {};
    expect(enabledSources({ guru: noop, ptt_soho: noop, tasker: noop, jobicy: noop, nope: noop }, null)).toEqual(["tasker", "jobicy", "guru"]);
    // Ported sources stay off the schedule until their own deploy (steps 7 and 8 added 2026-10-25, step 9's mail sources the same day).
    expect(enabledSources()).toEqual(["tasker", "linkedin", "cake", "jobbank104", "talent", "freelancer", "jobicy", "remotive", "himalayas", "hackernews", "v2ex", "remoteok", "realworkfromanywhere", "weworkremotely", "workingnomads", "taiwanjobs", "arbeitnow", "nodesk", "getonboard", "justremote", "cryptojobslist", "dynamitejobs", "jobbank518", "chickpt", "glassdoor"]);
    expect(enabledSources({ guru: noop, jobicy: noop }, new Set(["guru", "remotive"]))).toEqual(["guru"]);
  });
});
