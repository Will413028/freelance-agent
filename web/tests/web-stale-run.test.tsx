import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { runs, runSources } from "@/db/pg/schema";
import { runStale, sourcesPage, STALE_RUN_HOURS } from "@/services/pages";
import { SourcesTable, StaleLine } from "@/app/_lib/views";
import { freshPg } from "./helpers/pg";

// Plan step 6b: the listing page and /sources say so when no source has been read successfully for over 26
// hours. Keyed on source reads, not the run's status: one failing source marks the whole run failed.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate runs cascade`));

const finished = new Date("2026-11-16T06:05:00Z");
const hours = (h: number) => new Date(finished.getTime() + h * 3_600_000);
const day = async (localDate: string, status: "succeeded" | "failed" | "running", sources: [string, "ok" | "failed", Date][]) => {
  const [r] = await db.insert(runs).values({ localDate, status, startedAt: sources[0]?.[2] ?? finished }).returning({ id: runs.id });
  for (const [source, s, at] of sources) await db.insert(runSources).values({ runId: r!.id, source, status: s, finishedAt: at });
};
const STALE = "每日收案最近一次成功讀取來源已超過 26 小時";

describe("stale run notice", () => {
  it("uses a 26-hour threshold", () => expect(STALE_RUN_HOURS).toBe(26));

  it("is absent 25 hours after the last ok source read and shown at 27", async () => {
    await day("2026-11-16", "succeeded", [["jobicy", "ok", finished]]);
    expect(await runStale(db, hours(25))).toBeNull();
    expect(await runStale(db, hours(27))).toEqual({ lastSuccessAt: finished.toISOString() });
  });

  it("counts a run marked failed by one failing source, but not a run where every source failed", async () => {
    expect(await runStale(db, hours(0))).toEqual({ lastSuccessAt: null });
    await day("2026-11-16", "failed", [["jobicy", "ok", finished], ["remotive", "failed", hours(0.1)]]);
    expect(await runStale(db, hours(25))).toBeNull();
    await day("2026-11-17", "failed", [["jobicy", "failed", hours(24)], ["remotive", "failed", hours(24.1)]]);
    expect(await runStale(db, hours(27))).toEqual({ lastSuccessAt: finished.toISOString() });
  });

  it("renders only when stale, on /sources and as the line the listing page shows", async () => {
    await day("2026-11-16", "succeeded", [["jobicy", "ok", finished]]);
    expect(renderToStaticMarkup(<SourcesTable data={await sourcesPage(db, hours(25))} />)).not.toContain(STALE);
    expect(renderToStaticMarkup(<SourcesTable data={await sourcesPage(db, hours(27))} />)).toContain(STALE);
    expect(renderToStaticMarkup(<StaleLine stale={await runStale(db, hours(25))} />)).toBe("");
    expect(renderToStaticMarkup(<StaleLine stale={await runStale(db, hours(27))} />)).toContain(STALE);
    await db.execute(sql`truncate runs cascade`);
    expect(renderToStaticMarkup(<SourcesTable data={await sourcesPage(db, hours(0))} />)).toContain("還沒有成功讀取過任何來源");
  });
});
