import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingFeedback, listingFeedbackEvents } from "@/db/pg/schema";
import { readSettings } from "@/modules/evaluation/public";
import { intakeListings, listingBy } from "@/modules/listings/public";
import { setFeedback } from "@/modules/review/public";
import { NotFound } from "@/platform/errors";
import { jobDetail, listJobs, listQuery, PAGE_SIZE, settingsPage, writeFeedback } from "@/services/pages";
import { handleFeedback, handleSettings, type WriteDeps } from "@/app/_lib/writes";
import { JobDetail, JobList, SettingsForm } from "@/app/_lib/views";
import { freshPg } from "./helpers/pg";

// Plan step 3c: the list, detail and settings pages' loaders, the two write routes and the markup, on
// Postgres (PGlite here, a real server in CI). Each case of the step 11 D1 version has its
// counterpart here; /sources and the D1 usage log stay on D1 in tests/web-sources.test.tsx.

const SOURCE = "jobicy";
const now = new Date("2026-11-03T02:00:00Z");
const job = (externalId: string, changes: Record<string, unknown> = {}) => ({
  external_id: externalId, title: "Backend API contractor", description: "Build an LLM automation backend",
  url: `https://example.com/jobs/${externalId}`, kind: "contract", published_at: "2026-11-02T00:00:00Z", ...changes,
});

let db: PgDb, close: () => Promise<void>;
/** A listing's surrogate id as a URL carries it. */
const key = async (externalId: string, source = SOURCE) => String((await listingBy(db, source, externalId))!.id);
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());

beforeEach(async () => {
  await db.execute(sql`truncate listings, settings cascade`);
  const many = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => job(`c${String(i).padStart(3, "0")}`));
  await intakeListings(db, SOURCE, [...many, job("liked"), job("skipped"), job("design", { title: "Logo design", description: "Brand refresh" })], "page", now);
  await setFeedback(db, +await key("liked"), "0", "interested", now);
  await setFeedback(db, +await key("skipped"), "0", "skipped", now);
});

const deps = (): WriteDeps => ({ db: () => db, now: () => now });
const form = (path: string, fields: [string, string][], headers: Record<string, string> = {}) =>
  new Request(`https://fa.example${path}`, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { host: "fa.example", origin: "https://fa.example", "content-type": "application/x-www-form-urlencoded", ...headers },
  });
const feedbackForm = (id: string, token: string, value: string, headers: Record<string, string> = {}) =>
  form(`/jobs/${id}/feedback`, [["token", token], ["value", value], ["back", `/jobs/${id}`]], headers);
const feedbackOf = async (id: string) => (await db.select().from(listingFeedback).where(eq(listingFeedback.listingId, Number(id))))[0]?.state ?? null;
const settingsFields = (revision: string, hours = "20"): [string, string][] =>
  [["revision", revision], ["max_weekly_hours", hours], ["min_fixed_twd", "3000"], ["categories", "AI agent"], ["categories", "後端／API"], ["back", "/settings"]];

describe("list and detail", () => {
  it("pages the candidates 50 at a time, ranked, and says whether a next page exists", async () => {
    const first = await listJobs(db, now, "candidates", 1), second = await listJobs(db, now, "candidates", 2);
    expect(first.jobs).toHaveLength(PAGE_SIZE);
    expect(first.hasNext).toBe(true);
    // The saved listing ranks first (+10); the skipped one and the design one are not candidates.
    expect(String(first.jobs[0].id)).toBe(await key("liked"));
    expect([...first.jobs, ...second.jobs].map((j) => String(j.id))).not.toContain(await key("skipped"));
    expect(second.hasNext).toBe(false);
    expect(first.jobs.length + second.jobs.length).toBe(PAGE_SIZE + 5 + 1);
    expect(first.jobs.every((j) => j.candidate)).toBe(true);
  });

  it("shows the saved, the skipped and all listings in their own views", async () => {
    expect((await listJobs(db, now, "saved", 1)).jobs.map((j) => String(j.id))).toEqual([await key("liked")]);
    expect((await listJobs(db, now, "skipped", 1)).jobs.map((j) => String(j.id))).toEqual([await key("skipped")]);
    const all = [...(await listJobs(db, now, "all", 1)).jobs, ...(await listJobs(db, now, "all", 2)).jobs];
    expect(all).toHaveLength(PAGE_SIZE + 5 + 3);
    expect(all.at(-1)!.candidate).toBe(false);
  });

  it("re-ranks after a settings save: a category left out leaves the candidates", async () => {
    expect((await listJobs(db, now, "candidates", 1)).jobs.length).toBe(PAGE_SIZE);
    const s = await readSettings(db);
    const category = (await jobDetail(db, now, await key("c000"))).category;
    const save = await handleSettings(form("/settings/save", [["revision", String(s.revision)], ["max_weekly_hours", "30"], ["min_fixed_twd", "3000"],
      ...s.settings.categories.filter((c) => c !== category).map((c): [string, string] => ["categories", c])]), deps());
    expect(save.status).toBe(303);
    expect((await listJobs(db, now, "candidates", 1)).jobs).toHaveLength(0);
  });

  it("reads the query: unknown views and bad pages fall back to the first page of the candidates", () => {
    expect(listQuery({ view: "saved", page: "2" })).toEqual({ view: "saved", page: 2 });
    expect(listQuery({ view: "evil", page: "0" })).toEqual({ view: "candidates", page: 1 });
    expect(listQuery({ view: ["saved"], page: "1e3" })).toEqual({ view: "candidates", page: 1 });
  });

  it("shows one listing with its token, and a missing one is NotFound", async () => {
    const detail = await jobDetail(db, now, await key("liked"));
    expect(detail.feedback).toBe("interested");
    expect(detail.token).toBe("1");
    expect((await jobDetail(db, now, await key("c000"))).token).toBe("0");
    await expect(jobDetail(db, now, "missing")).rejects.toBeInstanceOf(NotFound);
  });

  it("keeps unknown as unknown: no hours, no budget and no deadline are open questions, not exclusions", async () => {
    const detail = await jobDetail(db, now, await key("c000"));
    expect(detail.status).toBe("needs_info");
    expect(detail.questions).toEqual(expect.arrayContaining(["確認每週工時，需包含溝通與修改", "確認台灣接案資格", "確認申請截止時間與交付時程"]));
    const html = renderToStaticMarkup(<JobDetail job={detail} />);
    expect(html).toContain("<dd>待確認</dd>");
    expect(html).toContain("報酬待確認");
  });

  it("shows a mail listing's differing contents, the stored one first, and ranks by the possible one", async () => {
    await intakeListings(db, "mail_src", [job("m1", { weekly_hours: 50 })], "mail", now);
    await intakeListings(db, "mail_src", [job("m1", { weekly_hours: 10 })], "mail", new Date(now.getTime() + 1000));
    const detail = await jobDetail(db, now, await key("m1", "mail_src"));
    expect(detail.job.weekly_hours).toBe(50);
    expect(detail.status).toBe("excluded");
    expect(detail.conflict!.changedFields).toEqual(["weekly_hours"]);
    expect(detail.conflict!.versions.map((v) => [v.original, v.job.weekly_hours, v.status])).toEqual([[true, 50, "excluded"], [false, 10, "needs_info"]]);
    expect(detail.rankReasons).toContain("通知內容有差異；依可能符合的一份排序，需核對原文");
    const html = renderToStaticMarkup(<JobDetail job={detail} />);
    expect(html).toContain("差異欄位：每週工時");
    expect(html).toContain("現有紀錄");
    expect(detail.rankedOn).toBe(detail.conflict!.versions[1].fingerprint);
    expect(html).toContain("推薦分依另一份通知內容計算");
    expect((await jobDetail(db, now, await key("c000"))).rankedOn).toBeNull();
    const m1 = await key("m1", "mail_src");
    const listed = (await listJobs(db, now, "candidates", 1)).jobs.find((j) => String(j.id) === m1);
    expect(listed?.candidate).toBe(true);
  });
});

describe("page edges", () => {
  it("treats an id that is not a positive int4 in plain ASCII digits as not found, before reaching the database", async () => {
    for (const text of ["0", "01", "-1", "1e3", "0x10", "2147483648", "99999999999", "١", " 1", "1.0"]) {
      await expect(jobDetail(db, now, text), text).rejects.toBeInstanceOf(NotFound);
      await expect(writeFeedback(db, text, "0", "interested", now), text).rejects.toBeInstanceOf(NotFound);
    }
    expect((await jobDetail(db, now, await key("c000"))).job.title).toBe("Backend API contractor");
  });

  it("says where the difference is when no shown field differs", async () => {
    await intakeListings(db, "mail_src", [job("m2", { published_at: "2026-11-01T00:00:00Z" })], "mail", now);
    await intakeListings(db, "mail_src", [job("m2")], "mail", now);
    const detail = await jobDetail(db, now, await key("m2", "mail_src"));
    expect(detail.conflict!.changedFields).toEqual([]);
    expect(renderToStaticMarkup(<JobDetail job={detail} />)).toContain("差異在這裡未列出的欄位");
  });

  it("answers the 500 page when the database cannot be reached", async () => {
    const errors = console.error;
    console.error = () => {};
    try {
      const response = await handleFeedback(feedbackForm(await key("c000"), "0", "interested"), await key("c000"), { db: () => { throw new Error("DATABASE_URL must be set"); }, now: () => now });
      expect(response.status).toBe(500);
    } finally {
      console.error = errors;
    }
  });
});

describe("feedback route", () => {
  it("saves with the token the page showed, then refuses that stale token with 409", async () => {
    const detail = await jobDetail(db, now, await key("c000"));
    const saved = await handleFeedback(feedbackForm(await key("c000"), detail.token, "interested"), await key("c000"), deps());
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/jobs/${await key("c000")}?notice=saved`);
    expect((await jobDetail(db, now, await key("c000"))).feedback).toBe("interested");
    const stale = await handleFeedback(feedbackForm(await key("c000"), detail.token, "skipped"), await key("c000"), deps());
    expect(stale.status).toBe(409);
    expect((await jobDetail(db, now, await key("c000"))).feedback).toBe("interested");
    // Every accepted write is one event, at its revision.
    const events = await db.select().from(listingFeedbackEvents).where(eq(listingFeedbackEvents.listingId, +await key("c000")));
    expect(events.map((e) => [e.revision, e.state])).toEqual([[1, "interested"]]);
  });

  it("refuses a token ahead of the stored revision and a malformed one", async () => {
    for (const token of ["1", "01", "-1", "x", ""]) {
      expect((await handleFeedback(feedbackForm(await key("c000"), token, "interested"), await key("c000"), deps())).status, token).toBe(409);
    }
    expect(await feedbackOf(await key("c000"))).toBeNull();
  });

  it("restores a skipped listing to the candidates", async () => {
    const detail = await jobDetail(db, now, await key("skipped"));
    expect(detail.skipped).toBe(true);
    const restored = await handleFeedback(feedbackForm(await key("skipped"), detail.token, "restore"), await key("skipped"), deps());
    expect(restored.headers.get("location")).toBe(`/jobs/${await key("skipped")}?notice=restored`);
    expect((await listJobs(db, now, "skipped", 1)).jobs).toHaveLength(0);
  });

  it("answers 400 to an unknown value, 404 to a missing listing, 403 to another origin and 413 past the limit", async () => {
    const detail = await jobDetail(db, now, await key("c000"));
    expect((await handleFeedback(feedbackForm(await key("c000"), detail.token, "applied"), await key("c000"), deps())).status).toBe(400);
    expect((await handleFeedback(feedbackForm("missing", "0", "interested"), "missing", deps())).status).toBe(404);
    expect((await handleFeedback(feedbackForm(await key("c000"), detail.token, "interested", { origin: "https://evil.example" }), await key("c000"), deps())).status).toBe(403);
    const big = form(`/jobs/${await key("c000")}/feedback`, [["token", detail.token], ["value", "interested"], ["pad", "x".repeat(20_000)]]);
    expect((await handleFeedback(big, await key("c000"), deps())).status).toBe(413);
    expect(await feedbackOf(await key("c000"))).toBeNull();
  });

  it("un-saving says so, not 'restored'", async () => {
    const detail = await jobDetail(db, now, await key("liked"));
    const response = await handleFeedback(feedbackForm(await key("liked"), detail.token, "unsave"), await key("liked"), deps());
    expect(response.headers.get("location")).toBe(`/jobs/${await key("liked")}?notice=unsaved`);
    expect((await jobDetail(db, now, await key("liked"))).feedback).toBe("neutral");
  });

  it("refuses prototype keys and the bare feedback value as button values", async () => {
    const detail = await jobDetail(db, now, await key("c000"));
    for (const value of ["constructor", "__proto__", "neutral"]) {
      expect((await handleFeedback(feedbackForm(await key("c000"), detail.token, value), await key("c000"), deps())).status).toBe(400);
    }
  });

  it("answers 500 with 'result unknown', not 400, when stored data is inconsistent", async () => {
    // An event at revision 1 without its feedback row: the write's own event collides with it.
    await db.insert(listingFeedbackEvents).values({ listingId: +await key("c000"), revision: 1, state: "skipped" });
    const errors = console.error;
    console.error = () => {};
    try {
      const response = await handleFeedback(feedbackForm(await key("c000"), "0", "interested"), await key("c000"), deps());
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("結果未知");
    } finally {
      console.error = errors;
    }
    expect(await feedbackOf(await key("c000"))).toBeNull();
  });

  it("sends the person back only within the site", async () => {
    const detail = await jobDetail(db, now, await key("c000"));
    const request = form(`/jobs/${await key("c000")}/feedback`, [["token", detail.token], ["value", "interested"], ["back", "//evil.example/x"]]);
    expect((await handleFeedback(request, await key("c000"), deps())).headers.get("location")).toBe("/?notice=saved");
  });
});

describe("settings route", () => {
  it("saves at the revision the page showed, then refuses that stale revision with 409", async () => {
    const before = await settingsPage(db);
    const saved = await handleSettings(form("/settings/save", settingsFields(String(before.revision))), deps());
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/settings?notice=settings");
    const after = await settingsPage(db);
    expect(after).toMatchObject({ revision: 1, maxWeeklyHours: 20, minFixedTwd: 3000, categories: ["AI agent", "後端／API"] });
    expect((await handleSettings(form("/settings/save", settingsFields(String(before.revision), "30")), deps())).status).toBe(409);
    expect((await settingsPage(db)).maxWeeklyHours).toBe(20);
    // A revision ahead of the stored one is refused too, and so is a first save once one exists.
    expect((await handleSettings(form("/settings/save", settingsFields("5", "30")), deps())).status).toBe(409);
    expect((await settingsPage(db)).revision).toBe(1);
  });

  it("refuses a revision other than 0 before the first save", async () => {
    expect((await handleSettings(form("/settings/save", settingsFields("1")), deps())).status).toBe(409);
    expect((await readSettings(db)).revision).toBe(0);
  });

  it("leaves the ranges to validSettings(): out of range and not an integer are both 400", async () => {
    expect((await handleSettings(form("/settings/save", settingsFields("0", "200")), deps())).status).toBe(400);
    expect((await handleSettings(form("/settings/save", settingsFields("0", "2.5")), deps())).status).toBe(400);
    const none = form("/settings/save", [["revision", "0"], ["max_weekly_hours", ""], ["min_fixed_twd", "3000"]]);
    expect((await handleSettings(none, deps())).status).toBe(400);
    const unknown = form("/settings/save", [["revision", "0"], ["max_weekly_hours", ""], ["min_fixed_twd", "3000"], ["categories", "設計"]]);
    expect((await handleSettings(unknown, deps())).status).toBe(400);
    expect((await readSettings(db)).revision).toBe(0);
  });

  it("an empty hours field means no limit", async () => {
    const fields = settingsFields("0", "");
    expect((await handleSettings(form("/settings/save", fields), deps())).status).toBe(303);
    expect((await settingsPage(db)).maxWeeklyHours).toBeNull();
  });
});

describe("markup", () => {
  it("renders every write button enabled", async () => {
    const detail = await jobDetail(db, now, await key("c000")), settings = await settingsPage(db);
    for (const html of [renderToStaticMarkup(<JobDetail job={detail} />), renderToStaticMarkup(<SettingsForm data={settings} />)]) {
      expect(html).toContain("<button");
      expect(html).not.toContain('disabled=""');
    }
  });

  it("links the listing's own URL as its source", async () => {
    const detail = await jobDetail(db, now, await key("c000"));
    const html = renderToStaticMarkup(<JobDetail job={detail} />);
    expect(html).toContain('href="https://example.com/jobs/c000"');
  });

  it("escapes listing text and links only https listing URLs", async () => {
    await intakeListings(db, SOURCE, [job("x", { title: "<script>alert(1)</script>", url: "javascript:alert(1)" })], "page", now);
    const html = renderToStaticMarkup(<JobDetail job={await jobDetail(db, now, await key("x"))} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    const list = renderToStaticMarkup(<JobList data={await listJobs(db, now, "candidates", 1)} />);
    expect(list).toContain(`href="/jobs/${await key("liked")}"`);
    expect(list).toContain('href="/?view=candidates&amp;page=2"');
  });
});
