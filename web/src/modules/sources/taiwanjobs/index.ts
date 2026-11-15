import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";
import { parseXml } from "./xml";

// TaiwanJobs: the official open-data XML of the latest 1000 updated listings; no login, no
// application (old collection/taiwanjobs.py, web/src/modules/collection/sources/taiwanjobs.ts at
// ce1254d). Every envelope refusal of the old connector stays a refusal of the batch, and so do a
// malformed record or field and a listing named twice. A row the old connector refused
// (rejected_count, which turned the run partial) is set aside and counted in `rejected`, as the old
// did (Will 2026-11-15; more than half set aside fails the source): title, body length, the listing's
// own URL and its EMPLOYER_ID/HIRE_ID identity, and what the source's own rules read: the update date
// (freshness) and the presence of WK_TYPE (contract type; the old kept such a row, now set aside). An unreadable deadline is unknown (plan D8). The source's own
// rules keep contract-type rows (兼職、部分工時、接案、承攬, and not 全職) updated in the last 90 days.

export const ENDPOINT = "https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx?count=1000";
export const LABELS: Record<string, string> = {
  OCCU_DESC: "職務名稱", WK_TYPE: "職務性質", CJOB1_COUNT: "職務大類別代碼", CJOB_NAME1: "職務大類別名稱", CJOB2_COUNT: "職務小類別代碼",
  CJOB_NAME2: "職務小類別名稱", JOB_PERSON: "雇用人數", STOP_DATE: "應徵截止日期", JOB_DETAIL: "工作內容", CITYNAME: "工作地點",
  EXPERIENCE: "工作經驗", WKTIME: "工作時間", SALARYCD: "核薪方式", NT_L: "薪資範圍下限", NT_U: "薪資範圍上限", EDGRDESC: "最低學歷要求",
  URL_QUERY: "職缺資料URL", COMPNAME: "公司名稱", TRANDATE: "職缺更新日期",
};
const MAX_BYTES = 8_000_000;
const MAX_ROWS = 1000;
const DAY_MS = 86_400_000;
const FRESH_DAYS = 90;
const CONTRACT = /兼職|部分工時|接案|承攬/;

const codePoints = (s: string) => [...s].length;
/** Python's str.isspace set, so fields strip as str.strip() did (JavaScript's trim also strips U+FEFF and keeps U+001C–U+001F and U+0085). */
const PY_SPACE = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0                　";
const strip = (s: string) => s.replace(new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu"), "");

/** Value of a Unicode decimal digit: digits come in aligned runs of ten, 0 first. */
function digitValue(ch: string): number {
  let cp = ch.codePointAt(0)!, n = 0;
  while (/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) cp--, n++;
  return n % 10;
}
const number = (digits: string) => [...digits].reduce((v, d) => v * 10 + digitValue(d), 0);

// Python's strptime '%Y%m%d' regex (re.match, then "unconverted data remains" when it stops short);
// Python's \d is any Unicode decimal digit, the month and the day's first digit are ASCII classes.
const STRPTIME_YMD = /^(\p{Nd}{4})(1[0-2]|0[1-9]|[1-9])(3[01]|[12]\p{Nd}|0[1-9]|[1-9]| [1-9])/u;

/** An eight-digit source date as a Taipei calendar date `YYYY-MM-DD` and its midnight instant, or null. */
export function sourceDate(value: string): { date: string; instant: number } | null {
  if (!/^\p{Nd}{8}$/u.test(value)) return null;
  const m = STRPTIME_YMD.exec(value);
  if (!m || m[0].length !== value.length) return null;
  const [y, mo, d] = [number(m[1]), number(m[2]), number(m[3])];
  const utc = new Date(Date.UTC(2000, mo - 1, d));
  utc.setUTCFullYear(y);
  if (y < 1 || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  const date = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { date, instant: utc.getTime() - 8 * 3_600_000 };
}

/**
 * The listing's own URL split as Python's urlsplit did after strip(): tabs and newlines removed,
 * leading C0 controls and spaces dropped, the scheme lower-cased. Only the parts the checks read.
 */
function split(raw: string) {
  const url = raw.replace(/[\t\r\n]/g, "").replace(/^[\x00-\x20]+/, "");
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(url);
  let scheme = "", rest = url;
  if (m) [scheme, rest] = [m[1].toLowerCase(), m[2]];
  let netloc = "";
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end);
    rest = end < 0 ? "" : rest.slice(2 + end);
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf("?");
  return { scheme, netloc, path: q < 0 ? rest : rest.slice(0, q), query: q < 0 ? "" : rest.slice(q + 1) };
}

const PATHS = new Set(["/internet/jobwanted/jobdetail.aspx", "/internet/index/jobdetail.aspx"]);

/** One row in the contract; throws SourceError when its identity or update date is missing or wrong (`setAside` sets that one listing aside). */
export function normalize(fields: Map<string, string>, now: Date): ListingInput {
  const field = (k: string) => fields.get(k) ?? "";
  const title = field("OCCU_DESC"), body = field("JOB_DETAIL");
  if (codePoints(title) < 1 || codePoints(title) > 500 || codePoints(body) > 100_000) throw new SourceError("taiwanjobs: missing requirement");
  const u = split(field("URL_QUERY"));
  if (u.scheme !== "https" || u.netloc !== "job.taiwanjobs.gov.tw" || !PATHS.has(u.path.toLowerCase())) throw new SourceError("taiwanjobs: invalid canonical URL");
  // The old check was Python's [1-9]\d{0,19}: \d is any Unicode decimal digit.
  const q = new URLSearchParams(u.query), ids = ["EMPLOYER_ID", "HIRE_ID"] as const;
  if (ids.some((k) => q.getAll(k).length !== 1 || !/^[1-9]\p{Nd}{0,19}$/u.test(q.get(k)!))) throw new SourceError("taiwanjobs: invalid identity");
  // The id and the link keep the old form: EMPLOYER_ID:HIRE_ID, and the URL with only those two
  // parameters, the path as the source spelled it (spikes.md section 3).
  const url = `https://job.taiwanjobs.gov.tw${u.path}?${new URLSearchParams(ids.map((k) => [k, q.get(k)!])).toString()}`;
  if (!URL.canParse(url)) throw new SourceError("taiwanjobs: invalid canonical URL");
  const updated = sourceDate(field("TRANDATE"));
  if (updated === null) throw new SourceError("taiwanjobs: invalid source date");
  if (updated.instant > now.getTime() + DAY_MS) throw new SourceError("taiwanjobs: future source date");
  // The source's own rule reads WK_TYPE: a row without the field would be filtered out silently, so
  // its absence is a format change (checklist section 2). An empty WK_TYPE is read: the kind is unknown.
  if (!fields.has("WK_TYPE")) throw new SourceError("taiwanjobs: employment type missing");
  const stop = field("STOP_DATE"), typeText = field("WK_TYPE");
  return parseListingInput({
    external_id: `${q.get("EMPLOYER_ID")}:${q.get("HIRE_ID")}`, title, description: body || null, url, canonical_url: url,
    location: field("CITYNAME") || null,
    kind: typeText.includes("全職") ? "full_time" : CONTRACT.test(typeText) ? "contract" : null,
    complete: Boolean(body),
    // STOP_DATE is a Taipei calendar date; anything that is not one is unknown, its text kept in extra.
    deadline: sourceDate(stop) ? { kind: "date", date: sourceDate(stop)!.date } : null,
    extra: {
      // TRANDATE is the listing's update date, not its publication: kept for audit and the freshness rule.
      source_updated_at: new Date(updated.instant).toISOString(), deadline_evidence: stop, employment_type_evidence: typeText,
      schedule_evidence: field("WKTIME"), salary_evidence: { period: field("SALARYCD"), low: field("NT_L"), high: field("NT_U") },
    },
  });
}

/** '<!DOCTYPE' or '<!ENTITY' in any letter case, as the old `in text.upper()` check found them. */
function declares(text: string): boolean {
  for (let i = text.indexOf("<!"); i >= 0; i = text.indexOf("<!", i + 1)) {
    const head = [...text.slice(i + 2, i + 16)].slice(0, 7).join("").toUpperCase();
    if (head.startsWith("DOCTYPE") || head.startsWith("ENTITY")) return true;
  }
  return false;
}

/** Every row of the response in the contract, how many rows it held and how many were set aside; throws SourceError on a batch-level refusal. */
export function parseBatch(raw: Uint8Array, now: Date): { seen: number; listings: ListingInput[]; rejected: number; examined: number } {
  if (raw.length > MAX_BYTES) throw new SourceError("taiwanjobs: response limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new SourceError("taiwanjobs: response is not UTF-8");
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  if (declares(text)) throw new SourceError("taiwanjobs: XML declarations not supported");
  // The endpoint emits illegal XML names such as OCCU_DESC（職務名稱）; only the known tags are
  // rewritten, and only outside CDATA.
  const pieces = text.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
  for (let i = 0; i < pieces.length; i += 2) {
    for (const [key, label] of Object.entries(LABELS)) {
      pieces[i] = pieces[i].replaceAll(`<${key}（${label}）>`, `<${key}>`).replaceAll(`</${key}（${label}）>`, `</${key}>`);
    }
  }
  let root;
  try {
    root = parseXml(pieces.join(""));
  } catch {
    throw new SourceError("taiwanjobs: unsupported XML format");
  }
  if (root.tag !== "DataList" || root.children.length > MAX_ROWS || strip(root.text ?? "")) throw new SourceError("taiwanjobs: unsupported data list");
  const records: Map<string, string>[] = [];
  for (const record of root.children) {
    if (record.tag !== "Data" || record.attrib.size) throw new SourceError("taiwanjobs: invalid record");
    const fields = new Map<string, string>();
    for (const child of record.children) {
      if (!Object.hasOwn(LABELS, child.tag) || fields.has(child.tag) || child.children.length || child.attrib.size) throw new SourceError("taiwanjobs: unsupported field");
      fields.set(child.tag, strip(child.text ?? ""));
    }
    records.push(fields);
  }
  // Old taiwanjobs.ts:122-129: a row that fails to normalize is set aside and counted.
  const { listings, rejected, examined } = setAside(records, (fields) => normalize(fields, now));
  // The old connector refused a response naming one listing twice (:130); that refusal stays.
  const ids = new Set<string>();
  for (const job of listings) {
    if (ids.has(job.external_id)) throw new SourceError("taiwanjobs: duplicate identity");
    ids.add(job.external_id);
  }
  return { seen: root.children.length, listings, rejected, examined };
}

/** The source's own rules: contract rows updated in the last 90 days (old sync, taiwanjobs.ts:174). */
export const kept = (l: ListingInput, now: Date) =>
  l.kind === "contract" && Date.parse(l.extra.source_updated_at as string) >= now.getTime() - FRESH_DAYS * DAY_MS;

export async function taiwanjobsConnector(fetcher: Fetcher, now: Date): Promise<Collected> {
  const r = await fetcher.get({
    url: ENDPOINT, maxBytes: MAX_BYTES, timeoutMs: 45_000,
    headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/xml" },
  });
  const batch = parseBatch(r.body, now);
  return { seen: batch.seen, listings: batch.listings, sourceKept: (l) => kept(l, now), rejected: batch.rejected, examined: batch.examined };
}

/** One request per run (old taiwanjobs.ts:150, a single GET of ENDPOINT). */
export const TAIWANJOBS_SETTINGS: Omit<PageSourceSettings, "order"> = {
  label: "台灣就業通", name: "taiwanjobs", connector: taiwanjobsConnector, maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};
