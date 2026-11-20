import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listings, runs, runSources } from "@/db/pg/schema";
import { intakeListings, listingBy } from "@/modules/listings/public";
import { SourceError, type SourceSettings } from "@/modules/sources/public";
import { FetchError } from "@/platform/fetch";
import type { SourceRun } from "./collect";
import { RETRY_DELAYS_MS, runDaily, type DailyDeps } from "./run-daily";
import { freshPg } from "../../tests/helpers/pg";

// Plan step 6: the daily run over runs and run_sources (replaces tests/daily.test.ts's Vercel Workflow cases for the new system).

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate runs, listings cascade`));

const NOW = new Date("2026-11-16T06:00:00Z"); // 14:00 Asia/Taipei
const src = (name: string, order: number, disabled: string | null = null) => ({ name, order, disabled }) as SourceSettings;
const ok = (source: string): SourceRun => ({ source, seen: 2, stored: 2, requests: 1, intake: { inserted: 2, updated: 0, unchanged: 0, versioned: 0 }, externalIds: [], truncated: false, rejected: 0, examined: 2 });

/** Deps whose collect answers from `script`: per source, a list of outcomes, one per call (an Error throws). */
function deps(sources: SourceSettings[], script: Record<string, (SourceRun | Error)[]>, now = NOW) {
  const calls: string[] = [], sleeps: number[] = [];
  const d: DailyDeps = {
    now: () => now, sources, sleep: async (ms) => { sleeps.push(ms); },
    collect: async (_db, s) => {
      calls.push(s.name);
      const next = script[s.name]?.shift() ?? ok(s.name);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { d, calls, sleeps };
}
const rowsOf = async () => (await db.select().from(runSources)).sort((a, b) => a.source.localeCompare(b.source));

describe("runDaily", () => {
  it("runs enabled sources in catalog order, records each, and does not run a succeeded day again", async () => {
    const t = deps([src("b", 20), src("a", 10), src("off", 5, "blocked")], {});
    expect(await runDaily(db, t.d)).toMatchObject({ outcome: "succeeded", localDate: "2026-11-16", ran: ["a", "b"] });
    expect(t.calls).toEqual(["a", "b"]);
    expect((await rowsOf()).map((r) => [r.source, r.status, (r.counts as Record<string, unknown>).seen])).toEqual([["a", "ok", 2], ["b", "ok", 2]]);
    const again = deps([src("a", 10), src("b", 20)], {});
    expect(await runDaily(db, again.d)).toMatchObject({ outcome: "done" });
    expect(again.calls).toEqual([]);
  });

  it("keeps going after a failed source, marks the day failed, and a rerun does only what is not ok yet", async () => {
    const first = deps([src("a", 10), src("b", 20), src("c", 30)], { b: [new SourceError("format changed")] });
    expect(await runDaily(db, first.d)).toMatchObject({ outcome: "failed" });
    expect(first.calls).toEqual(["a", "b", "c"]);
    const [run] = await db.select().from(runs);
    expect([run!.status, run!.reason]).toEqual(["failed", "one_or_more_sources_failed"]);
    expect((await rowsOf()).map((r) => [r.source, r.status, r.reason])).toEqual([["a", "ok", null], ["b", "failed", "bad_payload"], ["c", "ok", null]]);
    const rerun = deps([src("a", 10), src("b", 20), src("c", 30)], {});
    expect(await runDaily(db, rerun.d)).toMatchObject({ outcome: "succeeded", ran: ["b"], skipped: ["a", "c"] });
    expect(rerun.calls).toEqual(["b"]);
    expect((await db.select().from(runs)).length).toBe(1);
  });

  it("records the tier each source read with, ok or failed (plan step 8c)", async () => {
    const tiered = (name: string, order: number, maxTier: string) => ({ ...src(name, order), maxTier }) as SourceSettings;
    await runDaily(db, deps([tiered("a", 10, "plain"), tiered("b", 20, "browser_like"), tiered("c", 30, "browser_like")], { c: [new SourceError("blocked")] }).d);
    expect((await rowsOf()).map((r) => [r.source, r.status, r.tier])).toEqual([["a", "ok", "plain"], ["b", "ok", "browser_like"], ["c", "failed", "browser_like"]]);
  });

  it("finishes a killed run: a day left running resumes with the sources not yet ok", async () => {
    await runDaily(db, deps([src("a", 10)], {}).d);
    // A kill after source a: the run row stays running and b has no row.
    await db.update(runs).set({ status: "running", finishedAt: null });
    const rerun = deps([src("a", 10), src("b", 20)], {});
    expect(await runDaily(db, rerun.d)).toMatchObject({ outcome: "succeeded", ran: ["b"], skipped: ["a"] });
    expect((await rowsOf()).map((r) => r.source)).toEqual(["a", "b"]);
  });

  it("retries a transient read error after 30 s and succeeds", async () => {
    const t = deps([src("a", 10)], { a: [new FetchError("http_status", "429", 429)] });
    expect(await runDaily(db, t.d)).toMatchObject({ outcome: "succeeded" });
    expect([t.calls, t.sleeps]).toEqual([["a", "a"], [30_000]]);
    expect(((await rowsOf())[0]!.counts as Record<string, unknown>).attempts).toBe(2);
  });

  it("gives up after two retries of transient errors and records the error kind", async () => {
    const t = deps([src("a", 10)], { a: [new FetchError("timeout", "t"), new FetchError("network", "n"), new FetchError("http_status", "503", 503)] });
    expect(await runDaily(db, t.d)).toMatchObject({ outcome: "failed" });
    expect([t.calls.length, t.sleeps]).toEqual([3, [...RETRY_DELAYS_MS]]);
    const [row] = await rowsOf();
    expect([row!.status, row!.reason, row!.error, (row!.counts as Record<string, unknown>).attempts]).toEqual(["failed", "http_status", "http_503", 3]);
  });

  it("does not retry a non-transient error", async () => {
    for (const e of [new FetchError("http_status", "404", 404), new SourceError("bad"), new Error("bug")]) {
      await db.execute(sql`truncate runs cascade`);
      const t = deps([src("a", 10)], { a: [e] });
      await runDaily(db, t.d);
      expect([t.calls.length, t.sleeps]).toEqual([1, []]);
    }
    expect((await rowsOf())[0]!.reason).toBe("internal");
    expect((await rowsOf())[0]!.error).toBe("Error");
  });

  it("stores an error code, never the error's message", async () => {
    await runDaily(db, deps([src("a", 10)], { a: [new SyntaxError("Unexpected token '<', \"<!DOCTYPE html>secret listing text\" is not valid JSON")] }).d);
    const [row] = await rowsOf();
    expect([row!.reason, row!.error]).toEqual(["internal", "SyntaxError"]);
  });

  it("does not start before 09:00 Asia/Taipei (a timer catch-up) and writes nothing", async () => {
    const t = deps([src("a", 10)], {}, new Date("2026-11-16T00:59:00Z"));
    expect(await runDaily(db, t.d)).toMatchObject({ outcome: "not_due", localDate: "2026-11-16" });
    expect([t.calls, await db.select().from(runs)]).toEqual([[], []]);
  });

  it("closes an earlier day left running as interrupted when a new day starts", async () => {
    await runDaily(db, deps([src("a", 10)], {}, new Date("2026-11-15T06:00:00Z")).d);
    await db.update(runs).set({ status: "running", finishedAt: null });
    await runDaily(db, deps([src("a", 10)], {}).d);
    const all = (await db.select().from(runs)).sort((x, y) => x.localDate.localeCompare(y.localDate));
    expect(all.map((r) => [r.localDate, r.status, r.reason])).toEqual([["2026-11-15", "failed", "interrupted"], ["2026-11-16", "succeeded", null]]);
  });

  it("finishes the day failed when a record write throws, so the next start resumes it", async () => {
    const t = deps([src("a", 10)], {});
    let broke = false;
    const real = t.d.collect!;
    t.d.collect = async (d, s, now) => { const r = await real(d, s, now); if (!broke) { broke = true; await db.execute(sql`alter table run_sources rename to run_sources_x`); } return r; };
    await expect(runDaily(db, t.d)).rejects.toThrow();
    await db.execute(sql`alter table run_sources_x rename to run_sources`);
    const [run] = await db.select().from(runs);
    expect([run!.status, run!.reason?.startsWith("internal: ")]).toEqual(["failed", true]);
  });

  it("prunes only the sources read successfully within the retention days, and records pruned and the list timing", async () => {
    const old = new Date(NOW.getTime() - 40 * 86_400_000);
    const job = (id: string) => ({ external_id: id, title: "Backend API contractor", url: `https://example.com/jobs/${id}`, kind: "contract" });
    await intakeListings(db, "a", [job("1")], "page", old);
    await intakeListings(db, "b", [job("2")], "page", old);
    await runDaily(db, deps([src("a", 10), src("b", 20)], { b: [new SourceError("bad")] }).d);
    expect(await listingBy(db, "a", "1")).toBeNull();
    expect(await listingBy(db, "b", "2")).not.toBeNull();
    const [run] = await db.select().from(runs);
    const counts = run!.counts as Record<string, unknown>;
    expect(counts.pruned).toBe(1);
    expect(typeof counts.listMs).toBe("number");
  });

  it("re-evaluates rows of an older rule version before it times the list page (plan D26)", async () => {
    const job = { external_id: "1", title: "Backend API contractor", description: "Build an LLM automation backend", url: "https://example.com/jobs/1", kind: "contract" };
    await intakeListings(db, "a", [job], "page", NOW);
    await db.update(listings).set({ hardExcluded: true, evaluatedWith: 0 });
    await runDaily(db, deps([src("a", 10)], {}).d);
    expect((await listingBy(db, "a", "1"))?.hardExcluded).toBe(false);
    const [run] = await db.select().from(runs);
    expect((run!.counts as Record<string, unknown>).reevaluated).toBe(1);
  });

  it("still prunes and times the list page when re-evaluation fails", async () => {
    const old = new Date(NOW.getTime() - 40 * 86_400_000);
    await intakeListings(db, "a", [{ external_id: "1", title: "Backend API contractor", url: "https://example.com/jobs/1", kind: "contract" }], "page", old);
    await db.update(listings).set({ evaluatedWith: 0 });
    // Only the re-evaluation's UPDATE fails; reads and deletes go on.
    await db.execute(sql`create function refuse() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`);
    await db.execute(sql`create trigger refuse before update of evaluated_with on listings for each row execute function refuse()`);
    try {
      await runDaily(db, deps([src("a", 10)], {}).d);
    } finally {
      await db.execute(sql`drop trigger refuse on listings`);
      await db.execute(sql`drop function refuse()`);
    }
    const [run] = await db.select().from(runs);
    expect([run!.status, run!.reason?.startsWith("reevaluate_failed: ")]).toEqual(["failed", true]);
    const counts = run!.counts as Record<string, unknown>;
    expect(counts.pruned).toBe(1);
    expect(typeof counts.listMs).toBe("number");
  });
});
