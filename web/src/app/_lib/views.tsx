import type { View } from "@/modules/discovery/public";
import type { JobFields, JobView, ListView, Plain, SettingsView, SourcesView } from "@/services/pages";
import { NOTICES, type Notice } from "./writes";

// The pages' markup (plan step 11), synchronous and props-only so tests can render it with
// renderToStaticMarkup. Every write is a plain form; while writes are off its buttons are disabled
// and say so, and the route refuses it anyway (D23).

const KINDS: Record<string, string> = { fixed: "固定專案", hourly: "時薪", contract: "兼職／合約", full_time: "全職" };
const FIELD_NAMES: Record<string, string> = {
  title: "職稱", company: "公司", description: "工作內容", kind: "合作型態", currency: "幣別", budget_min: "預算下限", budget_max: "預算上限",
  weekly_hours: "每週工時", location: "地點", location_evidence: "地點依據", taiwan_eligible: "台灣資格", timezone_compatible: "時區適用",
  deadline: "截止時間", listing_closed: "是否結案", url: "來源連結",
};
const FRESHNESS: Record<string, string> = { recent: "近兩日發布", week: "近七日發布", older: "發布超過七日", unknown: "發布時間未確認" };
const VIEW_LABELS: [View, string][] = [["candidates", "待看"], ["saved", "收藏"], ["skipped", "已略過"], ["all", "全部"]];
const OFF = "切換到正式系統後開放";

/** An https link without credentials, or undefined: listing URLs are untrusted data. */
export function safeUrl(value: Plain | undefined): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

const text = (job: JobFields, field: string) => (typeof job[field] === "string" && job[field] ? job[field] as string : null);

function compensation(job: JobFields) {
  const max = job.budget_max, min = job.budget_min;
  if (typeof job.currency !== "string" || !job.currency || typeof max !== "number") return "報酬待確認";
  return `${job.currency} ${typeof min === "number" ? min.toLocaleString() : "?"}–${max.toLocaleString()}${job.kind === "hourly" ? "／時" : ""}`;
}

function fieldValue(job: JobFields, field: string) {
  const value = job[field];
  if (value === null || value === undefined || value === "") return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

const statusLabel = (job: JobView) =>
  job.conflicts.length ? "通知內容有差異" : job.status === "excluded" ? "條件不符" : job.status === "needs_info" ? "條件待確認" : "條件吻合";
const kindLabel = (job: JobFields) => KINDS[text(job, "kind") ?? ""] ?? "合作型態待確認";

export function Shell({ active, children }: { active: "jobs" | "settings" | "sources"; children: React.ReactNode }) {
  const link = (href: string, key: typeof active, label: string) => <a href={href} className={active === key ? "nav-active" : ""}>{label}</a>;
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark">f<span>・</span></span><span>兼職雷達<small>FREELANCE AGENT</small></span></a>
      <p className="nav-label">我的機會</p>
      <nav aria-label="主選單">{link("/", "jobs", "職缺清單")}{link("/settings", "settings", "篩選設定")}{link("/sources", "sources", "來源狀態")}</nav>
    </aside>
    <main>{children}</main>
  </div>;
}

export function NoticeLine({ notice }: { notice: string | undefined }) {
  const message = notice && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as Notice] : null;
  return message ? <p role="status" className="notice">{message}</p> : null;
}

export function ReadOnlyHint({ writes }: { writes: boolean }) {
  return writes ? null : <p className="hint">目前是影子期，網頁只能瀏覽；收藏、略過與篩選設定{OFF}。</p>;
}

const pageHref = (view: View, page: number) => `/?view=${view}${page > 1 ? `&page=${page}` : ""}`;

export function JobList({ data }: { data: ListView }) {
  return <>
    <section className="intro"><div><p className="eyebrow">YOUR NEXT OPPORTUNITY</p><h1>值得看的兼職，集中在這裡。</h1>
      <p>依推薦分排序，候選在前；保留原始連結與待確認條件。</p></div></section>
    <div className="filters" role="group" aria-label="職缺狀態">{VIEW_LABELS.map(([value, label]) =>
      <a key={value} href={pageHref(value, 1)} aria-current={data.view === value ? "page" : undefined} className={data.view === value ? "selected" : undefined}>{label}</a>)}</div>
    <section className="inbox" aria-label="職缺清單">
      <div className="section-heading"><h2>機會清單</h2><span>第 {data.page} 頁</span></div>
      {!data.jobs.length && <p className="empty">目前沒有符合這個檢視的職缺。</p>}
      {data.jobs.map((job) => <a className="job-card" key={job.id} href={`/jobs/${encodeURIComponent(job.id)}`}>
        <div className="card-top"><span className="platform">{job.sourceName}</span><span className={"badge " + (job.conflicts.length ? "needs_info" : job.status)}>{statusLabel(job)}</span></div>
        <h3>{text(job.job, "title") ?? "（無職稱）"}</h3>
        <p>{text(job.job, "company") ?? "公司未提供"} · {kindLabel(job.job)}</p>
        <p>{text(job.job, "description") ?? ""}</p>
        <div className="card-bottom"><span>{compensation(job.job)}</span><span>{typeof job.job.weekly_hours === "number" ? `${job.job.weekly_hours}h／週` : "工時待確認"}</span></div>
        <div className="card-meta"><span>{job.category}</span><span>推薦分 {job.score} · {FRESHNESS[job.freshness] ?? job.freshness}</span>
          <span>{job.feedback === "interested" ? "★ 已收藏" : job.skipped ? "已略過" : job.candidate === false ? "非候選" : ""}</span></div>
      </a>)}
      <nav className="pager" aria-label="分頁">
        {data.page > 1 && <a className="outline-button" href={pageHref(data.view, data.page - 1)}>上一頁</a>}
        {data.hasNext && <a className="outline-button" href={pageHref(data.view, data.page + 1)}>下一頁</a>}
      </nav>
    </section>
  </>;
}

function FeedbackButton({ job, value, label, primary, writes, back }: { job: JobView; value: string; label: string; primary: boolean; writes: boolean; back: string }) {
  return <form method="post" action={`/jobs/${encodeURIComponent(job.id)}/feedback`}>
    <input type="hidden" name="token" value={job.token} />
    <input type="hidden" name="value" value={value} />
    <input type="hidden" name="back" value={back} />
    <button className={primary ? "primary-button" : "outline-button"} disabled={!writes} title={writes ? undefined : OFF}>{label}</button>
  </form>;
}

export function JobDetail({ job, writes }: { job: JobView; writes: boolean }) {
  const back = `/jobs/${encodeURIComponent(job.id)}`;
  const url = safeUrl(job.memberUrl);
  return <section className="detail" aria-label="職缺詳情">
    <p className="eyebrow">OPPORTUNITY</p><h2>{text(job.job, "title") ?? "（無職稱）"}</h2>
    <p>{text(job.job, "company") ?? "公司未提供"} · {kindLabel(job.job)}</p>
    {job.displayBasis && <p className="hint">主卡依 {job.displayBasis.sourceName} 的{job.displayBasis.label}顯示（版本識別 {job.displayBasis.fingerprint.slice(0, 12)}）；這不代表它較新或已核實。</p>}
    <div className="actions discovery-actions">
      <FeedbackButton job={job} value={job.feedback === "interested" ? "unsave" : "interested"} label={job.feedback === "interested" ? "取消收藏" : "收藏職缺"} primary writes={writes} back={back} />
      <FeedbackButton job={job} value={job.skipped ? "restore" : "skipped"} label={job.skipped ? "恢復待看" : "略過"} primary={false} writes={writes} back={back} />
    </div>
    <dl className="job-facts">
      <div><dt>報酬</dt><dd>{compensation(job.job)}</dd></div>
      <div><dt>每週工時</dt><dd>{typeof job.job.weekly_hours === "number" ? `${job.job.weekly_hours} 小時` : "待確認"}</dd></div>
      <div><dt>地點</dt><dd>{job.job.location_evidence ? fieldValue(job.job, "location_evidence") : text(job.job, "location") ?? "待確認"}</dd></div>
      <div><dt>台灣資格</dt><dd>{job.job.taiwan_eligible === true ? "有來源依據" : job.job.taiwan_eligible === false ? "不符合" : "待確認"}</dd></div>
      <div><dt>推薦分</dt><dd>{job.score}（資訊完整度 {job.completeness}%）</dd></div>
      <div><dt>新鮮度</dt><dd>{FRESHNESS[job.freshness] ?? job.freshness}</dd></div>
    </dl>
    <h3>匹配理由</h3><p>{job.category}</p>
    {job.reasons.length > 0 && <ul className="reasons">{job.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    <h3>排序依據</h3><ul className="reasons">{job.rankReasons.map((r) => <li key={r}>{r}</li>)}</ul>
    <h3>工作內容</h3><p className="detail-desc">{text(job.job, "description") ?? ""}</p>
    {job.conflicts.length > 0 && <section className="content-conflicts" aria-label="通知內容差異">
      <h3>同職缺通知內容有差異</h3><p className="hint">各份內容都保留；轉寄時間無法判斷來源版本的新舊。請對照原始職缺確認。</p>
      {job.conflicts.map((conflict, i) => <div key={i}>
        <p className="conflict-fields">差異欄位：{conflict.changedFields.map((f) => FIELD_NAMES[f] ?? f).join("、")}</p>
        <div className="content-versions">{conflict.versions.map((version, index) => <article key={version.fingerprint}>
          <h4>{version.original ? "現有紀錄" : `另一份通知內容 ${index}`} · 版本識別 {version.fingerprint.slice(0, 12)}</h4>
          <p>條件{version.status === "excluded" ? "不符" : version.status === "qualified" ? "吻合" : "待確認"}</p>
          <dl>{conflict.changedFields.map((field) => <div key={field}><dt>{FIELD_NAMES[field] ?? field}</dt>
            <dd>{field === "url" && safeUrl(version.job.url) ? <a href={safeUrl(version.job.url)} target="_blank" rel="noreferrer">{String(version.job.url)}</a> : fieldValue(version.job, field)}</dd></div>)}</dl>
          {safeUrl(version.job.url) && <a href={safeUrl(version.job.url)} target="_blank" rel="noreferrer">查看這份內容的來源 ↗</a>}
        </article>)}</div>
      </div>)}
    </section>}
    <h3>原始職缺</h3>
    <ul className="source-links"><li>{url ? <a href={url} target="_blank" rel="noreferrer">{job.sourceName} ↗</a> : job.sourceName}</li></ul>
    {job.questions.length > 0 && <details className="unknowns"><summary>待確認資訊</summary><ul className="questions">{job.questions.map((q) => <li key={q}>{q}</li>)}</ul></details>}
    <p><a className="outline-button" href="/">回到清單</a></p>
  </section>;
}

export function SettingsForm({ data, writes }: { data: SettingsView; writes: boolean }) {
  return <form className="preferences" aria-label="篩選設定" method="post" action="/settings/save">
    <h2>我的篩選條件</h2>
    <input type="hidden" name="revision" value={data.revision} />
    <input type="hidden" name="back" value="/settings" />
    <div className="preference-fields">
      <label>每週工時上限<input name="max_weekly_hours" type="number" min="1" max="168" defaultValue={data.maxWeeklyHours ?? ""} placeholder="留空表示不限" /></label>
      <label>固定專案最低預算（TWD）<input name="min_fixed_twd" type="number" min="0" max="10000000" required defaultValue={data.minFixedTwd} /></label>
    </div>
    <fieldset><legend>專長分類</legend>{data.allCategories.map((c) =>
      <label key={c}><input type="checkbox" name="categories" value={c} defaultChecked={data.categories.includes(c)} />{c}</label>)}</fieldset>
    <p className="hint">未提供工時或報酬的機會仍會保留並標示待確認；時薪與外幣不套固定案 TWD 門檻。</p>
    <button className="primary-button" disabled={!writes} title={writes ? undefined : OFF}>儲存篩選設定</button>
  </form>;
}

const SOURCE_LABELS: Record<string, string> = { ok: "最近讀取成功", partial: "部分資料取得", failed: "讀取失敗或不完整", waiting: "等待職缺通知", not_connected: "尚未接通" };
const RUN_LABELS: Record<string, string> = { running: "執行中，需核對是否中斷", complete: "完成", failed: "部分來源或處理失敗" };

function taipei(value: string | null) {
  if (!value) return "尚無紀錄";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? "時間未知" : new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date) + " 台灣時間";
}

function dailyLine(daily: Record<string, Plain>) {
  const n = (k: string) => (typeof daily[k] === "number" ? daily[k] as number : null);
  const parts = [n("seen") !== null ? `讀取 ${n("seen")} 筆` : n("messages") !== null ? `職缺通知 ${n("messages")} 封` : "讀取數量未知"];
  if (n("jobs") !== null) parts.push(`初篩 ${n("jobs")} 筆`);
  if (n("rejected_count") !== null) parts.push(`拒收 ${n("rejected_count")} 筆`);
  if (n("quarantined") !== null) parts.push(`隔離 ${n("quarantined")} 封`);
  if (daily.truncated === true || daily.limited === true) parts.push("本次讀取未完整");
  if (daily.complete_scan === false) parts.push("有限範圍，不代表全站");
  return parts.join(" · ");
}

export function SourcesTable({ data }: { data: SourcesView }) {
  const run = data.lastRun;
  return <>
    <h1>來源狀態</h1>
    <section className="schedule" aria-label="最近一次每日收案">
      <span className="eyebrow">最近一次每日收案</span>
      {run ? <>
        <p>{run.localDate} · {RUN_LABELS[run.status] ?? run.status}</p>
        <p>開始 {taipei(run.startedAt)}{run.finishedAt ? ` · 結束 ${taipei(run.finishedAt)}` : ""}</p>
        {run.reason && <p>原因：{run.reason}</p>}
      </> : <p>尚無每日執行紀錄</p>}
    </section>
    <p className="hint">讀取成功代表最近一次已配置範圍的結果；尚未接通或讀取不完整的來源不等於沒有職缺。</p>
    <table>
      <thead><tr><th>來源</th><th>狀態</th><th>檢查時間</th><th>最近一次每日收案</th></tr></thead>
      <tbody>{data.sources.map((s) => <tr key={s.source}>
        <td>{s.name}</td><td>{SOURCE_LABELS[s.status] ?? s.status}</td><td>{taipei(s.checkedAt)}</td>
        <td>{s.daily ? `${typeof s.daily.status === "string" ? SOURCE_LABELS[s.daily.status] ?? s.daily.status : "結果未知"} · ${dailyLine(s.daily)}` : "—"}</td>
      </tr>)}</tbody>
    </table>
  </>;
}
