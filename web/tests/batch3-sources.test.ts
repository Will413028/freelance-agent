import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { runSource, sourcesIn } from "@/modules/collection/public";
import { fetchChickpt, INDEX as CK_INDEX, parseArticle as ckArticle, syncChickpt } from "@/modules/collection/sources/chickpt";
import { parseArticle as djArticle, syncDynamiteJobs } from "@/modules/collection/sources/dynamitejobs";
import { CATEGORIES, fetchJobbank518, INDEX as JB_INDEX, parseArticle as jbArticle, syncJobbank518 } from "@/modules/collection/sources/jobbank518";
import { parseArticle as jrArticle, syncJustRemote } from "@/modules/collection/sources/justremote";
import { parseArticle as ndArticle, parseFeed, syncNoDesk } from "@/modules/collection/sources/nodesk";
import { readSettings, replaceSettings } from "@/modules/discovery/public";
import { list } from "@/services/discovery";
import { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { asDict, PyDict, type PyValue } from "@/platform/py/value";
import { db, pool, resetSchema } from "./helpers/db";

// The store cases of backend/tests/collection/test_nodesk.py, test_justremote.py,
// test_dynamitejobs.py, test_jobbank518.py and test_chickpt.py (plan step 8, batch 3). runSource
// marks the source failed first, as each Python sync does on its first line. The parse and fetch
// cases are in src/modules/collection/sources/batch3.test.ts.

const enc = (s: string) => new Uint8Array(Buffer.from(s));
const ld = (data: unknown) => enc(`<html><script type="application/ld+json">${JSON.stringify(data)}</script></html>`);
const nowIso = () => new Date().toISOString().replace("Z", "+00:00");

const run = async (source: string, sync: (d: Db) => Promise<PyDict>) => {
  let result: PyDict | null = null;
  const status = await runSource(db, source, async (d) => (result = await sync(d)));
  return status === "failed" ? PyDict.of({ status: "failed" }) : result!;
};
const items = () => list(db, PyDateTime.now());
/** store.review(id, 'edit', version, text=...) lives in step 11; write the field it sets. */
async function editProposal(text: string) {
  const { rows } = await pool.query("select id, item from opportunities");
  const item = loadsDict(rows[0].item);
  item.update({ proposal: text, version: 2n });
  await pool.query("update opportunities set item = $1 where id = $2", [encode(item), rows[0].id]);
}
const status = (item: PyDict) => asDict(item.at("evaluation")).at("status");
const batchOf = (jobs: PyDict[], changes: Record<string, PyValue> = {}) =>
  PyDict.of({ jobs, seen: BigInt(jobs.length), details_read: BigInt(jobs.length), rejected_count: 0n, truncated: false, ...changes });

beforeEach(resetSchema);
afterAll(() => pool.end());

describe("nodesk.sync (Python cases)", () => {
  const URL = "https://nodesk.co/remote-jobs/acme-ai-agent/";
  const feed = () => enc(`<rss><channel><item><title>AI agent</title><description>AI &ndash; agent &rsquo; work</description><link>${URL}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
  const article = (changes: Record<string, unknown> = {}) => ld({
    "@type": "JobPosting", title: "AI agent developer", description: "<p>Build an AI agent and API.</p>", employmentType: ["CONTRACTOR"],
    jobLocationType: "TELECOMMUTE", datePosted: "2026-09-26", applicantLocationRequirements: { "@type": "Country", name: "Anywhere" }, ...changes,
  });
  const job = (changes: Record<string, unknown> = {}) => {
    const { entries, rejected, truncated } = parseFeed(feed());
    expect([entries.length, rejected, truncated]).toEqual([1, 0n, false]);
    return ndArticle(article(changes), entries[0]);
  };
  const runJob = (j: PyDict, rejected = 0n) => run("nodesk", (d) => syncNoDesk(d, async () => PyDict.of({ jobs: [j], seen: 1n + rejected, rejected_count: rejected, truncated: false })));

  it("real job metadata keeps unknowns and attribution, and a replay keeps the human draft", async () => {
    const j = job();
    expect(j.at("taiwan_eligible")).toBeNull();
    expect(j.at("weekly_hours")).toBeNull();
    expect(j.at("attribution")).toBe("NoDesk");
    expect(j.at("kind")).toBe("contract");
    expect((await runJob(j)).at("jobs")).toBe(1n);
    await editProposal("My proposal");
    await runJob(j);
    const after = await items();
    expect(after.length).toBe(1);
    expect(after[0].at("proposal")).toBe("My proposal");
  });
  it("full-time wins over contract and the existing case is updated", async () => {
    await runJob(job());
    const updated = job({ employmentType: ["FULL_TIME", "CONTRACTOR"] });
    expect(updated.at("kind")).toBe("full_time");
    await runJob(updated);
    expect(status((await items())[0])).toBe("excluded");
  });
  it("partial keeps the valid job and leaves health failed", async () => {
    const result = await runJob(job(), 1n);
    expect(result.at("status")).toBe("partial");
    expect((await sourcesIn(db)).at("nodesk")).toBe("failed");
    expect((await items()).length).toBe(1);
  });
});

describe("justremote.sync (Python cases)", () => {
  const entry = (changes: Record<string, PyValue> = {}) => PyDict.of({
    id: 42n, title: "AI agent API engineer", job_type: "contract", category: "developer", is_active: true, location_restrictions: [],
    href: "remote-developer-jobs/ai-agent-acme", url: "https://justremote.co/remote-developer-jobs/ai-agent-acme", ...changes,
  });
  const detail = (changes: Record<string, unknown> = {}) => enc(`<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", title: "AI agent API engineer", description: "<p>Build an AI agent API</p>", employmentType: "CONTRACTOR",
    datePosted: nowIso(), jobLocationType: "TELECOMMUTE", ...changes,
  })}</script>`);

  it("a replay keeps the human draft and a partial run leaves health failed", async () => {
    const j = jrArticle(detail(), entry());
    const result = PyDict.of({ jobs: [j], seen: 1n, rejected_count: 0n, complete_scan: false, listing_metadata: [entry()] });
    expect((await run("justremote", (d) => syncJustRemote(d, async () => result))).at("jobs")).toBe(1n);
    await editProposal("Human draft");
    result.set("rejected_count", 1n);
    expect((await run("justremote", (d) => syncJustRemote(d, async () => result))).at("status")).toBe("partial");
    const after = await items();
    expect(after.length).toBe(1);
    expect(after[0].at("proposal")).toBe("Human draft");
    expect((await sourcesIn(db)).at("justremote")).toBe("failed");
  });
  it("US-only, full-time and inactive listings do not become candidates", async () => {
    for (const [data, e] of [[detail(), entry({ location_restrictions: ["United States"] })], [detail({ employmentType: "FULL_TIME" }), entry()], [detail(), entry({ is_active: false })]] as const) {
      const j = jrArticle(data, e);
      expect((await run("justremote", (d) => syncJustRemote(d, async () => PyDict.of({ jobs: [j], seen: 1n, rejected_count: 0n })))).at("jobs")).toBe(0n);
    }
  });
});

describe("dynamitejobs.sync (Python cases)", () => {
  const URL = "https://dynamitejobs.com/company/example/remote-job/ai-agent-engineer";
  const detail = (changes: Record<string, unknown> = {}) => enc(`<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", title: "AI agent API engineer", description: "<p>Build an AI agent API.</p>", url: URL, employmentType: "CONTRACTOR",
    jobLocationType: "TELECOMMUTE", applicantLocationRequirements: [{ "@type": "Country", name: "Taiwan" }], datePosted: nowIso(), ...changes,
  })}</script>`);
  const runSync = (jobs: PyDict[], changes: Record<string, PyValue> = {}) => run("dynamitejobs", (d) => syncDynamiteJobs(d, async () => batchOf(jobs, changes)));

  it("full-time metadata wins over a contract title", async () => {
    const j = djArticle(detail({ title: "Contract AI agent engineer", employmentType: "FULL_TIME" }), URL);
    expect(j.at("kind")).toBe("full_time");
    expect((await runSync([j])).at("jobs")).toBe(0n);
  });
  it("a replay keeps the human draft and a truncated run is visible as partial", async () => {
    const j = djArticle(detail(), URL);
    expect((await runSync([j])).at("jobs")).toBe(1n);
    await editProposal("Human proposal");
    expect((await runSync([j], { truncated: true })).at("status")).toBe("partial");
    const after = await items();
    expect(after[0].at("proposal")).toBe("Human proposal");
    expect((await sourcesIn(db)).at("dynamitejobs")).toBe("failed");
    expect(after.length).toBe(1);
  });
  it("an updated full-time listing is ingested to exclude the existing candidate", async () => {
    await runSync([djArticle(detail(), URL)]);
    await runSync([djArticle(detail({ employmentType: "FULL_TIME" }), URL)]);
    expect(status((await items())[0])).toBe("excluded");
  });
});

describe("jobbank518.sync (Python cases)", () => {
  const URL = "https://www.518.com.tw/job-Ab1234.html";
  const index = (urls: string[], empty = false) => enc(`<h1>${CATEGORIES.join("、")} 的兼職工作職缺</h1>${urls.map((u) => `<a href="${u}">job</a>`).join("")}${empty ? "<p>抱歉沒有搜到適合的職缺</p>" : ""}`);
  const detail = (changes: Record<string, unknown> = {}) => enc("<time>更新日期:2026-09-26</time><script type=\"application/ld+json\">" + JSON.stringify([{
    "@type": "JobPosting", title: "兼職 AI agent API 工程師", description: "<p>開發 AI agent API</p><br>職務類別<br>AI工程師<br>職缺條件<br>兼職",
    url: URL, employmentType: ["PART_TIME"], datePosted: "2026-01-01", jobLocation: { address: { addressCountry: "TW" } },
    baseSalary: { currency: "TWD", value: { minValue: 500, unitText: "HOUR" } }, ...changes,
  }, { "@type": "BreadcrumbList" }]) + "</script>");
  const runSync = (jobs: PyDict[]) => run("jobbank518", (d) => syncJobbank518(d, async () => batchOf(jobs)));
  const pages = (map: Record<string, Uint8Array>) => async (url: string) => (map[url] ? { status: 200, body: map[url] } : { status: 404, body: new Uint8Array() });

  it("an explicit empty search is a successful empty scan", async () => {
    const result = await fetchJobbank518({ request: pages({ [JB_INDEX]: index([], true) }), pause: async () => {} });
    expect((await run("jobbank518", (d) => syncJobbank518(d, async () => result))).at("status")).toBe("ok");
    expect((await sourcesIn(db)).at("jobbank518")).toBe("ok");
    expect(await items()).toEqual([]);
  });
  it("array metadata, dates and unknowns are kept; an old active listing is not dropped by its date", async () => {
    const j = jbArticle(detail(), URL);
    expect(j.at("software_category")).toBe(true);
    expect(j.str("published_at").startsWith("2026-01-01")).toBe(true);
    expect(j.str("updated_at").startsWith("2026-09-26")).toBe(true);
    expect(j.at("budget_max")).toBeNull();
    expect(asDict(asDict(j.at("salary_evidence")).at("value")).at("unitText")).toBe("HOUR");
    expect((await runSync([j])).at("jobs")).toBe(1n);
  });
  it("a replay keeps the human draft and a full-time update excludes the case", async () => {
    const j = jbArticle(detail(), URL);
    await runSync([j]);
    await editProposal("Human draft");
    await runSync([j]);
    expect((await items())[0].at("proposal")).toBe("Human draft");
    expect((await items()).length).toBe(1);
    await runSync([jbArticle(detail({ employmentType: ["FULL_TIME", "PART_TIME"] }), URL)]);
    expect(status((await items())[0])).toBe("excluded");
  });
  it("an unrelated category is not ingested", async () => {
    expect((await runSync([jbArticle(detail({ description: "網站文案<br>職務類別<br>網站行銷企劃<br>職缺條件<br>兼職" }), URL)])).at("jobs")).toBe(0n);
  });
  it("bad details make health failed, and a broken listing fails the source", async () => {
    const two = URL.replace("Ab1234", "Ab1235");
    const result = await fetchJobbank518({ request: pages({ [JB_INDEX]: index([URL, two]), [URL]: detail(), [two]: enc("<h1>Removed</h1>") }), pause: async () => {} });
    expect(result.at("rejected_count")).toBe(1n);
    expect(result.at("complete_scan")).toBe(false);
    expect((await run("jobbank518", (d) => syncJobbank518(d, async () => result))).at("status")).toBe("partial");
    expect((await sourcesIn(db)).at("jobbank518")).toBe("failed");
    expect((await items()).length).toBe(1);
    expect((await run("jobbank518", (d) => syncJobbank518(d, async () => { throw new Error("Bad listing"); }))).at("status")).toBe("failed");
  });
});

describe("chickpt.sync (Python cases)", () => {
  const URL = "https://www.chickpt.com.tw/job-Ab1234567890";
  const index = (urls: string[], total?: number) => enc(`<h1><span>電腦</span>接案任務</h1><span id="job-count">${total ?? urls.length}</span><ul id="job-list">${urls.map((u) => `<li><a href="${u}">task</a></li>`).join("")}</ul>`);
  const detail = (salary = "單次$5000", body = "Build an AI agent API", url = URL) => enc(`<meta property="og:url" content="${url}"><h1 id="job-h1-title">AI agent 開發</h1>`
    + `<div class="job_salary_address-block"><h2>${salary}</h2><h2>在家兼職</h2></div><section class="job-content"><p>任務內容</p><ul><li>${body}</li></ul></section>`
    + `<section class="job-work_time">工作日期：2026/09/20~2026/10/20</section><section class="similar"><p>無薪 FULL_TIME unrelated advertisement</p></section>`);
  const runSync = (jobs: PyDict[]) => run("chickpt", (d) => syncChickpt(d, async () => PyDict.of({ jobs, seen: BigInt(jobs.length), rejected_count: 0n, truncated: false })));

  it("a new observation keeps the receipt and the human draft; a budget update re-evaluates", async () => {
    const now = PyDateTime.now();
    const first = ckArticle(detail(), URL, now);
    const again = ckArticle(detail(), URL, PyDateTime.fromUtcMicros(now.utcMicros() + 86_400_000_000n));
    expect(first.at("receipt_id")).toBe(again.at("receipt_id"));
    await runSync([first]);
    await editProposal("Human proposal");
    await runSync([again]);
    expect((await items()).length).toBe(1);
    expect((await items())[0].at("proposal")).toBe("Human proposal");
    await runSync([ckArticle(detail("單次$2000"), URL)]);
    expect(status((await items())[0])).toBe("excluded");
  });
  it("a task below the personal floor is kept for a later preference change", async () => {
    expect((await runSync([ckArticle(detail("單次$2000"), URL)])).at("jobs")).toBe(1n);
    expect(status((await items())[0])).toBe("excluded");
    const current = await readSettings(db);
    await replaceSettings(db, current.revision, new PyDict(current.settings).update({ min_fixed_twd: 0n }));
    expect(status((await items())[0])).not.toBe("excluded");
  });
  it("a truncated listing is visible as partial", async () => {
    const result = await fetchChickpt({ request: async (u) => ({ status: 200, body: u === CK_INDEX ? index([URL], 2) : detail() }), pause: async () => {} });
    expect(result.at("truncated")).toBe(true);
    expect((await run("chickpt", (d) => syncChickpt(d, async () => result))).at("status")).toBe("partial");
    expect((await sourcesIn(db)).at("chickpt")).toBe("failed");
  });
  it("a broken body is partial and an empty scan is ok", async () => {
    let result = await fetchChickpt({ request: async (u) => ({ status: 200, body: u === CK_INDEX ? index([URL]) : enc("<h1>Missing</h1>") }), pause: async () => {} });
    expect(result.at("rejected_count")).toBe(1n);
    expect((await run("chickpt", (d) => syncChickpt(d, async () => result))).at("status")).toBe("partial");
    result = await fetchChickpt({ request: async () => ({ status: 200, body: index([]) }), pause: async () => {} });
    expect((await run("chickpt", (d) => syncChickpt(d, async () => result))).at("status")).toBe("ok");
  });
});
