import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { freshPg } from "../../../../tests/helpers/pg";
import { parseBatch, sourceDate, TAIWANJOBS_SETTINGS, taiwanjobsConnector } from ".";

// Plan step 5a: the golden responses (fixtures/cases.json, written by generate.ts from legacyToInput
// of the old output) against the native connector, then the connector's own rules and intake.

type BatchCase = { input: string; expect: { error: true } | { seen: number; listings?: unknown[]; rejected?: number }; why?: string };
const cases: { now: string; date: { input: string; expect: string | null }[]; batch: BatchCase[]; strict: BatchCase[] } =
  JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));
const GOLDEN_NOW = new Date(cases.now);
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

function wrong(c: BatchCase) {
  let got: ReturnType<typeof parseBatch> | { error: string };
  try {
    got = parseBatch(latin1(c.input), GOLDEN_NOW);
  } catch (e) {
    got = { error: (e as Error).message };
  }
  const e = c.expect;
  const bad = "error" in e ? !("error" in got)
    : "error" in got ? true
    : (got.rejected || 0) !== (e.rejected ?? 0) ? true
    : e.listings ? JSON.stringify({ seen: got.seen, listings: got.listings }) !== JSON.stringify({ seen: e.seen, listings: e.listings })
    : got.seen !== e.seen || got.listings.length !== e.seen - (e.rejected ?? 0);
  return bad ? { input: c.input.slice(0, 300), why: c.why, expect: e, got } : null;
}

describe("taiwanjobs connector over the golden responses", () => {
  it(`${cases.date.length} source dates read as Python's strptime did`, () => {
    expect(cases.date.filter((c) => (sourceDate(c.input)?.date ?? null) !== c.expect)).toEqual([]);
  });
  it(`${cases.batch.length} responses (old parse_batch) give the expected listings or refusal`, () => {
    expect(cases.batch.map(wrong).filter(Boolean)).toEqual([]);
  });
  it(`${cases.strict.length} responses (old strict parse) give the expected listings or refusal`, () => {
    expect(cases.strict.map(wrong).filter(Boolean)).toEqual([]);
  });
});

const NOW = new Date("2026-09-28T01:00:00Z");
type Row = Partial<Record<"OCCU_DESC" | "WK_TYPE" | "JOB_DETAIL" | "URL_QUERY" | "TRANDATE" | "STOP_DATE" | "CITYNAME", string | null>>;
const LABEL = { OCCU_DESC: "職務名稱", WK_TYPE: "職務性質", JOB_DETAIL: "工作內容", URL_QUERY: "職缺資料URL", TRANDATE: "職缺更新日期", STOP_DATE: "應徵截止日期", CITYNAME: "工作地點" };
const row = (changes: Row = {}, n = 34): Row => ({
  OCCU_DESC: "AI agent 後端 API 工程師", WK_TYPE: "兼職", JOB_DETAIL: "遠端開發 AI agent 與後端 API",
  URL_QUERY: `https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=12&HIRE_ID=${n}&x=1#top`, TRANDATE: "20260918", STOP_DATE: "20261231", ...changes,
});
/** The endpoint's format: tag names with the Chinese label suffix, values in CDATA; a null field is left out. */
const xml = (rows: Row[]) => new TextEncoder().encode(`<?xml version="1.0"?><DataList>${rows.map((r) => `<Data>${Object.entries(r).filter(([, v]) => v !== null)
  .map(([k, v]) => `<${k}（${LABEL[k as keyof typeof LABEL]}）><![CDATA[${v}]]></${k}（${LABEL[k as keyof typeof LABEL]}）>`).join("")}</Data>`).join("")}</DataList>`);
const serving = (rows: Row[]): Fetcher => ({ requests: 1, get: async () => ({ status: 200, tier: "plain", body: xml(rows) }) });

describe("taiwanjobs connector", () => {
  it("keeps the old id and link: EMPLOYER_ID:HIRE_ID, the URL with only those two parameters", () => {
    const [l] = parseBatch(xml([row()]), NOW).listings;
    expect([l.external_id, l.url, l.canonical_url]).toEqual(["12:34", "https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=12&HIRE_ID=34", l.url]);
  });

  it("keeps contract rows updated in the last 90 days and counts every row seen", async () => {
    const got = await taiwanjobsConnector(serving([row(), row({ WK_TYPE: "全職" }, 35), row({ WK_TYPE: "" }, 36), row({ TRANDATE: "20260601" }, 37), row({ WK_TYPE: "接案" }, 38)]), NOW);
    expect([got.seen, got.listings.map((l) => l.external_id)]).toEqual([5, ["12:34", "12:38"]]);
    // Old `exists ||`: what the rule drops goes to others, for intake to refresh stored rows only.
    expect(got.others?.map((l) => l.external_id)).toEqual(["12:35", "12:36", "12:37"]);
  });

  it("refuses the batch for a bad envelope or a listing named twice", () => {
    const bodies = [
      new TextEncoder().encode("<html>"), new TextEncoder().encode('<!DOCTYPE x><DataList/>'), new Uint8Array([0x3c, 0xff]),
      new TextEncoder().encode("<Other/>"), new TextEncoder().encode(`<DataList>${"<Data/>".repeat(1001)}</DataList>`), xml([row(), row()]),
    ];
    for (const b of bodies) expect(() => parseBatch(b, NOW)).toThrow(/taiwanjobs/);
  });

  it("sets aside and counts a row without identity, with a future or unreadable update date or without WK_TYPE, keeping the others", () => {
    for (const bad of [{ OCCU_DESC: "" }, { URL_QUERY: "https://job.taiwanjobs.gov.tw:443/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=12&HIRE_ID=35" },
      { URL_QUERY: "https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=12&HIRE_ID=35&HIRE_ID=36" },
      { TRANDATE: "20261001" }, { TRANDATE: "20260231" }, { WK_TYPE: null }, { JOB_DETAIL: "x".repeat(100_001) }]) {
      const got = parseBatch(xml([row(), row(bad, 35)]), NOW);
      expect([got.seen, got.rejected, got.listings.map((l) => l.external_id)]).toEqual([2, 1, ["12:34"]]);
    }
  });

  it("keeps unknown fields unknown: a deadline that is no date, an empty detail; eligibility and hours are never guessed", () => {
    const [a, b] = parseBatch(xml([row({ STOP_DATE: "20261340" }), row({ STOP_DATE: "長期", JOB_DETAIL: "" }, 35)]), NOW).listings;
    expect([a.deadline, a.extra.deadline_evidence, b.deadline, b.description, b.complete]).toEqual([null, "20261340", null, null, false]);
    expect([a.taiwan_eligible, a.weekly_hours, a.published_at, a.budget_min]).toEqual([null, null, null, null]);
    const [c] = parseBatch(xml([row({ CITYNAME: "臺北市" })]), NOW).listings;
    expect([c.deadline, c.location, c.extra.source_updated_at]).toEqual([{ kind: "date", date: "2026-12-31" }, "臺北市", "2026-09-17T16:00:00.000Z"]);
  });

  it("reads one request per run", () => {
    expect([TAIWANJOBS_SETTINGS.maxRequestsPerRun, TAIWANJOBS_SETTINGS.maxTier, TAIWANJOBS_SETTINGS.disabled]).toEqual([1, "plain", null]);
  });
});

describe("taiwanjobs intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const settings = { ...TAIWANJOBS_SETTINGS, order: 0 };

  it("writes only listings the source's rules and screening keep", async () => {
    const run = await collectSource(db, settings, NOW, serving([row(), row({ WK_TYPE: "全職" }, 35)]));
    expect([run.seen, run.externalIds]).toEqual([2, ["12:34"]]);
    expect(await listingBy(db, "taiwanjobs", "12:35")).toBeNull();
  });

  it("writes the others when one row lacks its identity, and nothing when most do", async () => {
    const run = await collectSource(db, settings, NOW, serving([row(), row({ URL_QUERY: "https://example.com/x" }, 35)]));
    expect([run.seen, run.rejected, run.externalIds]).toEqual([2, 1, ["12:34"]]);
    await db.execute(sql`truncate listings cascade`);
    await expect(collectSource(db, settings, NOW, serving([row(), row({ URL_QUERY: "https://example.com/x" }, 35), row({ OCCU_DESC: "" }, 36)]))).rejects.toThrow(/2 of 3 listings refused/);
    expect(await listingBy(db, "taiwanjobs", "12:34")).toBeNull();
  });

  it("a second run of the same response changes nothing", async () => {
    await collectSource(db, settings, NOW, serving([row()]));
    expect((await collectSource(db, settings, NOW, serving([row()]))).intake).toEqual({ inserted: 0, updated: 0, unchanged: 1, versioned: 0 });
  });
});
