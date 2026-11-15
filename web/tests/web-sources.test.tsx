import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sourcesPage } from "@/services/pages";
import { SourcesTable } from "@/app/_lib/views";
import { PyError } from "@/platform/py/value";
import { db, leased, resetSchema } from "./helpers/db";

// Plan step 11: /sources and the page usage log, on the D1 stand-in. /sources reads D1 until plan
// step 6 rewrites it over runs and run_sources (the other pages moved to Postgres in step 3c,
// tests/web-pages.test.tsx); withPageDb is used by /sources only.

beforeEach(async () => resetSchema());

describe("sources page", () => {
  it("shows the latest daily run and each source's daily details", async () => {
    await leased("insert into daily_runs values ('2026-11-03', 'running', '2026-11-03T01:00:00+00:00', null, null)");
    await leased("insert into daily_runs values ('2026-11-02', 'failed', '2026-11-02T01:00:00+00:00', '2026-11-02T01:05:00+00:00', ?1)",
      [JSON.stringify({ status: "source_failed", source_reason: "one_or_more_sources_failed", source_details: { status: "failed", reason: "x", tasker: { status: "ok", seen: 12, jobs: 3 }, freelancer: { status: "partial", seen: 4 }, arbeitnow: { status: "failed", reason: "arbeitnow_source_unavailable_or_unsupported", error: "http_429" } } })]);
    const running = await sourcesPage(db);
    expect(running.lastRun).toMatchObject({ localDate: "2026-11-03", status: "running" });
    expect(renderToStaticMarkup(<SourcesTable data={running} />)).toContain("執行中，需核對是否中斷");
    await leased("delete from daily_runs where local_date = '2026-11-03'");
    const html = renderToStaticMarkup(<SourcesTable data={await sourcesPage(db)} />);
    expect(html).toContain("讀取 12 筆 · 初篩 3 筆");
    expect(html).toContain("one_or_more_sources_failed");
    expect(html).toContain("部分資料取得 · 讀取 4 筆");
    expect(html).toContain("錯誤種類 http_429 · 原因 arbeitnow_source_unavailable_or_unsupported");
  });

  // Plan step 14: nothing runs check-storage-triggers daily any more, so the page shows the last week's signals.
  it("shows the storage signals of the runs in the week up to the latest one, and says when there are none", async () => {
    const run = (date: string, usage: object) => leased("insert into daily_runs values (?1, 'complete', ?2, ?2, ?3)",
      [date, `${date}T01:00:00+00:00`, JSON.stringify({ status: "collected", d1_requests: 80, lease_wait_ms: 0, lease_timeouts: 0, lease_lost: 0, d1_errors: {}, lost_steps: 0, ...usage })]);
    await run("2026-11-10", {});
    await run("2026-11-09", { lost_steps: 1 });
    const quiet = await sourcesPage(db);
    expect(quiet.signals).toEqual({ runs: 2, reopened: [] });
    expect(renderToStaticMarkup(<SourcesTable data={quiet} />)).toContain("近 7 天 2 次執行沒有訊號");
    await run("2026-11-03", { lease_timeouts: 5 });
    await run("2026-11-04", { d1_requests: 601 });
    await run("2026-11-08", { cross_source_title_pairs: 3 });
    const loud = await sourcesPage(db);
    expect(loud.signals.runs).toBe(4);
    expect(loud.signals.reopened.map((s) => [s.localDate, s.decision, s.signal, s.value])).toEqual([
      ["2026-11-04", "D21", "requests_over_limit", 601], ["2026-11-08", "D18", "cross_source_title_pairs", 3]]);
    const html = renderToStaticMarkup(<SourcesTable data={loud} />);
    expect(html).toContain("2026-11-04 · 單次執行的 D1 請求數超過 600：601");
    expect(html).toContain("2026-11-08 · 跨來源同職稱達 3 組：3");
    expect(html).not.toContain("沒有訊號");
  });
});

class KeyErrorLike extends PyError { constructor() { super("KeyError", "missing"); } }

describe("page usage log", () => {
  it("logs each page request's D1 usage, also when it throws", async () => {
    const { withPageDb } = await import("@/app/_lib/usage");
    const lines: string[] = [];
    const original = console.info;
    console.info = (line: string) => { lines.push(line); };
    try {
      await withPageDb("/sources", sourcesPage, db);
      await expect(withPageDb("/sources", async () => { throw new KeyErrorLike(); }, db)).rejects.toBeInstanceOf(KeyErrorLike);
    } finally {
      console.info = original;
    }
    // The test database's client is shared, so its counters include earlier tests; a page gets a fresh one.
    expect(lines[0]).toMatch(/^page usage \/sources outcome=ok ms=\d+ d1_requests=[1-9]\d* rows_read=\d+ rows_written=\d+ read_retries=\d+ lease_wait_ms=\d+$/);
    expect(lines[1]).toMatch(/^page usage \/sources outcome=KeyError /);
  });
});

describe("Postgres page log", () => {
  it("logs route, outcome and time, also when the page throws", async () => {
    const { withPageLog } = await import("@/app/_lib/usage");
    const lines: string[] = [];
    const original = console.info;
    console.info = (line: string) => { lines.push(line); };
    try {
      await withPageLog("/settings", async () => 1);
      await expect(withPageLog("/jobs/[id]", async () => { throw new KeyErrorLike(); })).rejects.toBeInstanceOf(KeyErrorLike);
    } finally {
      console.info = original;
    }
    expect(lines[0]).toMatch(/^page \/settings outcome=ok ms=\d+$/);
    expect(lines[1]).toMatch(/^page \/jobs\/\[id\] outcome=KeyError ms=\d+$/);
  });
});
