import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { finishRun, openRun, recordSource, sourcesReadSince, taipeiDate } from "@/modules/runs/public";
import { freshPg } from "../../../tests/helpers/pg";

// Plan step 6: the run records.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate runs cascade`));

const at = (iso: string) => new Date(iso);
const row = (source: string, status: "ok" | "failed", finishedAt: Date) => ({ source, status, reason: null, error: null, counts: {}, startedAt: finishedAt, finishedAt });

describe("run records", () => {
  it("dates a run by the Asia/Taipei day", () => {
    expect(taipeiDate(at("2026-11-15T15:59:59Z"))).toBe("2026-11-15");
    expect(taipeiDate(at("2026-11-15T16:00:00Z"))).toBe("2026-11-16");
  });

  it("claims a day once, reopens it with the ok sources while not succeeded, and keeps a succeeded day closed", async () => {
    const first = await openRun(db, "2026-11-16", at("2026-11-16T06:00:00Z"));
    expect(first.outcome).toBe("started");
    await recordSource(db, first.runId, row("a", "ok", at("2026-11-16T06:01:00Z")));
    await recordSource(db, first.runId, row("b", "failed", at("2026-11-16T06:02:00Z")));
    await finishRun(db, first.runId, "failed", "x", {}, at("2026-11-16T06:03:00Z"));
    const again = await openRun(db, "2026-11-16", at("2026-11-16T07:00:00Z"));
    expect(again).toEqual({ outcome: "resumed", runId: first.runId, done: new Set(["a"]) });
    // A second attempt replaces the source's row.
    await recordSource(db, first.runId, row("b", "ok", at("2026-11-16T07:01:00Z")));
    await finishRun(db, first.runId, "succeeded", null, {}, at("2026-11-16T07:02:00Z"));
    expect(await openRun(db, "2026-11-16", at("2026-11-16T08:00:00Z"))).toEqual({ outcome: "done", runId: first.runId });
  });

  it("names the sources with an ok row since a time, among those asked", async () => {
    const r = await openRun(db, "2026-11-16", at("2026-11-16T06:00:00Z"));
    await recordSource(db, r.runId, row("a", "ok", at("2026-11-16T06:01:00Z")));
    await recordSource(db, r.runId, row("b", "failed", at("2026-11-16T06:01:00Z")));
    await recordSource(db, r.runId, row("c", "ok", at("2026-10-01T06:01:00Z")));
    expect(await sourcesReadSince(db, at("2026-11-01T00:00:00Z"), ["a", "b", "c"])).toEqual(["a"]);
    expect(await sourcesReadSince(db, at("2026-11-01T00:00:00Z"), ["b"])).toEqual([]);
  });
});
