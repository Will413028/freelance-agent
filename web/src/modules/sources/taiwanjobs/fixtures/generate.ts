// Writes cases.json from golden.json's taiwanjobs_date, taiwanjobs_batch and taiwanjobs_strict cases
// (plan step 5, connector-checklist.md section 4): the input is the golden response, the expected
// output is the old system's jobs turned into the listing contract by legacyToInput, so it is an
// oracle independent of the new connector. Deliberate differences are classified here, each with its
// reason, and nowhere else.
// Run once: pnpm exec tsx src/modules/sources/taiwanjobs/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { legacyToInput } from "@/modules/listings/public";
import { decodeStrict } from "@/platform/py/codecs";
import { PyDateTime } from "@/platform/py/datetime";
import { pyFullmatch, pyMatch } from "@/platform/py/re";
import { codePoints, pyInt, pyLen, pyStrip } from "@/platform/py/unicode";
import { urlsplit } from "@/platform/py/url";
import { xmlFromString } from "@/platform/py/xml";
import { fixture, type Expect } from "../../../../../tests/helpers/golden";

/** The golden NOW of the old batch test (collection/sources/batch4.test.ts). */
export const NOW = "2026-09-28T01:00:00.000Z";
const nowUs = BigInt(Date.parse(NOW)) * 1000n;

const LABELS: Record<string, string> = {
  OCCU_DESC: "職務名稱", WK_TYPE: "職務性質", CJOB1_COUNT: "職務大類別代碼", CJOB_NAME1: "職務大類別名稱", CJOB2_COUNT: "職務小類別代碼",
  CJOB_NAME2: "職務小類別名稱", JOB_PERSON: "雇用人數", STOP_DATE: "應徵截止日期", JOB_DETAIL: "工作內容", CITYNAME: "工作地點",
  EXPERIENCE: "工作經驗", WKTIME: "工作時間", SALARYCD: "核薪方式", NT_L: "薪資範圍下限", NT_U: "薪資範圍上限", EDGRDESC: "最低學歷要求",
  URL_QUERY: "職缺資料URL", COMPNAME: "公司名稱", TRANDATE: "職缺更新日期",
};

/** Python's datetime(y, m, d) from eight digits, or null (old taiwanjobs.date's outcome, without its exact regex). */
function pyDate(v: string): PyDateTime | null {
  if (!pyFullmatch(String.raw`\d{8}`, v)) return null;
  // strptime's '%Y%m%d' regex: the month and the day's first digit are ASCII classes.
  const m = pyMatch(String.raw`(\d\d\d\d)(1[0-2]|0[1-9]|[1-9])(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])`, v, true);
  if (!m || m[0].length !== v.length) return null;
  try {
    const d = String.fromCodePoint(...codePoints(v)), n = (a: number, b: number) => Number(pyInt([...d].slice(a, b).join("")));
    const t = new PyDateTime(n(0, 4), n(4, 6), n(6, 8), 0, 0, 0, 0, 8n * 3_600_000_000n);
    t.utcMicros();
    return t;
  } catch {
    return null;
  }
}

/**
 * Why the old connector refused one row (collection/sources/taiwanjobs.ts:47-63), split into what
 * stays a refusal of the whole batch now ("identity": title, body, URL, ids, update date, plus the
 * missing WK_TYPE the source's own rule reads) and what plan D8 turns into an unknown field
 * ("deadline": an eight-digit STOP_DATE that is no date). Null when the row passes.
 */
function rowRefusal(fields: Map<string, string>): "identity" | "deadline" | null {
  const f = (k: string) => fields.get(k) ?? "";
  if (!(pyLen(f("OCCU_DESC")) >= 1 && pyLen(f("OCCU_DESC")) <= 500) || pyLen(f("JOB_DETAIL")) > 100_000) return "identity";
  try {
    const u = urlsplit(f("URL_QUERY")), p = u.path.toLowerCase();
    if (u.scheme !== "https" || u.netloc !== "job.taiwanjobs.gov.tw" || (p !== "/internet/jobwanted/jobdetail.aspx" && p !== "/internet/index/jobdetail.aspx")) return "identity";
    const q = new URLSearchParams(u.query);
    if (["EMPLOYER_ID", "HIRE_ID"].some((k) => q.getAll(k).length !== 1 || !pyFullmatch(String.raw`[1-9]\d{0,19}`, q.get(k)!))) return "identity";
  } catch {
    return "identity";
  }
  const updated = pyDate(f("TRANDATE"));
  if (updated === null || updated.utcMicros() > nowUs + 86_400_000_000n) return "identity";
  if (pyFullmatch(String.raw`\d{8}`, f("STOP_DATE")) && pyDate(f("STOP_DATE")) === null) return "deadline";
  return fields.has("WK_TYPE") ? null : "identity";
}

/** The rows of a response the old parser read (null when the envelope itself was refused). */
function rows(latin1: string): Map<string, string>[] | null {
  try {
    let text = decodeStrict("utf-8", new Uint8Array(Buffer.from(latin1, "latin1")));
    if (text.startsWith("﻿")) text = text.slice(1);
    const pieces = text.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
    for (let i = 0; i < pieces.length; i += 2) {
      for (const [k, l] of Object.entries(LABELS)) pieces[i] = pieces[i].replaceAll(`<${k}（${l}）>`, `<${k}>`).replaceAll(`</${k}（${l}）>`, `</${k}>`);
    }
    return xmlFromString(pieces.join("")).children.map((r) => new Map(r.children.map((c) => [c.tag, pyStrip(c.text ?? "")])));
  } catch {
    return null;
  }
}

// New: location is the source's city text (old kept it as location_evidence only); an empty job
// detail is an unknown description, not an empty one; extra keeps only what the connector read and
// the contract has no field for (old receipt_id, received_at, language, body_available not carried).
const expected = (job: Record<string, unknown>) => ({
  ...legacyToInput("taiwanjobs", job),
  description: (job.description as string) || null,
  location: (job.location_evidence as string) || null,
  extra: {
    source_updated_at: new Date(job.source_updated_at as string).toISOString(), deadline_evidence: job.deadline_evidence,
    employment_type_evidence: job.employment_type_evidence, schedule_evidence: job.schedule_evidence, salary_evidence: job.salary_evidence,
  },
});

type Case = { input: string; expect: Expect<string> };
const golden = fixture<{ taiwanjobs_date: Case[]; taiwanjobs_batch: Case[]; taiwanjobs_strict: Case[] }>("golden.json");

const date = golden.taiwanjobs_date.map((c) => ({ input: c.input, expect: "error" in c.expect ? null : c.expect.ok.slice(0, 10) }));

const batch = (strict: boolean) => (c: Case) => {
  const rs = rows(c.input), kinds = rs?.map(rowRefusal) ?? [];
  if ("error" in c.expect) {
    // Strict parse refused the response for its first bad row; when every bad row only has an
    // unreadable deadline, the new connector keeps them with the deadline unknown.
    if (strict && rs && kinds.some((k) => k === "deadline") && kinds.every((k) => k !== "identity")) {
      return { input: c.input, expect: { seen: rs.length }, why: "D8_UNKNOWN: deadline that is no date" };
    }
    return { input: c.input, expect: { error: true } };
  }
  const out = JSON.parse(c.expect.ok) as { jobs: Record<string, unknown>[]; rejected_count: number; seen: number } | Record<string, unknown>[];
  const jobs = Array.isArray(out) ? out : out.jobs, seen = Array.isArray(out) ? jobs.length : out.seen;
  if (kinds.some((k) => k === "identity")) {
    const why = kinds.some((k, i) => k === "identity" && !rs![i].has("WK_TYPE") && jobs.length)
      ? "REFUSED: a row without WK_TYPE (the source's own rule reads it) fails the batch"
      : "REFUSED: a refused row fails the batch (old: rejected_count, partial run)";
    return { input: c.input, expect: { error: true }, why };
  }
  if (kinds.some((k) => k === "deadline")) return { input: c.input, expect: { seen }, why: "D8_UNKNOWN: deadline that is no date" };
  return { input: c.input, expect: { seen, listings: jobs.map(expected) } };
};

const cases = { now: NOW, date, batch: golden.taiwanjobs_batch.map(batch(false)), strict: golden.taiwanjobs_strict.map(batch(true)) };
writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
console.log(`${date.length} date, ${cases.batch.length} batch, ${cases.strict.length} strict cases`);
