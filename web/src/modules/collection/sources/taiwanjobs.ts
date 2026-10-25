import type { Db } from "@/db/client";
import { qualifyForIntake } from "@/modules/discovery/public";
import { pyIsInstance } from "@/platform/errors";
import { raiseForUrllibStatus, urlopenRead } from "@/platform/http";
import { decodeStrict } from "@/platform/py/codecs";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { pyFullmatch, pyMatch, pyRe } from "@/platform/py/re";
import { codePoints, pyInt, pyLen, pyLower, pyStrip, pyUpper } from "@/platform/py/unicode";
import { urlsplit, urlunsplit } from "@/platform/py/url";
import { xmlFromString } from "@/platform/py/xml";
import { isDict, isList, PyDict, PyError, pyGet, type PyValue } from "@/platform/py/value";
import { sourceBatch } from "../ingest";

// Port of collection/taiwanjobs.py: bounded official TaiwanJobs open data; no login or application
// submission.

export const ENDPOINT = "https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx?count=1000";
export const LABELS: Record<string, string> = {
  OCCU_DESC: "職務名稱", WK_TYPE: "職務性質", CJOB1_COUNT: "職務大類別代碼", CJOB_NAME1: "職務大類別名稱", CJOB2_COUNT: "職務小類別代碼",
  CJOB_NAME2: "職務小類別名稱", JOB_PERSON: "雇用人數", STOP_DATE: "應徵截止日期", JOB_DETAIL: "工作內容", CITYNAME: "工作地點",
  EXPERIENCE: "工作經驗", WKTIME: "工作時間", SALARYCD: "核薪方式", NT_L: "薪資範圍下限", NT_U: "薪資範圍上限", EDGRDESC: "最低學歷要求",
  URL_QUERY: "職缺資料URL", COMPNAME: "公司名稱", TRANDATE: "職缺更新日期",
};
const TAIPEI = 8n * 3_600_000_000n;
const DAY_US = 86_400_000_000n;
const LIMIT = 8_000_000;

// time.strptime's regex for '%Y%m%d' (CPython 3.13 _strptime, compiled with IGNORECASE), used with
// re.match plus its 'unconverted data remains' check, not fullmatch.
const STRPTIME_YMD = String.raw`(\d\d\d\d)(1[0-2]|0[1-9]|[1-9])(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])`;
const CONTRACT = pyRe("兼職|部分工時|接案|承攬");
/** Every regex above, for the golden test. */
export const regexes = () => ({ CONTRACT });

/** taiwanjobs.date: eight digits, read as datetime.strptime(value, '%Y%m%d') in Taipei time. */
export function date(value: string): PyDateTime {
  if (!pyFullmatch(String.raw`\d{8}`, value)) throw new PyError("ValueError", "Invalid source date");
  const m = pyMatch(STRPTIME_YMD, value, true);
  if (!m) throw new PyError("ValueError", "time data does not match format '%Y%m%d'");
  if (m[0].length !== value.length) throw new PyError("ValueError", "unconverted data remains");
  return new PyDateTime(Number(pyInt(m[1])), Number(pyInt(m[2])), Number(pyInt(m[3])), 0, 0, 0, 0, TAIPEI);
}

const FIELD_EVIDENCE = (fields: Map<string, string>, key: string) => fields.get(key) ?? "";

export function normalize(fields: Map<string, string>, now: PyDateTime): PyDict {
  const title = FIELD_EVIDENCE(fields, "OCCU_DESC"), body = FIELD_EVIDENCE(fields, "JOB_DETAIL");
  if (!(pyLen(title) >= 1 && pyLen(title) <= 500) || !(pyLen(body) <= 100000)) throw new PyError("ValueError", "Missing requirement");
  const u = urlsplit(FIELD_EVIDENCE(fields, "URL_QUERY"));
  const path = pyLower(u.path);
  if (u.scheme !== "https" || u.netloc !== "job.taiwanjobs.gov.tw" || (path !== "/internet/jobwanted/jobdetail.aspx" && path !== "/internet/index/jobdetail.aspx")) {
    throw new PyError("ValueError", "Invalid canonical URL");
  }
  // parse_qs(keep_blank_values=True) and urlencode agree with URLSearchParams on what matters here:
  // '&' pieces, '+' as space, blanks kept, and values that pass the digit check (golden taiwanjobs_batch).
  const q = new URLSearchParams(u.query);
  const ids = ["EMPLOYER_ID", "HIRE_ID"];
  if (ids.some((k) => q.getAll(k).length !== 1 || !pyFullmatch(String.raw`[1-9]\d{0,19}`, q.get(k)!))) throw new PyError("ValueError", "Invalid identity");
  const key = q.get("EMPLOYER_ID") + ":" + q.get("HIRE_ID");
  const url = urlunsplit({ ...u, query: new URLSearchParams(ids.map((k) => [k, q.get(k)!])).toString(), fragment: "" });
  const updated = date(FIELD_EVIDENCE(fields, "TRANDATE"));
  if (updated.utcMicros() > now.utcMicros() + DAY_US) throw new PyError("ValueError", "Future source date");
  const stop = FIELD_EVIDENCE(fields, "STOP_DATE");
  const deadline = pyFullmatch(String.raw`\d{8}`, stop) ? date(stop).isoformat().slice(0, 10) : null;
  const typeText = FIELD_EVIDENCE(fields, "WK_TYPE");
  const kind = typeText.includes("全職") ? "full_time" : CONTRACT.test(typeText) ? "contract" : null;
  const job = PyDict.of({
    source: "taiwanjobs", external_id: key, title, description: body, url, canonical_url: url, kind,
    source_updated_at: updated.isoformat(), received_at: updated.isoformat(), deadline,
    deadline_evidence: stop, employment_type_evidence: typeText, location_evidence: FIELD_EVIDENCE(fields, "CITYNAME"),
    schedule_evidence: FIELD_EVIDENCE(fields, "WKTIME"),
    salary_evidence: PyDict.of({ period: FIELD_EVIDENCE(fields, "SALARYCD"), low: FIELD_EVIDENCE(fields, "NT_L"), high: FIELD_EVIDENCE(fields, "NT_U") }),
    taiwan_eligible: null, timezone_compatible: null, weekly_hours: null, currency: null, budget_min: null, budget_max: null,
    language: "zh-TW", complete: Boolean(body), body_available: Boolean(body),
  });
  const receipt = identityHash(new PyDict([...job].filter(([k]) => k !== "received_at")));
  return job.update({ receipt_id: "taiwanjobs:" + receipt });
}

/** '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper(), without upper-casing the whole response. */
function declares(text: string): boolean {
  // upper() maps each code point on its own and only letters change, so a match starts at a literal
  // '<!' and its letters come from the next at most 7 code points.
  for (let i = text.indexOf("<!"); i >= 0; i = text.indexOf("<!", i + 1)) {
    const head = pyUpper(String.fromCodePoint(...codePoints(text.slice(i + 2, i + 2 + 14)).slice(0, 7)));
    if (head.startsWith("DOCTYPE") || head.startsWith("ENTITY")) return true;
  }
  return false;
}

export function parseBatch(raw: Uint8Array, now: PyDateTime = PyDateTime.now(), strict = false): PyDict {
  if (raw.length > LIMIT) throw new PyError("ValueError", "Response limit");
  let text = decodeStrict("utf-8", raw);
  if (text.startsWith("﻿")) text = text.slice(1);
  if (declares(text)) throw new PyError("ValueError", "XML declarations not supported");
  // The documented endpoint emits illegal XML name suffixes such as OCCU_DESC（職務名稱）. Rewrite only
  // known tags OUTSIDE CDATA.
  const pieces = text.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
  for (let i = 0; i < pieces.length; i += 2) {
    for (const [key, label] of Object.entries(LABELS)) {
      pieces[i] = pieces[i].replaceAll(`<${key}（${label}）>`, `<${key}>`).replaceAll(`</${key}（${label}）>`, `</${key}>`);
    }
  }
  let root;
  try {
    root = xmlFromString(pieces.join(""));
  } catch (e) {
    if (pyIsInstance(e, "ParseError")) throw new PyError("ValueError", "Unsupported XML format");
    throw e;
  }
  if (root.tag !== "DataList" || root.children.length > 1000 || pyStrip(root.text ?? "")) throw new PyError("ValueError", "Unsupported data list");
  const result: PyDict[] = [], seen = new Set<string>();
  let rejected = 0n;
  for (const record of root.children) {
    if (record.tag !== "Data" || record.attrib.size) throw new PyError("ValueError", "Invalid record");
    const fields = new Map<string, string>();
    for (const child of record.children) {
      if (!Object.hasOwn(LABELS, child.tag) || fields.has(child.tag) || child.children.length || child.attrib.size) throw new PyError("ValueError", "Unsupported field");
      fields.set(child.tag, pyStrip(child.text ?? ""));
    }
    let job: PyDict;
    try {
      job = normalize(fields, now);
    } catch (e) {
      if (!pyIsInstance(e, "ValueError", "TypeError")) throw e;
      if (strict) throw e;
      rejected++;
      continue;
    }
    if (seen.has(job.str("external_id"))) throw new PyError("ValueError", "Duplicate identity");
    seen.add(job.str("external_id"));
    result.push(job);
  }
  return PyDict.of({ jobs: result, rejected_count: rejected, seen: BigInt(root.children.length) });
}

/** taiwanjobs.parse: every row must be valid. */
export const parse = (raw: Uint8Array, now?: PyDateTime) => parseBatch(raw, now, true).at("jobs") as PyDict[];

/** One GET, the time left on the 45-second source deadline. */
export type Get = (url: string, remainingMs: number) => Promise<{ status: number; body: Uint8Array }>;
// urlopen(timeout=8), then read1 with min(8, remaining) per chunk until the deadline and an 8 MB cap.
// Python's resend_preview.NoRedirect makes a redirect an HTTPError, not raiseForUrllibStatus's
// ValueError; sync turns either into one failed source.
const httpGet: Get = (url, remainingMs) => urlopenRead(url, { "User-Agent": "freelance-agent/0.1 personal-job-discovery", Accept: "application/xml" }, LIMIT, 8_000, 8_000, remainingMs);

/** taiwanjobs.fetch */
export async function fetchTaiwanJobs(request: Get = httpGet, now: () => PyDateTime = () => PyDateTime.now()): Promise<PyDict> {
  const r = await request(ENDPOINT, 45_000);
  raiseForUrllibStatus(r.status);
  if (r.status !== 200) throw new PyError("ValueError", "Source unavailable");
  return parseBatch(r.body, now());
}

export type BatchReader = () => Promise<PyValue>;

/**
 * taiwanjobs.sync minus its first line: runSource has already marked the source failed. Throws where
 * Python returns {'status': 'failed'}. With rejected rows the batch never calls finish, so health
 * stays failed.
 */
export async function syncTaiwanJobs(db: Db, reader: BatchReader = () => fetchTaiwanJobs()): Promise<PyDict> {
  const batch = await reader();
  const jobs = isDict(batch) ? pyGet(batch, "jobs") : batch;
  const rejected = isDict(batch) ? pyGet(batch, "rejected_count", 0n) : 0n;
  if (typeof rejected !== "bigint" || rejected < 0n) throw new PyError("ValueError", "Invalid rejected count");
  if (!isList(jobs) || jobs.length > 1000) throw new PyError("ValueError", "Invalid result");
  const now = PyDateTime.now();
  const added = await sourceBatch(db, "taiwanjobs", now, async (b) => {
    const known = await b.existingIds();
    let n = 0n;
    for (const job of jobs as PyDict[]) {
      if (pyGet(job, "source") !== "taiwanjobs") throw new PyError("ValueError", "Wrong source");
      if (!known.has(job.str("external_id"))) {
        const updated = fromisoformat(job.at("source_updated_at"));
        if (updated.utcMicros() < now.utcMicros() - 90n * DAY_US || job.at("kind") !== "contract" || qualifyForIntake(job, now).at("status") === "excluded") continue;
      }
      await b.ingest(job, job.at("receipt_id"));
      n++;
    }
    if (!rejected) await b.finish("ok");
    return n;
  });
  return PyDict.of({
    status: rejected ? "partial" : "ok", seen: BigInt(jobs.length) + rejected, rejected_count: rejected, jobs: added,
    scope: "first_1000_official_open_data_recent_updates", complete_scan: false,
  });
}
