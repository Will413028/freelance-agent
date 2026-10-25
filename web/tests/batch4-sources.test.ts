import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { runSource, sourcesIn } from "@/modules/collection/public";
import { ENDPOINT as AN_ENDPOINT, MAX_PAGE_ENTRIES, normalize as anNormalize, parseBatch as anParseBatch, PROMOTIONAL_FOOTERS, readerOver, scan, syncArbeitnow } from "@/modules/collection/sources/arbeitnow";
import { normalize as flNormalize, search, syncFreelancer, type Searcher } from "@/modules/collection/sources/freelancer";
import { ENDPOINT as TJ_ENDPOINT, fetchTaiwanJobs, LABELS, parse as tjParse, parseBatch as tjParseBatch, syncTaiwanJobs } from "@/modules/collection/sources/taiwanjobs";
import { list } from "@/services/discovery";
import { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { asDict, PyDict, PyError, type PyValue } from "@/platform/py/value";
import { db, pool, resetSchema } from "./helpers/db";

// The cases of backend/tests/collection/test_taiwanjobs.py, test_arbeitnow.py and test_freelancer.py
// (plan step 8, last batch). runSource marks the source failed first, as each Python sync does on its
// first line. Python's tests pin the clock; these use dates relative to today instead, since the TS
// syncs read the real clock. The golden comparisons are in src/modules/collection/sources/batch4.test.ts.

const enc = (s: string) => new Uint8Array(Buffer.from(s));
const run = async (source: string, sync: (d: Db) => Promise<PyDict>) => {
  let result: PyDict | null = null;
  const status = await runSource(db, source, async (d) => (result = await sync(d)));
  return status.status === "failed" ? PyDict.of({ status: "failed" }) : result!;
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
const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");

beforeEach(resetSchema);
afterAll(() => pool.end());

describe("taiwanjobs (Python cases)", () => {
  const URL = "https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=12&HIRE_ID=34";
  const row = (changes: Record<string, string> = {}) => ({
    OCCU_DESC: "AI agent 後端 API 工程師", WK_TYPE: "兼職", JOB_DETAIL: "遠端開發 AI agent 與後端 API", URL_QUERY: URL,
    TRANDATE: ymd(1), STOP_DATE: "20991231", WKTIME: "日班", SALARYCD: "時薪", NT_L: "500", NT_U: "1000", ...changes,
  });
  const xml = (...rows: Record<string, string>[]) => enc('<?xml version="1.0"?><DataList>' + rows.map((r) => "<Data>" + Object.entries(r).map(([k, v]) =>
    `<${k}（${LABELS[k]}）><![CDATA[${v}]]></${k}（${LABELS[k]}）>`).join("") + "</Data>").join("") + "</DataList>");
  const runSync = (batch: PyValue) => run("taiwanjobs", (d) => syncTaiwanJobs(d, async () => batch));

  it("exact label repair keeps CDATA, unknowns stay unknown and the update date is no publication", () => {
    const j = tjParse(xml(row({ JOB_DETAIL: "開發 API <WKTIME（工作時間）>例子</WKTIME（工作時間）> & RAG", TRANDATE: "20260918" })))[0];
    expect(j.str("description")).toContain("<WKTIME（工作時間）>");
    expect([j.at("external_id"), j.at("kind"), j.has("published_at")]).toEqual(["12:34", "contract", false]);
    for (const k of ["taiwan_eligible", "timezone_compatible", "weekly_hours", "budget_min", "budget_max"]) expect(j.at(k)).toBeNull();
    expect([j.at("source_updated_at"), j.at("deadline"), asDict(j.at("salary_evidence")).at("period")]).toEqual(["2026-09-18T00:00:00+08:00", "2099-12-31", "時薪"]);
  });
  it("rejects declarations, unknown schemas, duplicate fields, bad origins and duplicate identities", () => {
    for (const raw of [enc('<!DOCTYPE x [<!ENTITY p "bad">]><DataList/>'), enc("<html>challenge</html>"), xml(row({ URL_QUERY: URL.replace("job.taiwanjobs.gov.tw", "evil.invalid") })),
      xml(row({ TRANDATE: "20269999" })), xml(row({ URL_QUERY: URL + "&HIRE_ID=56" })), xml(row(), row()), new Uint8Array(8_000_001)]) {
      expect(() => tjParse(raw)).toThrow(PyError);
    }
    expect(tjParse(xml())).toEqual([]);
  });
  it("a replay keeps the human draft and an expired update excludes the candidate", async () => {
    const rows = tjParse(xml(row()));
    expect((await runSync(rows)).at("jobs")).toBe(1n);
    await editProposal("Human draft");
    await runSync(rows);
    expect((await items())[0].at("proposal")).toBe("Human draft");
    await runSync(tjParse(xml(row({ STOP_DATE: "20200901" }))));
    expect(status((await items())[0])).toBe("excluded");
  });
  it("new full-time, unknown-type, stale and irrelevant rows are not imported", async () => {
    for (const r of [row({ WK_TYPE: "全職" }), row({ WK_TYPE: "未知" }), row({ TRANDATE: "20200101" }), row({ OCCU_DESC: "清潔", JOB_DETAIL: "打掃" })]) {
      await runSync(tjParse(xml(r)));
    }
    expect(await items()).toEqual([]);
  });
  it("a wrong source rolls the batch back and leaves health failed", async () => {
    const rows = tjParse(xml(row()));
    const evil = new PyDict(rows[0]).update({ source: "evil" });
    expect((await runSync([...rows, evil])).at("status")).toBe("failed");
    expect(await items()).toEqual([]);
    expect((await sourcesIn(db)).at("taiwanjobs")).toBe("failed");
  });
  it("a partial batch keeps valid rows, never finishes the batch and a replay adds nothing", async () => {
    const batch = tjParseBatch(xml(row(), row({ OCCU_DESC: "", URL_QUERY: URL.replace("34", "35") })));
    expect(batch.at("rejected_count")).toBe(1n);
    const result = await runSync(batch);
    expect([result.at("status"), result.at("jobs"), result.at("seen")]).toEqual(["partial", 1n, 2n]);
    expect((await sourcesIn(db)).at("taiwanjobs")).toBe("failed");
    await runSync(batch);
    expect((await items()).length).toBe(1);
    expect((await runSync(tjParseBatch(xml(row())))).at("status")).toBe("ok");
    expect((await sourcesIn(db)).at("taiwanjobs")).toBe("ok");
  });
  it("an empty body keeps the missing information", () => {
    const j = tjParse(xml(row({ JOB_DETAIL: "" })))[0];
    expect([j.at("complete"), j.at("body_available")]).toEqual([false, false]);
  });
  it("fetch reads one endpoint and fails on any other status", async () => {
    const calls: string[] = [];
    const ok = await fetchTaiwanJobs(async (url) => (calls.push(url), { status: 200, body: xml(row()) }));
    expect([calls, (ok.at("jobs") as PyDict[]).length]).toEqual([[TJ_ENDPOINT], 1]);
    for (const code of [204, 301, 404, 500]) await expect(fetchTaiwanJobs(async () => ({ status: code, body: new Uint8Array() }))).rejects.toThrow(PyError);
  });
});

describe("arbeitnow (Python cases)", () => {
  const NEXT = "https://www.arbeitnow.com/api/job-board-api?page=2";
  const entry = (changes: Record<string, unknown> = {}) => ({
    slug: "ai-agent-123", title: "Part time AI agent developer", description: "<p>Build an AI agent and API.</p>", remote: true,
    url: "https://www.arbeitnow.com/jobs/companies/acme/ai-agent-123", tags: ["AI"], job_types: ["Part Time"], location: "Remote",
    created_at: Math.floor(Date.now() / 1000), ...changes,
  });
  /** The listing as json.loads gives it: ints are int. */
  const dictOf = (e: Record<string, unknown>) => loadsDict(JSON.stringify(e));
  type Raw = { data: unknown[]; meta: Record<string, unknown>; links: Record<string, unknown> };
  const payload = (...entries: unknown[]): Raw => ({ data: entries, meta: { current_page: 1, per_page: 250, from: entries.length ? 1 : null, to: entries.length || null }, links: { next: null } });
  const raw = (p: Raw) => enc(JSON.stringify(p));
  const reader = (fn: (url: string) => Raw | Uint8Array) => async (url: string) => { const r = fn(url); return r instanceof Uint8Array ? r : raw(r); };
  let pauses: number[] = [];
  const runSync = (fn: (url: string) => Raw | Uint8Array, o: { maxPages?: number } = {}) =>
    run("arbeitnow", (d) => syncArbeitnow(d, { reader: reader(fn), pause: async (ms) => { pauses.push(ms); }, ...o }));
  beforeEach(() => { pauses = []; });

  it("Swiss links are official and eligibility stays unknown; look-alike hosts fail", () => {
    const j = anNormalize(dictOf(entry({ url: "https://www.arbeitnow.ch/jobs/companies/acme/ai-agent-123" })));
    expect([j.at("canonical_url"), j.at("taiwan_eligible")]).toEqual(["https://www.arbeitnow.ch/jobs/companies/acme/ai-agent-123", null]);
    const bad = anParseBatch(raw(payload(entry({ url: "https://www.arbeitnow.ch.evil.test/jobs/companies/acme/ai-agent-123" }))));
    expect(bad.rejected).toBe(1n);
  });
  it("a larger provider page size keeps every valid job and the page resource bound still holds", async () => {
    const p = payload(...Array.from({ length: 325 }, (_, i) => entry({ slug: `job-${i}`, url: `https://www.arbeitnow.com/jobs/companies/acme/job-${i}` })));
    p.meta.per_page = 325;
    const result = await runSync(() => p);
    expect([result.at("status"), result.at("jobs"), result.at("complete_scan")]).toEqual(["ok", 325n, true]);
    const big = payload();
    big.data = Array.from({ length: MAX_PAGE_ENTRIES + 1 }, () => ({}));
    expect(() => anParseBatch(raw(big))).toThrow(PyError);
  });
  it("imports a remote contract with unknown eligibility, and a replay adds nothing", async () => {
    const first = await runSync(() => payload(entry()));
    expect([first.at("status"), first.at("jobs"), first.at("truncated")]).toEqual(["ok", 1n, false]);
    const job = asDict((await items())[0].at("job"));
    expect([job.at("attribution"), job.at("taiwan_eligible"), job.at("budget_max"), job.at("kind")]).toEqual(["Arbeitnow", null, null, "contract"]);
    expect((await runSync(() => payload(entry()))).at("jobs")).toBe(1n);
    expect((await items()).length).toBe(1);
  });
  it("local, full-time and irrelevant jobs are excluded", async () => {
    const p = payload(entry({ slug: "one", url: "https://www.arbeitnow.com/jobs/companies/acme/one", remote: false }),
      entry({ slug: "two", url: "https://www.arbeitnow.com/jobs/companies/acme/two", job_types: ["Fulltime"] }),
      entry({ slug: "three", url: "https://www.arbeitnow.com/jobs/companies/acme/three", title: "Part time accountant", description: "Bookkeeping" }));
    expect((await runSync(() => p)).at("jobs")).toBe(0n);
  });
  it("a bad listing is partial and a bad envelope fails", async () => {
    const result = await runSync(() => payload(entry(), entry({ slug: "bad", url: "https://evil.example/jobs/bad" })));
    expect([result.at("status"), result.at("rejected_count"), result.at("jobs")]).toEqual(["partial", 1n, 1n]);
    expect((await sourcesIn(db)).at("arbeitnow")).toBe("failed");
    expect((await runSync(() => enc("{}"))).at("status")).toBe("failed");
  });
  it("follows pages, deduplicates overlap and an inconsistent page set is not complete", async () => {
    const second = entry({ slug: "second", url: "https://www.arbeitnow.com/jobs/companies/acme/second" });
    const result = await runSync((url) => {
      const page = url.endsWith("page=2") ? 2 : 1;
      const p = page === 2 ? payload(entry(), second) : payload(entry());
      p.meta.current_page = page;
      p.links.next = page === 1 ? NEXT : null;
      return p;
    });
    expect([result.at("pages"), result.at("seen"), result.at("jobs"), result.at("complete_scan"), result.at("pagination_consistent")]).toEqual([2n, 3n, 2n, false, false]);
    expect((await items()).length).toBe(2);
  });
  it("the page cap is partial with failed health", async () => {
    const p = payload(entry());
    p.links.next = NEXT;
    const result = await runSync(() => p, { maxPages: 1 });
    expect([result.at("status"), result.at("complete_scan"), result.at("truncated")]).toEqual(["partial", false, true]);
    expect((await sourcesIn(db)).at("arbeitnow")).toBe("failed");
  });
  it("regional pagination is pinned to the primary endpoint", async () => {
    const calls: string[] = [];
    const result = await runSync((url) => {
      calls.push(url);
      const page = url.endsWith("page=2") ? 2 : 1;
      const p = payload(entry());
      p.meta.current_page = page;
      p.links.next = page === 1 ? "https://www.arbeitnow.nl/api/job-board-api?page=2" : null;
      return p;
    });
    expect(result.at("status")).toBe("partial");
    expect(calls).toEqual([AN_ENDPOINT, AN_ENDPOINT + "?page=2"]);
    expect((await items()).length).toBe(1);
  });
  it("a later page failure or a real content change imports nothing", async () => {
    let n = 0;
    expect((await runSync(() => {
      if (++n === 2) throw new PyError("OSError", "unavailable");
      const p = payload(entry());
      p.links.next = NEXT;
      return p;
    })).at("status")).toBe("failed");
    expect((await runSync((url) => {
      const page = url.endsWith("page=2") ? 2 : 1;
      const p = payload(entry({ description: page === 1 ? "<p>20 hours</p>" : "<p>40 hours</p>" }));
      p.meta.current_page = page;
      p.links.next = page === 1 ? NEXT : null;
      return p;
    })).at("status")).toBe("failed");
    expect(await items()).toEqual([]);
  });
  it("footer variants share a receipt and keep attribution", () => {
    const base = entry();
    const jobs = PROMOTIONAL_FOOTERS.map((f) => anNormalize(dictOf({ ...base, description: base.description + "\n" + f })));
    expect(encode(jobs[0])).toBe(encode(jobs[1]));
    expect([jobs[0].at("description"), jobs[0].at("attribution")]).toEqual(["Build an AI agent and API.", "Arbeitnow"]);
  });
  it("inconsistent page metadata is partial even at the end", async () => {
    for (const changes of [{ per_page: 100, from: 101, to: 250 }, { per_page: true }, { from: null }, { to: 2 }]) {
      const p = payload(entry());
      Object.assign(p.meta, changes);
      const result = await runSync(() => p);
      expect([result.at("status"), result.at("complete_scan"), result.at("jobs")]).toEqual(["partial", false, 1n]);
    }
  });
  it("consistent pagination can complete, pausing 3 seconds between pages", async () => {
    const result = await runSync((url) => {
      const page = url.endsWith("page=2") ? 2 : 1;
      const p = payload(entry({ slug: `job-${page}`, url: `https://www.arbeitnow.com/jobs/companies/acme/job-${page}` }));
      p.meta = { current_page: page, per_page: 1, from: page, to: page };
      p.links.next = page === 1 ? NEXT : null;
      return p;
    });
    expect([result.at("complete_scan"), result.at("status"), result.at("jobs")]).toEqual([true, "ok", 2n]);
    expect(pauses).toEqual([3000]);
  });
  it("the deadline stops the next request and pacing never crosses it", async () => {
    for (const ticks of [[0, 1, 121], [0, 1, 119]]) {
      const p = payload(entry());
      p.links.next = NEXT;
      const calls: string[] = [];
      const t = [...ticks];
      const [, coverage] = await scan({ reader: reader((url) => (calls.push(url), p)), monotonic: () => t.shift()!, pause: async (ms) => { pauses.push(ms); } });
      expect([calls.length, coverage.at("truncated"), coverage.at("complete_scan")]).toEqual([1, true, false]);
    }
    expect(pauses).toEqual([]);
  });
  it("the reader enforces urllib's statuses and the 8 MB cap", async () => {
    const over = readerOver(async () => ({ status: 200, body: new Uint8Array(8_000_001) }));
    await expect(over(AN_ENDPOINT, 25_000)).rejects.toThrow("too large");
    for (const code of [204, 301, 404]) await expect(readerOver(async () => ({ status: code, body: new Uint8Array() }))(AN_ENDPOINT, 25_000)).rejects.toThrow(PyError);
  });
});

describe("freelancer (Python cases)", () => {
  const project = (extra: Record<string, unknown> = {}) => new PyDict(Object.entries({
    id: 42n, title: "AI agent backend", description: "Build an API", status: "active", type: "fixed", budget: PyDict.of({ minimum: 100n, maximum: 500n }),
    currency: PyDict.of({ code: "USD" }), time_updated: 1789742168n, language: "en", seo_url: "python/AI-agent", deleted: false, nonpublic: false, ...extra,
  }) as [string, PyValue][]);
  const runSync = (searcher: Searcher) => run("freelancer", (d) => syncFreelancer(d, searcher, async () => {}));
  const result = (jobs: PyDict[], limited: boolean, more: Record<string, PyValue> = {}) => PyDict.of({ jobs, limited, ...more });

  it("unknowns and currency are preserved, and nothing is guessed", () => {
    const j = flNormalize(project());
    expect([j.at("currency"), j.at("taiwan_eligible"), j.at("weekly_hours"), j.at("kind"), j.at("url")]).toEqual(["USD", null, null, "fixed", "https://www.freelancer.com/projects/python/AI-agent"]);
    for (const patch of [{ description: null }, { time_updated: null }, { budget: PyDict.of({ maximum: NaN }) }, { nonpublic: true }, { status: "closed" }, { seo_url: "//evil.com" }]) {
      expect(() => flNormalize(project(patch))).toThrow(PyError);
    }
  });
  it("one bounded GET page, no credentials, full descriptions requested", async () => {
    const calls: string[] = [];
    const body = { status: "success", result: { projects: [JSON.parse(encode(project()))], total_count: 100 } };
    const r = await search("AI agent", { limit: 5, maxPages: 1, request: async (url) => (calls.push(url), { status: 200, body: enc(JSON.stringify(body)) }) });
    expect([(r.at("jobs") as PyDict[]).length, r.at("limited")]).toEqual([1, true]);
    expect(calls[0]).toContain("full_description=true");
  });
  it("a failed later search ingests nothing", async () => {
    let n = 0;
    const out = await runSync(async () => { if (++n === 2) throw new PyError("ValueError", ""); return result([flNormalize(project())], false); });
    expect(out.at("status")).toBe("failed");
    expect(await items()).toEqual([]);
  });
  it("duplicate queries ingest once; irrelevant and copywriting titles are not ingested", async () => {
    expect((await runSync(async () => result([flNormalize(project())], true))).at("jobs")).toBe(1n);
    expect((await items()).length).toBe(1);
    await resetSchema();
    const logo = flNormalize(project({ id: 43n, title: "Logo design", description: "Draw a logo", seo_url: "design/logo" }));
    const copy = flNormalize(project({ id: 44n, title: "Website Home Page Copywriting", description: "Write copy for a website with API links", seo_url: "copy/site" }));
    expect((await runSync(async () => result([logo, copy], false))).at("jobs")).toBe(0n);
    expect(await items()).toEqual([]);
  });
  it("the daily run asks each of the three queries for 100 rows", async () => {
    const limits: [string, number][] = [];
    await runSync(async (q, limit) => (limits.push([q, limit]), result([], true)));
    expect(limits).toEqual([["AI agent", 100], ["API integration", 100], ["MVP web development", 100]]);
  });
  it("an incomplete scan or a rejected row is partial with failed health, valid projects kept", async () => {
    const out = await runSync(async () => result([flNormalize(project())], true));
    expect(out.at("status")).toBe("partial");
    expect((await sourcesIn(db)).at("freelancer")).toBe("failed");
    await resetSchema();
    const out2 = await runSync(async () => result([flNormalize(project())], false, { rejected_count: 1n }));
    expect([out2.at("status"), out2.at("jobs")]).toEqual(["partial", 1n]);
    expect((await items()).length).toBe(1);
  });
  it("a complete scan is ok", async () => {
    expect((await runSync(async () => result([flNormalize(project())], false))).at("status")).toBe("ok");
    expect((await sourcesIn(db)).at("freelancer")).toBe("ok");
  });
});
