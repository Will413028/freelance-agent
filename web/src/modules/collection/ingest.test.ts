import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { list } from "../../../tests/helpers/reference";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";
import { db, query, resetSchema } from "../../../tests/helpers/db";
import { job } from "../../../tests/helpers/jobs";
import { ingestSource, setSourceHealth, sourceStatuses, type Listing } from "./ingest";
import { olderNotification } from "./observation";

// Ports of backend/tests/collection/test_source_batch.py plus notification ordering.
const now = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const pyType = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as { pyType?: string }).pyType ?? String(e));

beforeEach(resetSchema);

describe("source batch", () => {
  it("replays and exposes existing source jobs", async () => {
    const first = job({ source: "tasker", external_id: "one" });
    const items: Listing[] = [[first, "receipt-one"]];
    const seen: boolean[] = [];
    for (let n = 0; n < 2; n++) await ingestSource(db, "tasker", now, items, (_, exists) => { seen.push(exists); return true; }, "ok");
    expect(seen).toEqual([false, true]);
    expect(await list(db, now)).toHaveLength(1);
  });

  it("rolls back the entire batch and its health on a receipt collision", async () => {
    await setSourceHealth(db, "tasker", "failed");
    const one = job({ source: "tasker", external_id: "one" }), two = job({ source: "tasker", external_id: "two" });
    const outcome = ingestSource(db, "tasker", now, [[one, "same"], [two, "same"]], () => true, "ok");
    expect(await pyType(outcome)).toBe("Conflict");
    expect(await list(db, now)).toEqual([]);
    expect((await sourceStatuses(db)).req("tasker")).toBe("failed");
  });

  it("rejects another source without writing", async () => {
    const other = job({ source: "freelancer" });
    const outcome = ingestSource(db, "tasker", now, [[other, "wrong"]], () => true, null);
    expect(await pyType(outcome)).toBe("ValueError");
    expect(await list(db, now)).toEqual([]);
  });
});

describe("olderNotification", () => {
  const n = (receipt: string | null, at: unknown) => PyDict.of({ receipt_id: receipt, received_at: at as never });
  it("compares only aware receipt times of normalized notifications", () => {
    expect(olderNotification(n("a", "2026-09-27T00:00:00Z"), n("b", "2026-09-28T00:00:00+00:00"))).toBe(true);
    expect(olderNotification(n("a", "2026-09-29T00:00:00Z"), n("b", "2026-09-28T00:00:00Z"))).toBe(false);
    expect(olderNotification(n("a", "2026-09-27 00:00:00"), n("b", "2026-09-28T00:00:00Z"))).toBe(false);
    expect(olderNotification(n(null, "2026-09-27T00:00:00Z"), n("b", "2026-09-28T00:00:00Z"))).toBe(false);
    expect(olderNotification(n("a", 5), n("b", "2026-09-28T00:00:00Z"))).toBe(false);
    expect(olderNotification(PyDict.of({ receipt_id: "a" }), n("b", "2026-09-28T00:00:00Z"))).toBe(false);
  });
});
