import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { runs } from "@/db/pg/schema";
import { listJobs, runStale, sourcesPage, STALE_RUN_HOURS } from "@/services/pages";
import { JobList, SourcesTable } from "@/app/_lib/views";
import { freshPg } from "./helpers/pg";

// Plan step 6b: the listing page and /sources say so when the last succeeded daily run is over 26 hours old.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate runs cascade`));

const finished = new Date("2026-11-16T06:05:00Z");
const hours = (h: number) => new Date(finished.getTime() + h * 3_600_000);
const succeeded = (localDate: string, finishedAt: Date) => db.insert(runs).values({ localDate, status: "succeeded", startedAt: finishedAt, finishedAt });
const LINE = "每日收案";

describe("stale run notice", () => {
  it("uses a 26-hour threshold", () => expect(STALE_RUN_HOURS).toBe(26));

  it("is absent 25 hours after the last succeeded run and shown at 27", async () => {
    await succeeded("2026-11-16", finished);
    expect(await runStale(db, hours(25))).toBeNull();
    const at27 = await runStale(db, hours(27));
    expect(at27).toEqual({ lastSuccessAt: finished.toISOString() });
  });

  it("is shown when no run ever succeeded, and ignores a later failed or running day", async () => {
    expect(await runStale(db, hours(0))).toEqual({ lastSuccessAt: null });
    await succeeded("2026-11-16", finished);
    await db.insert(runs).values({ localDate: "2026-11-17", status: "failed", startedAt: hours(24), finishedAt: hours(24.1) });
    await db.insert(runs).values({ localDate: "2026-11-18", status: "running", startedAt: hours(48) });
    expect(await runStale(db, hours(48))).toEqual({ lastSuccessAt: finished.toISOString() });
  });

  it("renders on the listing page and /sources only when stale", async () => {
    await succeeded("2026-11-16", finished);
    const fresh = renderToStaticMarkup(<JobList data={await listJobs(db, hours(25), "all", 1)} />);
    expect(fresh).not.toContain("超過 26 小時");
    const list = renderToStaticMarkup(<JobList data={await listJobs(db, hours(27), "all", 1)} />);
    expect(list).toContain(`最近一次成功的${LINE}已超過 26 小時`);
    const sources = renderToStaticMarkup(<SourcesTable data={await sourcesPage(db, hours(27))} />);
    expect(sources).toContain(`最近一次成功的${LINE}已超過 26 小時`);
    await db.execute(sql`truncate runs cascade`);
    expect(renderToStaticMarkup(<SourcesTable data={await sourcesPage(db, hours(0))} />)).toContain(`還沒有成功的${LINE}`);
  });
});
