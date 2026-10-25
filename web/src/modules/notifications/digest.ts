import { groupItems, isCandidate, number } from "@/modules/discovery/public";
import { formatG } from "@/platform/py/format";
import { escape } from "@/platform/py/html";
import { encode } from "@/platform/py/json";
import { codePoints, pyIntToFloat, pyStr } from "@/platform/py/unicode";
import { hostname, urlsplitValue, userinfo } from "@/platform/py/url";
import { asDict, asList, isDict, isList, pyGet, PyDict, PyError, truthy, type PyValue } from "@/platform/py/value";

// Port of notifications/digest.py: the digest HTML, for the daily preview, the delivery message
// (email=true, plan step 10c) and the /digest page (step 11).

export const SOURCE_STATUS: Record<string, string> = { waiting: "等待符合規則的職缺通知", not_connected: "尚未接通", failed: "讀取失敗或不完整", ok: "讀取成功", demo: "合成資料" };
const CONFLICT_FIELDS: Record<string, string> = {
  title: "職稱", company: "公司", description: "工作內容", kind: "合作型態", currency: "幣別", budget_min: "預算下限", budget_max: "預算上限",
  weekly_hours: "每週工時", location: "地點", location_evidence: "地點依據", taiwan_eligible: "台灣資格", timezone_compatible: "時區適用",
  deadline: "截止時間", listing_closed: "是否結案", url: "來源連結",
};
const KINDS: Record<string, string> = { fixed: "固定專案", hourly: "時薪", contract: "兼職／合約" };
const FRESHNESS: Record<string, string> = { recent: "近兩日發布", week: "近七日發布", older: "發布超過七日" };

/** dict.get(key, default) with a key read from data: a list or dict key is unhashable. */
function lookup(table: Record<string, string>, key: PyValue, fallback: string): string {
  if (isList(key) || isDict(key)) throw new PyError("TypeError", "unhashable type");
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : fallback;
}

/** s[:n] + ('…' if len(s) > n else ''), counted in code points as Python does. */
function clip(s: string, n = 180): string {
  const cps = codePoints(s);
  return cps.length > n ? String.fromCodePoint(...cps.slice(0, n)) + "…" : s;
}

/** f-string / str() of a value that is printed as is. */
const show = (v: PyValue) => pyStr(v);

/** A str required where Python calls a str method or joins (str.join raises on anything else). */
function str(v: PyValue): string {
  if (typeof v !== "string") throw new PyError("TypeError", "expected str instance");
  return v;
}

export function safeUrl(url: PyValue | undefined): string {
  try {
    const parsed = urlsplitValue(url);
    const { username, password } = userinfo(parsed.netloc);
    return parsed.scheme === "https" && hostname(parsed.netloc) && !username && !password ? (url as string) : "#";
  } catch (e) {
    if (e instanceof PyError && (e.pyType === "ValueError" || e.pyType === "TypeError")) return "#";
    throw e;
  }
}

function conflictDetails(item: PyDict): string {
  const blocks: string[] = [];
  for (const conflict of asList(pyGet(item, "content_conflicts", [])).map(asDict)) {
    const fields = asList(conflict.req("changed_fields"));
    const versions: string[] = [];
    asList(conflict.req("versions")).map(asDict).forEach((version, n) => {
      const job = version.dict("job");
      const differences: string[] = [];
      for (const field of fields) {
        const value = pyGet(job, str(field));
        let shown: string;
        if (value === null || value === "") shown = "未提供";
        else if (typeof value === "boolean") shown = value ? "是" : "否";
        else if (field === "url") shown = safeUrl(value);
        else shown = isDict(value) || isList(value) ? encode(value) : show(value);
        differences.push(`${escape(lookup(CONFLICT_FIELDS, field, str(field)))}：${escape(clip(shown))}`);
      }
      const label = truthy(version.req("original")) ? "現有紀錄" : `另一份通知內容 ${n}`;
      const url = safeUrl(pyGet(job, "url"));
      const link = url !== "#" ? ` · <a href="${escape(url, true)}">查看來源</a>` : "";
      versions.push(`<li><strong>${label} · 版本識別 ${escape(clip12(version.str("fingerprint")))}</strong>`
        + `（條件${escape(version.dict("evaluation").req("status"))}）` + differences.join("；") + link + "</li>");
    });
    blocks.push("<section><h3>同職缺通知內容有差異</h3><p>各份內容都保留；轉寄時間無法判斷來源版本的新舊。</p><ul>" + versions.join("") + "</ul></section>");
  }
  return blocks.join("");
}

const clip12 = (s: string) => String.fromCodePoint(...codePoints(s).slice(0, 12));

export type RenderMode = "demo" | "postgres" | "sqlite";

export function render(items: PyDict[], sources: PyDict, o: { mode?: RenderMode; email?: boolean; counts?: PyDict | null } = {}): string {
  const mode = o.mode ?? "demo";
  if (mode !== "demo" && mode !== "postgres" && mode !== "sqlite") throw new PyError("ValueError", "Unknown review mode");
  let notice = mode === "demo" ? "本機 Demo 預覽 · 尚未寄出 · 合成案件，請勿實際申請" : "本機案件摘要預覽 · 尚未寄出 · 案件條件仍需人工確認";
  if (o.email) {
    if (mode === "demo") throw new PyError("ValueError", "Demo cannot render a delivery message");
    notice = "案件條件仍需人工確認；本信不代表已投遞。";
  }
  const grouped = items.every((item) => item.has("members")) ? items : groupItems(items);
  const candidates = grouped.filter(isCandidate);
  const blocks: string[] = [];
  for (const item of candidates) {
    const job = item.dict("job"), evaluation = item.dict("evaluation");
    const kind = lookup(KINDS, pyGet(job, "kind"), "合作型態待確認");
    const high = pyGet(job, "budget_max"), low = pyGet(job, "budget_min");
    const pay = truthy(pyGet(job, "currency")) && number(high)
      ? `${show(job.req("currency"))} ${number(low) ? show(low) : "?"}–${show(high)}` + (pyGet(job, "kind") === "hourly" ? "／時" : "")
      : "報酬待確認";
    const hoursValue = pyGet(job, "weekly_hours");
    const hours = number(hoursValue) ? `${formatG(typeof hoursValue === "bigint" ? pyIntToFloat(hoursValue) : hoursValue)} 小時／週` : "工時待確認";
    const eligibility = pyGet(job, "taiwan_eligible") === true ? "台灣資格有來源依據" : "台灣資格待確認";
    const locationValue = [pyGet(job, "location_evidence"), pyGet(job, "location")].find(truthy);
    const location = locationValue === undefined ? "地點待確認" : show(locationValue);
    const reasons = [str(evaluation.req("category"))];
    if (pyGet(pyGet(item, "tracking", new PyDict()), "feedback") === "interested") reasons.push("已收藏");
    reasons.push(lookup(FRESHNESS, pyGet(pyGet(item, "recommendation", new PyDict()), "freshness"), "發布時間未確認"));
    const members = pyGet(item, "members");
    const links = truthy(members) ? asList(members).map(asDict) : [PyDict.of({ source: job.req("source"), url: pyGet(job, "url") })];
    const sourceLinks = links.map((m) => `<a href="${escape(safeUrl(pyGet(m, "url")), true)}">${escape(m.req("source"))}</a>`).join(" · ");
    const description = pyGet(job, "description");
    const summaryText = clip(truthy(description) ? show(description) : "");
    const basis = pyGet(item, "display_basis");
    const basisNote = truthy(basis)
      ? `<p>主卡依 ${escape(asDict(basis).req("source"))} 的${escape(asDict(basis).req("label"))}顯示`
        + `（版本識別 ${escape(clip12(asDict(basis).str("fingerprint")))}）；這不代表它較新或已核實。</p>`
      : "";
    const company = pyGet(job, "company");
    blocks.push(`<article class="opportunity"><h2>${escape(job.req("title"))}</h2>`
      + `<p>${escape(truthy(company) ? show(company) : "公司未提供")} · ${escape(kind)}</p>`
      + `<p>${escape(pay)} · ${escape(hours)}</p><p>${escape(location)} · ${escape(eligibility)}</p>`
      + `<p>${escape(summaryText)}</p><p>匹配理由：${escape(reasons.join("；"))}</p>`
      + `${basisNote}<p>原始職缺：${sourceLinks}</p>${conflictDetails(item)}</article>`);
  }
  let summary = "";
  if (o.counts) {
    const unseen = o.counts.has("unseen_count") ? o.counts.get("unseen_count")! : BigInt(candidates.length);
    summary = `<p>本次新案／更新 ${pyInt(unseen)} 件；本信列出 ${candidates.length} 件候選。`
      + `已寄送或寄送結果待確認的相同版本 ${pyInt(pyGet(o.counts, "suppressed_count", 0n))} 件不重複列入。</p>`;
  }
  const statuses = [...sources].map(([name, state]) => `<li>${escape(name)}：${lookup(SOURCE_STATUS, state, "狀態未知")}</li>`).join("");
  return '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>接案摘要預覽</title>'
    + '<body style="max-width:720px;margin:40px auto;font-family:system-ui;line-height:1.8;padding:24px">'
    + `<h1>今日兼職機會</h1><p>${notice}</p>${summary}`
    + (blocks.join("") || "<p>目前沒有可列出的候選；請同時檢查來源狀態。</p>")
    + `<h2>來源狀態</h2><ul>${statuses}</ul></body></html>`;
}

/** int(value) for the counts a snapshot stores (ints; a float truncates toward zero). */
function pyInt(v: PyValue): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v)).toString();
  throw new PyError(typeof v === "number" ? "ValueError" : "TypeError", "int() argument");
}
