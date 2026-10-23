import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { list } from "@/services/discovery";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";
import { db, pool, resetSchema } from "../../../tests/helpers/db";
import { job } from "../../../tests/helpers/jobs";
import { setSourceHealth, sourceBatch, sourcesIn } from "./ingest";
import { olderNotification } from "./observation";

// Ports of backend/tests/collection/test_source_batch.py plus notification ordering.
const now = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const pyType = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as { pyType?: string }).pyType ?? String(e));

beforeEach(resetSchema);
afterAll(async () => { await pool.end(); });

describe("source batch", () => {
  it("replays and exposes existing source jobs", async () => {
    const first = job({ source: "tasker", external_id: "one" });
    for (let n = 0; n < 2; n++) {
      await sourceBatch(db, "tasker", now, async (batch) => { await batch.ingest(first, "receipt-one"); await batch.finish("ok"); });
    }
    await sourceBatch(db, "tasker", now, async (batch) => {
      expect([...(await batch.existingIds())]).toEqual(["one"]);
      expect((await batch.existingJobs()).get("one")!.req("title")).toBe(first.req("title"));
    });
    expect(await list(db, now)).toHaveLength(1);
  });

  it("rolls back the entire batch and its health on a receipt collision", async () => {
    await setSourceHealth(db, "tasker", "failed");
    const outcome = sourceBatch(db, "tasker", now, async (batch) => {
      await batch.ingest(job({ source: "tasker", external_id: "one" }), "same");
      await batch.finish("ok");
      await batch.ingest(job({ source: "tasker", external_id: "two" }), "same");
    });
    expect(await pyType(outcome)).toBe("Conflict");
    expect(await list(db, now)).toEqual([]);
    expect((await sourcesIn(db)).req("tasker")).toBe("failed");
  });

  it("rejects another source without writing", async () => {
    const outcome = sourceBatch(db, "tasker", now, (batch) => batch.ingest(job({ source: "freelancer" }), "wrong"));
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
