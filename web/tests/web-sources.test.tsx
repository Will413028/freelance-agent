import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { runs, runSources } from "@/db/pg/schema";
import { sourcesPage } from "@/services/pages";
import { SourcesTable } from "@/app/_lib/views";
import { NotFound } from "@/platform/errors";
import { freshPg } from "./helpers/pg";

// Plan step 6: /sources reads runs and run_sources on Postgres; the page log.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate runs cascade`));

const run = async (localDate: string, status: "running" | "succeeded" | "failed", extra: Partial<typeof runs.$inferInsert> = {}) =>
  (await db.insert(runs).values({ localDate, status, startedAt: new Date(`${localDate}T06:00:00Z`), ...extra }).returning({ id: runs.id }))[0]!.id;

describe("sources page", () => {
  it("shows the latest run, each catalog source's latest row across runs, and sources not run yet", async () => {
    const earlier = await run("2026-11-15", "succeeded", { finishedAt: new Date("2026-11-15T06:05:00Z") });
    await db.insert(runSources).values({ runId: earlier, source: "jobicy", status: "ok", counts: { seen: 9, stored: 9, inserted: 3, jobs: 2 }, finishedAt: new Date("2026-11-15T06:01:00Z") });
    const latest = await run("2026-11-16", "failed", { reason: "one_or_more_sources_failed", counts: { pruned: 4, listMs: 80 }, finishedAt: new Date("2026-11-16T06:05:00Z") });
    await db.insert(runSources).values({ runId: latest, source: "remotive", status: "failed", reason: "http_status", error: "FetchError: 503", counts: { attempts: 3 } });
    await db.insert(runSources).values({ runId: latest, source: "arbeitnow", status: "ok", counts: { seen: 4210, rejected: 2, truncated: true, attempts: 2 } });
    const view = await sourcesPage(db);
    expect(view.lastRun).toMatchObject({ localDate: "2026-11-16", status: "failed", pruned: 4, listMs: 80, listSlow: false });
    const by = Object.fromEntries(view.sources.map((s) => [s.source, s.latest]));
    expect(by.jobicy).toMatchObject({ localDate: "2026-11-15", status: "ok" });
    expect(by.himalayas).toBeNull();
    const html = renderToStaticMarkup(<SourcesTable data={view} />);
    expect(html).toContain("部分來源或處理失敗");
    expect(html).toContain("原因：one_or_more_sources_failed");
    expect(html).toContain("保留期限刪除 4 筆");
    expect(html).toContain("讀取 9 筆 · 寫入 9 筆 · 新增 3 筆 · 初篩 2 筆");
    expect(html).toContain("嘗試 3 次 · 錯誤種類 http_status");
    expect(html).toContain("讀取 4210 筆 · 拒收 2 筆 · 本次讀取未完整 · 嘗試 2 次");
    expect(html).toContain("尚未執行");
    expect(html).not.toContain("FetchError");
  });

  it("flags a run whose list query took longer than the budget, and says when there is no run", async () => {
    expect(renderToStaticMarkup(<SourcesTable data={await sourcesPage(db)} />)).toContain("尚無每日執行紀錄");
    await run("2026-11-16", "running", { counts: { listMs: 400 } });
    const view = await sourcesPage(db);
    expect(view.lastRun).toMatchObject({ listSlow: true });
    const html = renderToStaticMarkup(<SourcesTable data={view} />);
    expect(html).toContain("清單頁查詢 400 ms，超過 250 ms 上限");
    expect(html).toContain("執行中，或中斷待下次接續");
  });
});

describe("Postgres page log", () => {
  it("logs route, outcome and time, also when the page throws", async () => {
    const { withPageLog } = await import("@/app/_lib/page-log");
    const lines: string[] = [];
    const original = console.info;
    console.info = (line: string) => { lines.push(line); };
    try {
      await withPageLog("/settings", async () => 1);
      await expect(withPageLog("/jobs/[id]", async () => { throw new NotFound("missing"); })).rejects.toBeInstanceOf(NotFound);
    } finally {
      console.info = original;
    }
    expect(lines[0]).toMatch(/^page \/settings outcome=ok ms=\d+$/);
    expect(lines[1]).toMatch(/^page \/jobs\/\[id\] outcome=NotFound ms=\d+$/);
  });
});
