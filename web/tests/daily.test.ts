import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { enabledSources, FAILURE_REASON, RUNNERS, runSource, sourcesIn } from "@/modules/collection/public";
import { getDailyRun } from "@/modules/notifications/public";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { asDict, PyDict } from "@/platform/py/value";
import { beginDailyRun, finishDailySources, syncDailySource } from "@/services/daily";
import { syncInOrder } from "@/workflows/in-order";
import { db, pool, resetSchema } from "./helpers/db";
import { fixture } from "./helpers/golden";

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
    const detail = await syncDailySource(db, "guru", { guru: async () => { throw new Error("down"); } });
    expect(detail).toEqual({ status: "failed", reason: "source_unavailable" });
    expect((await sourcesIn(db)).req("guru")).toBe("failed");
    expect(await finishDailySources(db, begin.localDate, { guru: detail }, at(1, 30))).toBe("failed");
    const row = await getDailyRun(db, "2026-10-24", "owner@example.invalid");
    expect(asDict(row!.result).dict("source_details").dict("guru").req("status")).toBe("failed");
  });

  it("treats a partial source as a failed day, as collection/service.py does", async () => {
    const begin = await beginDailyRun(db, at(1));
    const partial = await syncDailySource(db, "guru", { guru: async () => PyDict.of({ status: "partial", jobs: 1n }) });
    const ok = await syncDailySource(db, "tasker", { tasker: async () => PyDict.of({ status: "ok" }) });
    expect([partial.status, ok.status]).toEqual(["partial", "ok"]);
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
    }, "failed");
    expect(peak).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
    expect(statuses).toEqual({ a: "ok", b: "failed", c: "ok" });
  });

  it("fans out only to implemented, enabled sources in catalog priority order", () => {
    const noop = async () => PyDict.of({ status: "ok" });
    expect(enabledSources({ guru: noop, ptt_soho: noop, tasker: noop, jobicy: noop, nope: noop }, null)).toEqual(["tasker", "jobicy", "guru"]);
    // Ported sources stay off the schedule until their own deploy (steps 7 and 8 added 2026-10-25, step 9's mail sources the same day).
    expect(enabledSources()).toEqual(["tasker", "linkedin", "cake", "jobbank104", "talent", "freelancer", "jobicy", "remotive", "himalayas", "hackernews", "v2ex", "remoteok", "realworkfromanywhere", "weworkremotely", "workingnomads", "taiwanjobs", "arbeitnow", "nodesk", "getonboard", "justremote", "cryptojobslist", "dynamitejobs", "jobbank518", "chickpt", "glassdoor"]);
    expect(enabledSources({ guru: noop, jobicy: noop }, new Set(["guru", "remotive"]))).toEqual(["guru"]);
  });
});

// Plan step 10a: each source's result dict reaches daily_runs.result.source_details as Python's
// collect_sources wrote it.
describe("source details", () => {
  it("keeps the connector's counts in its key order and writes collect_sources' shape", async () => {
    const begin = await beginDailyRun(db, at(1));
    const result = new PyDict([["status", "ok"], ["reason", null], ["seen", 3n], ["jobs", 1n], ["truncated", false], ["error_stages", PyDict.of({ fetch: 2n })], ["scope", "latest_200_public_listings"]]);
    const ok = await syncDailySource(db, "jobicy", { jobicy: async () => result });
    const down = await syncDailySource(db, "remotive", { remotive: async () => { throw new Error("down"); } });
    await finishDailySources(db, begin.localDate, { jobicy: ok, remotive: down }, at(1, 30));
    const row = await getDailyRun(db, "2026-10-24", "owner@example.invalid");
    expect(encode(asDict(row!.result).req("source_details"))).toBe('{"status": "failed", "reason": "one_or_more_sources_failed", ' +
      '"jobicy": {"status": "ok", "reason": null, "seen": 3, "jobs": 1, "truncated": false, "error_stages": {"fetch": 2}, "scope": "latest_200_public_listings"}, ' +
      '"remotive": {"status": "failed", "reason": "public_feed_unavailable_or_unsupported"}}');
  });

  it("writes a null reason when every source succeeded", async () => {
    const begin = await beginDailyRun(db, at(1));
    const waiting = await syncDailySource(db, "cake", { cake: async () => PyDict.of({ status: "waiting" }) });
    expect(await finishDailySources(db, begin.localDate, { cake: waiting }, at(1, 30))).toBe("complete");
    const row = await getDailyRun(db, "2026-10-24", "owner@example.invalid");
    expect(encode(asDict(row!.result).req("source_details"))).toBe('{"status": "ok", "reason": null, "cake": {"status": "waiting"}}');
  });

  it("keeps a status Python does not count as success, instead of reading it as ok", async () => {
    const blocked = await runSource(db, "guru", async () => PyDict.of({ status: "blocked" }));
    expect(blocked).toEqual({ status: "blocked" });
  });

  it.each([
    ["a listing title", PyDict.of({ status: "ok", title: "Senior Engineer" })],
    ["a list of jobs", PyDict.of({ status: "ok", jobs: [PyDict.of({ title: "x" })] })],
    ["a negative count", PyDict.of({ status: "ok", seen: -1n })],
    ["a float", PyDict.of({ status: "ok", seen: 1.5 })],
    ["a nested dict of text", PyDict.of({ status: "ok", error_stages: PyDict.of({ fetch: "body" }) })],
    ["an integer-like key", new PyDict([["status", "ok"], ["0", 1n]])],
    ["no status", PyDict.of({ seen: 1n })],
    ["no dict", undefined],
  ])("refuses %s in a step's return value", async (_, result) => {
    expect(await runSource(db, "jobicy", async () => result as PyDict)).toEqual({ status: "failed", reason: "invalid_source_result" });
  });

  it("gives each thrown connector the reason its Python sync returns", () => {
    const golden = fixture("golden.json").failure_reasons as Record<string, { ok: string }>;
    const python = Object.fromEntries(Object.entries(golden).map(([s, r]) => [s, JSON.parse(r.ok).reason]));
    const ported = Object.keys(RUNNERS).filter((s) => s in python);
    expect(Object.fromEntries(ported.map((s) => [s, FAILURE_REASON[s]]))).toEqual(Object.fromEntries(ported.map((s) => [s, python[s]])));
    expect(Object.keys(FAILURE_REASON).sort()).toEqual(ported.sort());
    for (const r of Object.values(golden)) expect(Object.keys(JSON.parse(r.ok))).toEqual(["status", "reason"]);
  });
});
