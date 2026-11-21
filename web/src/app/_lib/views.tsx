import type { View } from "@/modules/evaluation/public";
import type { ContestFields, ContestListView, ContestView, JobFields, JobView, ListView, Plain, SettingsView, SourcesView, StaleRun } from "@/services/pages";
import { LIST_BUDGET_MS, STALE_RUN_HOURS } from "@/services/pages";
import { NOTICES, type Notice } from "./writes";

// The pages' markup (plan step 11), synchronous and props-only so tests can render it with
// renderToStaticMarkup. Every write is a plain form posted to a route that runs the guard.

const KINDS: Record<string, string> = { fixed: "固定專案", hourly: "時薪", contract: "兼職／合約", full_time: "全職" };
const FIELD_NAMES: Record<string, string> = {
  title: "職稱", company: "公司", description: "工作內容", kind: "合作型態", currency: "幣別", budget_min: "預算下限", budget_max: "預算上限",
  weekly_hours: "每週工時", location: "地點", taiwan_eligible: "台灣資格", timezone_compatible: "時區適用",
  deadline: "截止時間", listing_closed: "是否結案", url: "來源連結",
};
const FRESHNESS: Record<string, string> = { recent: "近兩日發布", week: "近七日發布", older: "發布超過七日", unknown: "發布時間未確認" };
const VIEW_LABELS: [View, string][] = [["candidates", "待看"], ["saved", "收藏"], ["skipped", "已略過"], ["all", "全部"]];

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

const text = (job: JobFields, field: keyof JobFields) => (typeof job[field] === "string" && job[field] ? job[field] as string : null);

function compensation(job: JobFields) {
  const max = job.budget_max, min = job.budget_min;
  if (typeof job.currency !== "string" || !job.currency || typeof max !== "number") return "報酬待確認";
  return `${job.currency} ${typeof min === "number" ? min.toLocaleString() : "?"}–${max.toLocaleString()}${job.kind === "hourly" ? "／時" : ""}`;
}

function fieldValue(job: JobFields, field: keyof JobFields) {
  const value = job[field];
  if (value === null || value === "") return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

const statusLabel = (job: JobView) =>
  job.conflict ? "通知內容有差異" : job.status === "excluded" ? "條件不符" : job.status === "needs_info" ? "條件待確認" : "條件吻合";
const kindLabel = (job: JobFields) => KINDS[text(job, "kind") ?? ""] ?? "合作型態待確認";

export function Shell({ active, children }: { active: "jobs" | "contests" | "settings" | "sources"; children: React.ReactNode }) {
  const link = (href: string, key: typeof active, label: string) => <a href={href} className={active === key ? "nav-active" : ""}>{label}</a>;
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark">f<span>・</span></span><span>兼職雷達<small>FREELANCE AGENT</small></span></a>
      <p className="nav-label">我的機會</p>
      <nav aria-label="主選單">{link("/", "jobs", "職缺清單")}{link("/?type=contest", "contests", "競賽清單")}{link("/settings", "settings", "篩選設定")}{link("/sources", "sources", "來源狀態")}</nav>
    </aside>
    <main>{children}</main>
  </div>;
}

export function NoticeLine({ notice }: { notice: string | undefined }) {
  const message = notice && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as Notice] : null;
  return message ? <p role="status" className="notice">{message}</p> : null;
}

const pageHref = (view: View, page: number) => `/?view=${view}${page > 1 ? `&page=${page}` : ""}`;

/** Plan step 6b: one line when no source has been read successfully for over STALE_RUN_HOURS. */
export function StaleLine({ stale }: { stale: StaleRun }) {
  if (!stale) return null;
  return <p role="status" className="notice">{stale.lastSuccessAt
    ? `每日收案最近一次成功讀取來源已超過 ${STALE_RUN_HOURS} 小時（${taipei(stale.lastSuccessAt)}），排程可能停了。`
    : "每日收案還沒有成功讀取過任何來源，清單可能是空的或過時。"}</p>;
}

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
        <div className="card-top"><span className="platform">{job.sourceName}</span><span className={"badge " + (job.conflict ? "needs_info" : job.status)}>{statusLabel(job)}</span></div>
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

const contestHref = (view: View, page: number) => `/?type=contest&view=${view}${page > 1 ? `&page=${page}` : ""}`;
const CONTEST_STATES: Record<ContestView["state"], string> = { open: "徵件中", expired: "已過截止日", closed: "來源已結束或下架" };

/** The prize: the source's own wording, else the amount it gave, else unknown (never 0). */
function prize(c: ContestFields) {
  if (c.prize_text) return c.prize_text;
  return c.currency && typeof c.prize_max === "number" ? `${c.currency} ${c.prize_max.toLocaleString()}` : "獎金待確認";
}

const submissionDeadline = (c: ContestFields) => (c.deadline === null ? "截止日待確認" : c.deadlineUsable ? `截止 ${c.deadline}` : `截止日待確認（來源寫：${c.deadline}）`);
/** Online is where it is held, never who may enter. */
const place = (c: ContestFields) => (c.online === true ? "線上" : c.location ?? (c.online === false ? "實體（地點未提供）" : "地點待確認"));

export function ContestList({ data }: { data: ContestListView }) {
  return <>
    <section className="intro"><div><p className="eyebrow">CONTESTS</p><h1>競賽與黑客松，依截止日排列。</h1>
      <p>最快截止的在前，截止日未確認的在後；不評分。獎金、資格未提供時標示待確認。</p></div></section>
    <div className="filters" role="group" aria-label="競賽狀態">{VIEW_LABELS.map(([value, label]) =>
      <a key={value} href={contestHref(value, 1)} aria-current={data.view === value ? "page" : undefined} className={data.view === value ? "selected" : undefined}>{label}</a>)}</div>
    <section className="inbox" aria-label="競賽清單">
      <div className="section-heading"><h2>競賽清單</h2><span>第 {data.page} 頁</span></div>
      {!data.contests.length && <p className="empty">目前沒有符合這個檢視的競賽。</p>}
      {data.contests.map((c) => <a className="job-card" key={c.id} href={`/jobs/${encodeURIComponent(c.id)}`}>
        <div className="card-top"><span className="platform">{c.sourceName}</span><span className={"badge " + (c.state === "open" ? "qualified" : "excluded")}>{CONTEST_STATES[c.state]}</span></div>
        <h3>{c.contest.title}</h3>
        <p>{c.contest.organiser ?? "主辦單位未提供"} · {place(c.contest)}{c.contest.hackathon === true ? " · 黑客松" : ""}</p>
        <div className="card-bottom"><span>{prize(c.contest)}</span><span>{submissionDeadline(c.contest)}</span></div>
        <div className="card-meta"><span>{c.contest.invite_only === true ? "僅限受邀" : ""}</span>
          <span>{c.feedback === "interested" ? "★ 已收藏" : c.skipped ? "已略過" : c.candidate === false ? "非候選" : ""}</span></div>
      </a>)}
      <nav className="pager" aria-label="分頁">
        {data.page > 1 && <a className="outline-button" href={contestHref(data.view, data.page - 1)}>上一頁</a>}
        {data.hasNext && <a className="outline-button" href={contestHref(data.view, data.page + 1)}>下一頁</a>}
      </nav>
    </section>
  </>;
}

const known = (v: boolean | null, yes: string, no: string) => (v === true ? yes : v === false ? no : "待確認");

export function ContestDetail({ contest: c }: { contest: ContestView }) {
  const back = `/jobs/${encodeURIComponent(c.id)}`;
  const url = safeUrl(c.contest.url);
  return <section className="detail" aria-label="競賽詳情">
    <p className="eyebrow">CONTEST</p><h2>{c.contest.title}</h2>
    <p>{c.contest.organiser ?? "主辦單位未提供"} · {CONTEST_STATES[c.state]}</p>
    <div className="actions discovery-actions">
      <FeedbackButton job={c} value={c.feedback === "interested" ? "unsave" : "interested"} label={c.feedback === "interested" ? "取消收藏" : "收藏競賽"} primary back={back} />
      <FeedbackButton job={c} value={c.skipped ? "restore" : "skipped"} label={c.skipped ? "恢復待看" : "略過"} primary={false} back={back} />
    </div>
    <dl className="job-facts">
      <div><dt>獎金</dt><dd>{prize(c.contest)}</dd></div>
      <div><dt>投稿截止</dt><dd>{submissionDeadline(c.contest)}</dd></div>
      <div><dt>報名截止</dt><dd>{c.contest.registration_deadline ?? "待確認"}</dd></div>
      <div><dt>地點</dt><dd>{place(c.contest)}</dd></div>
      <div><dt>參加方式</dt><dd>{known(c.contest.invite_only, "僅限受邀", "公開報名")}</dd></div>
      <div><dt>黑客松</dt><dd>{known(c.contest.hackathon, "是", "否")}</dd></div>
    </dl>
    <p className="hint">只有日期的截止日以台灣時間當天結束計算，和主辦單位實際的截止時刻可能差幾小時（早或晚）；地區、年齡與身分資格來源未提供，請到原始頁面確認。</p>
    <h3>原始頁面</h3>
    <ul className="source-links"><li>{url ? <a href={url} target="_blank" rel="noreferrer">{c.sourceName} ↗</a> : c.sourceName}</li></ul>
    <p><a className="outline-button" href="/?type=contest">回到清單</a></p>
  </section>;
}

function FeedbackButton({ job, value, label, primary, back }: { job: { id: number; token: string }; value: string; label: string; primary: boolean; back: string }) {
  return <form method="post" action={`/jobs/${encodeURIComponent(job.id)}/feedback`}>
    <input type="hidden" name="token" value={job.token} />
    <input type="hidden" name="value" value={value} />
    <input type="hidden" name="back" value={back} />
    <button className={primary ? "primary-button" : "outline-button"}>{label}</button>
  </form>;
}

export function JobDetail({ job }: { job: JobView }) {
  const back = `/jobs/${encodeURIComponent(job.id)}`;
  const url = safeUrl(job.job.url);
  return <section className="detail" aria-label="職缺詳情">
    <p className="eyebrow">OPPORTUNITY</p><h2>{text(job.job, "title") ?? "（無職稱）"}</h2>
    <p>{text(job.job, "company") ?? "公司未提供"} · {kindLabel(job.job)}</p>
    {job.rankedOn && <p className="hint">推薦分依另一份通知內容計算（版本識別 {job.rankedOn.slice(0, 12)}）；這裡顯示的是最早收到的內容。</p>}
    <div className="actions discovery-actions">
      <FeedbackButton job={job} value={job.feedback === "interested" ? "unsave" : "interested"} label={job.feedback === "interested" ? "取消收藏" : "收藏職缺"} primary back={back} />
      <FeedbackButton job={job} value={job.skipped ? "restore" : "skipped"} label={job.skipped ? "恢復待看" : "略過"} primary={false} back={back} />
    </div>
    <dl className="job-facts">
      <div><dt>報酬</dt><dd>{compensation(job.job)}</dd></div>
      <div><dt>每週工時</dt><dd>{typeof job.job.weekly_hours === "number" ? `${job.job.weekly_hours} 小時` : "待確認"}</dd></div>
      <div><dt>地點</dt><dd>{text(job.job, "location") ?? "待確認"}</dd></div>
      <div><dt>台灣資格</dt><dd>{job.job.taiwan_eligible === true ? "有來源依據" : job.job.taiwan_eligible === false ? "不符合" : "待確認"}</dd></div>
      <div><dt>推薦分</dt><dd>{job.score}（資訊完整度 {job.completeness}%）</dd></div>
      <div><dt>新鮮度</dt><dd>{FRESHNESS[job.freshness] ?? job.freshness}</dd></div>
    </dl>
    <h3>匹配理由</h3><p>{job.category}</p>
    {job.reasons.length > 0 && <ul className="reasons">{job.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    <h3>排序依據</h3><ul className="reasons">{job.rankReasons.map((r) => <li key={r}>{r}</li>)}</ul>
    <h3>工作內容</h3><p className="detail-desc">{text(job.job, "description") ?? ""}</p>
    {job.conflict && <section className="content-conflicts" aria-label="通知內容差異">
      <h3>同職缺通知內容有差異</h3><p className="hint">各份內容都保留；轉寄時間無法判斷來源版本的新舊。請對照原始職缺確認。</p>
      <p className="conflict-fields">{job.conflict.changedFields.length ? `差異欄位：${job.conflict.changedFields.map((f) => FIELD_NAMES[f] ?? f).join("、")}` : "差異在這裡未列出的欄位（例如發布時間或原文），請對照原始職缺"}</p>
      <div className="content-versions">{job.conflict.versions.map((version, index) => <article key={version.fingerprint}>
        <h4>{version.original ? "現有紀錄" : `另一份通知內容 ${index}`} · 版本識別 {version.fingerprint.slice(0, 12)}</h4>
        <p>條件{version.status === "excluded" ? "不符" : version.status === "qualified" ? "吻合" : "待確認"}</p>
        <dl>{job.conflict!.changedFields.map((field) => <div key={field}><dt>{FIELD_NAMES[field] ?? field}</dt>
          <dd>{field === "url" && safeUrl(version.job.url) ? <a href={safeUrl(version.job.url)} target="_blank" rel="noreferrer">{String(version.job.url)}</a> : fieldValue(version.job, field as keyof JobFields)}</dd></div>)}</dl>
        {safeUrl(version.job.url) && <a href={safeUrl(version.job.url)} target="_blank" rel="noreferrer">查看這份內容的來源 ↗</a>}
      </article>)}</div>
    </section>}
    <h3>原始職缺</h3>
    <ul className="source-links"><li>{url ? <a href={url} target="_blank" rel="noreferrer">{job.sourceName} ↗</a> : job.sourceName}</li></ul>
    {job.questions.length > 0 && <details className="unknowns"><summary>待確認資訊</summary><ul className="questions">{job.questions.map((q) => <li key={q}>{q}</li>)}</ul></details>}
    <p><a className="outline-button" href="/">回到清單</a></p>
  </section>;
}

export function SettingsForm({ data }: { data: SettingsView }) {
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
    <button className="primary-button">儲存篩選設定</button>
  </form>;
}

const SOURCE_LABELS: Record<string, string> = { ok: "最近讀取成功", failed: "讀取失敗" };
const RUN_LABELS: Record<string, string> = { running: "執行中，或中斷待下次接續", succeeded: "完成", failed: "部分來源或處理失敗" };

function taipei(value: string | null) {
  if (!value) return "尚無紀錄";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "時間未知" : new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date) + " 台灣時間";
}

function countsLine(c: Record<string, Plain>) {
  const n = (k: string) => (typeof c[k] === "number" ? c[k] as number : null);
  const parts: string[] = [];
  if (n("seen") !== null) parts.push(`讀取 ${n("seen")} 筆`);
  if (n("stored") !== null) parts.push(`寫入 ${n("stored")} 筆`);
  if (n("inserted") !== null) parts.push(`新增 ${n("inserted")} 筆`);
  if (n("rejected")) parts.push(`拒收 ${n("rejected")} 筆`);
  if (n("reread")) parts.push(`重讀 ${n("reread")} 封${n("rereadRejected") ? `（仍被拒 ${n("rereadRejected")}）` : ""}`);
  if (c.truncated === true) parts.push("本次讀取未完整");
  if ((n("attempts") ?? 1) > 1) parts.push(`嘗試 ${n("attempts")} 次`);
  return parts.join(" · ");
}

export function SourcesTable({ data }: { data: SourcesView }) {
  const run = data.lastRun;
  return <>
    <StaleLine stale={data.stale} />
    <h1>來源狀態</h1>
    <section className="schedule" aria-label="最近一次每日收案">
      <span className="eyebrow">最近一次每日收案</span>
      {run ? <>
        <p>{run.localDate} · {RUN_LABELS[run.status] ?? run.status}</p>
        <p>開始 {taipei(run.startedAt)}{run.finishedAt ? ` · 結束 ${taipei(run.finishedAt)}` : ""}</p>
        {run.reason && <p>原因：{run.reason}</p>}
        {run.pruned !== null && <p>保留期限刪除 {run.pruned} 筆</p>}
        {run.listMs !== null && <p>{run.listSlow ? `清單頁查詢 ${run.listMs} ms，超過 ${LIST_BUDGET_MS} ms 上限` : `清單頁查詢 ${run.listMs} ms`}</p>}
      </> : <p>尚無每日執行紀錄</p>}
    </section>
    <p className="hint">讀取成功代表最近一次已配置範圍的結果；尚未接通或讀取不完整的來源不等於沒有職缺。</p>
    <table>
      <thead><tr><th>來源</th><th>最近一次每日收案</th><th>時間</th><th>明細</th></tr></thead>
      <tbody>{data.sources.map((s) => <tr key={s.source}>
        <td>{s.name}</td>
        <td>{s.disabled ? `停用：${s.disabled}` : s.latest ? `${s.latest.localDate} · ${SOURCE_LABELS[s.latest.status] ?? s.latest.status}` : "尚未執行"}</td>
        <td>{s.latest ? taipei(s.latest.finishedAt) : "—"}</td>
        <td>{s.latest ? [countsLine(s.latest.counts), s.latest.reason && `錯誤種類 ${s.latest.reason}`].filter(Boolean).join(" · ") || "—" : "—"}</td>
      </tr>)}</tbody>
    </table>
    <RejectedMail rows={data.rejectedMail} />
  </>;
}

function MailAction({ row, action, label }: { row: SourcesView["rejectedMail"][number]; action: "retry" | "dismiss"; label: string }) {
  return <form method="post" action={`/sources/${action}`}>
    <input type="hidden" name="source" value={row.source} />
    <input type="hidden" name="reason" value={row.reason} />
    <input type="hidden" name="back" value="/sources" />
    <button className="outline-button">{label}</button>
  </form>;
}

/** Rejected mail by reason: re-read after a parser fix, or dismiss what is not a listing. */
function RejectedMail({ rows }: { rows: SourcesView["rejectedMail"] }) {
  return <section aria-label="被拒的信">
    <h2>被拒的信</h2>
    {rows.length ? <>
      <p className="hint">依原因代碼分組。修好解析後按「重讀」，下次每日收案會重讀這些信；確定不是職缺通知的按「略過」。</p>
      <table>
        <thead><tr><th>來源</th><th>原因代碼</th><th>未處理</th><th>待重讀</th><th>最舊</th><th>處理</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={`${r.source}/${r.reason}`}>
          <td>{r.name}</td><td><code>{r.reason}</code></td><td>{r.open}</td><td>{r.retry}</td><td>{r.oldestDays} 天</td>
          <td>{r.open > 0 && r.canRetry && <MailAction row={r} action="retry" label="重讀" />}<MailAction row={r} action="dismiss" label="略過" /></td>
        </tr>)}</tbody>
      </table>
    </> : <p>沒有未處理的被拒信件</p>}
  </section>;
}
