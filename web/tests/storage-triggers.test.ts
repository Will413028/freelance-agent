import { beforeEach, describe, expect, it } from "vitest";
import { encode } from "@/platform/py/json";
import { PyDict } from "@/platform/py/value";
import { runSignals, storageSignals } from "@/ops/storage-triggers";
import { db, query, resetSchema } from "./helpers/db";

// The D20/D21 revocation triggers read on each run, not over 7 days (Will 2026-10-26).
const usage = (over: Record<string, bigint | PyDict> = {}) => encode(PyDict.of({
  status: "complete", d1_requests: 80n, d1_rows_written: 900n, lease_wait_ms: 0n, lease_timeouts: 0n, lease_lost: 0n,
  d1_errors: new PyDict(), lost_steps: 0n, ...over,
}));

beforeEach(resetSchema);

describe("storage revocation triggers", () => {
  it("reports nothing for a normal run, or one without usage", () => {
    expect(runSignals("2026-10-27", usage())).toEqual([]);
    expect(runSignals("2026-10-27", encode(PyDict.of({ status: "complete" })))).toEqual([]);
    expect(runSignals("2026-10-27", null)).toEqual([]);
  });

  it("trips on a single run: lease waits over 2 s, any lease timeout or loss (D20), any 429 or over 600 requests (D21)", () => {
    expect(runSignals("2026-10-27", usage({ lease_wait_ms: 2000n }))).toEqual([]);
    const tripped = runSignals("2026-10-27", usage({
      lease_wait_ms: 2001n, lease_timeouts: 1n, lease_lost: 1n, d1_errors: PyDict.of({ rate_limited: 2n, overloaded: 1n }), d1_requests: 601n, lost_steps: 1n,
    }));
    expect(tripped.map((s) => [s.decision, s.signal, s.value])).toEqual([
      ["D20", "lease_wait_over_limit", 2001], ["D20", "lease_timeout", 1], ["D20", "lease_lost", 1],
      ["D21", "rate_limited", 2], ["D21", "requests_over_limit", 601], ["totals", "lost_steps", 1],
    ]);
  });

  it("reads the runs from a date on in one request", async () => {
    for (const [date, result] of [["2026-10-25", usage({ lease_timeouts: 1n })], ["2026-10-26", usage()], ["2026-10-27", usage({ d1_requests: 700n })]]) {
      await query("insert into daily_runs (local_date, recipient, status, started_at, result) values (?1, 'o', 'complete', 's', ?2)", [date, result]);
    }
    const { runs, signals } = await storageSignals(db, "2026-10-26");
    expect(runs).toBe(2);
    expect(signals).toEqual([{ localDate: "2026-10-27", decision: "D21", signal: "requests_over_limit", value: 700 }]);
  });
});
