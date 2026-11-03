import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ingestSource, opportunityId, type Listing } from "@/modules/collection/public";
import { readSettings } from "@/modules/discovery/public";
import { NotFound } from "@/platform/errors";
import { PyDateTime } from "@/platform/py/datetime";
import { track } from "@/services/discovery";
import { jobDetail, listJobs, listQuery, PAGE_SIZE, settingsPage, sourcesPage } from "@/services/pages";
import { handleFeedback, handleSettings, type WriteDeps } from "@/app/_lib/writes";
import { JobDetail, JobList, SettingsForm, SourcesTable } from "@/app/_lib/views";
import { db, leased, query, resetSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

// Plan step 11: the pages' loaders, the two write routes and the markup, on the D1 stand-in.

const now = new PyDateTime(2026, 11, 3, 2, 0, 0, 0, 0n);
const key = (externalId: string) => opportunityId("tasker", externalId);
const listing = (externalId: string, changes: Record<string, unknown> = {}): Listing =>
  [job({ source: "tasker", external_id: externalId, ...changes }), null];

beforeEach(async () => {
  await resetSchema();
  const many = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => listing(`c${String(i).padStart(3, "0")}`));
  await ingestSource(db, "tasker", now, [...many, listing("liked"), listing("skipped"), listing("design", { title: "Logo design", description: "Brand refresh" })], () => true, "ok");
  await track(db, key("liked"), 0n, { feedback: "interested" }, now);
  await track(db, key("skipped"), 0n, { feedback: "skipped" }, now);
});

const deps = (writes = true): WriteDeps => ({ db, now: () => now, writes });
const form = (path: string, fields: [string, string][], headers: Record<string, string> = {}) =>
  new Request(`https://fa.example${path}`, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { host: "fa.example", origin: "https://fa.example", "content-type": "application/x-www-form-urlencoded", ...headers },
  });
const feedbackForm = (id: string, token: string, value: string, headers: Record<string, string> = {}) =>
  form(`/jobs/${id}/feedback`, [["token", token], ["value", value], ["back", `/jobs/${id}`]], headers);
const trackingOf = async (id: string) => (await query("select state from opportunity_tracking where opportunity_id = ?1", [id]))[0]?.state ?? null;
const settingsFields = (revision: string, hours = "20"): [string, string][] =>
  [["revision", revision], ["max_weekly_hours", hours], ["min_fixed_twd", "3000"], ["categories", "AI agent"], ["categories", "後端／API"], ["back", "/settings"]];

describe("list and detail", () => {
  it("pages the candidates 50 at a time, ranked, and says whether a next page exists", async () => {
    const first = await listJobs(db, now, "candidates", 1), second = await listJobs(db, now, "candidates", 2);
    expect(first.jobs).toHaveLength(PAGE_SIZE);
    expect(first.hasNext).toBe(true);
    // The saved listing ranks first (+10); the skipped one and the design one are not candidates.
    expect(first.jobs[0].id).toBe(key("liked"));
    expect([...first.jobs, ...second.jobs].map((j) => j.id)).not.toContain(key("skipped"));
    expect(second.hasNext).toBe(false);
    expect(first.jobs.length + second.jobs.length).toBe(PAGE_SIZE + 5 + 1);
    expect(first.jobs.every((j) => j.candidate)).toBe(true);
  });

  it("shows the saved, the skipped and all listings in their own views", async () => {
    expect((await listJobs(db, now, "saved", 1)).jobs.map((j) => j.id)).toEqual([key("liked")]);
    expect((await listJobs(db, now, "skipped", 1)).jobs.map((j) => j.id)).toEqual([key("skipped")]);
    const all = [...(await listJobs(db, now, "all", 1)).jobs, ...(await listJobs(db, now, "all", 2)).jobs];
    expect(all).toHaveLength(PAGE_SIZE + 5 + 3);
    expect(all.at(-1)!.candidate).toBe(false);
  });

  it("reads the query: unknown views and bad pages fall back to the first page of the candidates", () => {
    expect(listQuery({ view: "saved", page: "2" })).toEqual({ view: "saved", page: 2 });
    expect(listQuery({ view: "evil", page: "0" })).toEqual({ view: "candidates", page: 1 });
    expect(listQuery({ view: ["saved"], page: "1e3" })).toEqual({ view: "candidates", page: 1 });
  });

  it("shows one listing with its token, and a missing one is NotFound", async () => {
    const detail = await jobDetail(db, now, key("liked"));
    expect(detail.feedback).toBe("interested");
    expect(detail.token).toMatch(/:1$/);
    await expect(jobDetail(db, now, "missing")).rejects.toBeInstanceOf(NotFound);
  });
});

describe("feedback route", () => {
  it("refuses with 403 and writes nothing while writes are off", async () => {
    const detail = await jobDetail(db, now, key("c000"));
    const response = await handleFeedback(feedbackForm(key("c000"), detail.token, "interested"), key("c000"), deps(false));
    expect(response.status).toBe(403);
    expect(await trackingOf(key("c000"))).toBeNull();
  });

  it("saves with the token the page showed, then refuses that stale token with 409", async () => {
    const detail = await jobDetail(db, now, key("c000"));
    const saved = await handleFeedback(feedbackForm(key("c000"), detail.token, "interested"), key("c000"), deps());
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/jobs/${key("c000")}?notice=saved`);
    expect((await jobDetail(db, now, key("c000"))).feedback).toBe("interested");
    const stale = await handleFeedback(feedbackForm(key("c000"), detail.token, "skipped"), key("c000"), deps());
    expect(stale.status).toBe(409);
    expect((await jobDetail(db, now, key("c000"))).feedback).toBe("interested");
  });

  it("restores a skipped listing to the candidates", async () => {
    const detail = await jobDetail(db, now, key("skipped"));
    expect(detail.skipped).toBe(true);
    const restored = await handleFeedback(feedbackForm(key("skipped"), detail.token, "restore"), key("skipped"), deps());
    expect(restored.headers.get("location")).toBe(`/jobs/${key("skipped")}?notice=restored`);
    expect((await listJobs(db, now, "skipped", 1)).jobs).toHaveLength(0);
  });

  it("answers 400 to an unknown value, 404 to a missing listing, 403 to another origin and 413 past the limit", async () => {
    const detail = await jobDetail(db, now, key("c000"));
    expect((await handleFeedback(feedbackForm(key("c000"), detail.token, "applied"), key("c000"), deps())).status).toBe(400);
    expect((await handleFeedback(feedbackForm("missing", "x", "interested"), "missing", deps())).status).toBe(404);
    expect((await handleFeedback(feedbackForm(key("c000"), detail.token, "interested", { origin: "https://evil.example" }), key("c000"), deps())).status).toBe(403);
    const big = form(`/jobs/${key("c000")}/feedback`, [["token", detail.token], ["value", "interested"], ["pad", "x".repeat(20_000)]]);
    expect((await handleFeedback(big, key("c000"), deps())).status).toBe(413);
    expect(await trackingOf(key("c000"))).toBeNull();
  });

  it("un-saving says so, not 'restored'", async () => {
    const detail = await jobDetail(db, now, key("liked"));
    const response = await handleFeedback(feedbackForm(key("liked"), detail.token, "unsave"), key("liked"), deps());
    expect(response.headers.get("location")).toBe(`/jobs/${key("liked")}?notice=unsaved`);
    expect((await jobDetail(db, now, key("liked"))).feedback).toBe("neutral");
  });

  it("refuses prototype keys and the bare feedback value as button values", async () => {
    const detail = await jobDetail(db, now, key("c000"));
    for (const value of ["constructor", "__proto__", "neutral"]) {
      expect((await handleFeedback(feedbackForm(key("c000"), detail.token, value), key("c000"), deps())).status).toBe(400);
    }
  });

  it("answers 500 with 'result unknown', not 400, when stored data is corrupt", async () => {
    const detail = await jobDetail(db, now, key("liked"));
    await leased("update opportunity_tracking set state = '{bad' where opportunity_id = ?1", [key("liked")]);
    const response = await handleFeedback(feedbackForm(key("liked"), detail.token, "unsave"), key("liked"), deps());
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("結果未知");
  });

  it("sends the person back only within the site", async () => {
    const detail = await jobDetail(db, now, key("c000"));
    const request = form(`/jobs/${key("c000")}/feedback`, [["token", detail.token], ["value", "interested"], ["back", "//evil.example/x"]]);
    expect((await handleFeedback(request, key("c000"), deps())).headers.get("location")).toBe("/?notice=saved");
  });
});

describe("settings route", () => {
  it("refuses with 403 and keeps the settings while writes are off", async () => {
    expect((await handleSettings(form("/settings/save", settingsFields("0")), deps(false))).status).toBe(403);
    expect((await readSettings(db)).revision).toBe(0n);
  });

  it("saves at the revision the page showed, then refuses that stale revision with 409", async () => {
    const before = await settingsPage(db);
    const saved = await handleSettings(form("/settings/save", settingsFields(String(before.revision))), deps());
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/settings?notice=settings");
    const after = await settingsPage(db);
    expect(after).toMatchObject({ revision: 1, maxWeeklyHours: 20, minFixedTwd: 3000, categories: ["AI agent", "後端／API"] });
    expect((await handleSettings(form("/settings/save", settingsFields(String(before.revision), "30")), deps())).status).toBe(409);
    expect((await settingsPage(db)).maxWeeklyHours).toBe(20);
  });

  it("leaves the ranges to preferences(): out of range and not an integer are both 400", async () => {
    expect((await handleSettings(form("/settings/save", settingsFields("0", "200")), deps())).status).toBe(400);
    expect((await handleSettings(form("/settings/save", settingsFields("0", "2.5")), deps())).status).toBe(400);
    const none = form("/settings/save", [["revision", "0"], ["max_weekly_hours", ""], ["min_fixed_twd", "3000"]]);
    expect((await handleSettings(none, deps())).status).toBe(400);
    expect((await readSettings(db)).revision).toBe(0n);
  });

  it("an empty hours field means no limit", async () => {
    const fields = settingsFields("0", "");
    expect((await handleSettings(form("/settings/save", fields), deps())).status).toBe(303);
    expect((await settingsPage(db)).maxWeeklyHours).toBeNull();
  });
});

describe("markup", () => {
  it("disables every write button while writes are off, and enables them when on", async () => {
    const detail = await jobDetail(db, now, key("c000")), settings = await settingsPage(db);
    for (const html of [renderToStaticMarkup(<JobDetail job={detail} writes={false} />), renderToStaticMarkup(<SettingsForm data={settings} writes={false} />)]) {
      expect(html.match(/<button/g)!.length).toBe(html.match(/<button[^>]* disabled=""/g)!.length);
      expect(html).toContain("切換到正式系統後開放");
    }
    expect(renderToStaticMarkup(<JobDetail job={detail} writes />)).not.toContain('disabled=""');
  });

  it("links the record's own URL and every content version's source", async () => {
    const detail = await jobDetail(db, now, key("c000"));
    const html = renderToStaticMarkup(<JobDetail job={{ ...detail, job: { ...detail.job, url: "https://other.example/v2" } }} writes />);
    expect(html).toContain('href="https://www.freelancer.com/projects/example-c000"');
  });

  it("escapes listing text and links only https listing URLs", async () => {
    await ingestSource(db, "tasker", now, [listing("x", { title: "<script>alert(1)</script>", url: "javascript:alert(1)" })], () => true, "ok");
    const html = renderToStaticMarkup(<JobDetail job={await jobDetail(db, now, key("x"))} writes />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    const list = renderToStaticMarkup(<JobList data={await listJobs(db, now, "candidates", 1)} />);
    expect(list).toContain(`href="/jobs/${key("liked")}"`);
    expect(list).toContain('href="/?view=candidates&amp;page=2"');
  });

  it("shows the latest daily run and each source's daily details", async () => {
    await leased("insert into daily_runs values ('2026-11-03', 'r', 'running', '2026-11-03T01:00:00+00:00', null, null)");
    await leased("insert into daily_runs values ('2026-11-02', 'r', 'failed', '2026-11-02T01:00:00+00:00', '2026-11-02T01:05:00+00:00', ?1)",
      [JSON.stringify({ status: "source_failed", source_reason: "one_or_more_sources_failed", source_details: { status: "failed", reason: "x", tasker: { status: "ok", seen: 12, jobs: 3 }, freelancer: { status: "partial", seen: 4 } } })]);
    const running = await sourcesPage(db);
    expect(running.lastRun).toMatchObject({ localDate: "2026-11-03", status: "running" });
    expect(renderToStaticMarkup(<SourcesTable data={running} />)).toContain("執行中，需核對是否中斷");
    await leased("delete from daily_runs where local_date = '2026-11-03'");
    const html = renderToStaticMarkup(<SourcesTable data={await sourcesPage(db)} />);
    expect(html).toContain("讀取 12 筆 · 初篩 3 筆");
    expect(html).toContain("one_or_more_sources_failed");
    expect(html).toContain("部分資料取得 · 讀取 4 筆");
  });
});

describe("page usage log", () => {
  it("logs each page request's D1 usage, also when it throws", async () => {
    const { withPageDb } = await import("@/app/_lib/usage");
    const lines: string[] = [];
    const original = console.info;
    console.info = (line: string) => { lines.push(line); };
    try {
      await withPageDb("/settings", settingsPage, db);
      await expect(withPageDb("/jobs/[id]", (d) => jobDetail(d, now, "missing"), db)).rejects.toBeInstanceOf(NotFound);
    } finally {
      console.info = original;
    }
    // The test database's client is shared, so its counters include earlier tests; a page gets a fresh one.
    expect(lines[0]).toMatch(/^page usage \/settings outcome=ok ms=\d+ d1_requests=[1-9]\d* rows_read=\d+ rows_written=\d+ read_retries=\d+ lease_wait_ms=\d+$/);
    expect(lines[1]).toMatch(/^page usage \/jobs\/\[id\] outcome=KeyError /);
  });
});
