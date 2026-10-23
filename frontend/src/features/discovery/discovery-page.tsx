"use client";

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getDashboard, updatePreferences, updateFeedback } from '../../shared/api/client';
import type { Dashboard, Settings, Feedback } from '../../shared/api/client';
import { PreferencesForm } from '../preferences';
import { SourceStatus } from '../sources';
import { JobDetail } from './job-detail';
import { kinds, compensation } from './format';

export default function DiscoveryPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [selected, setSelected] = useState("");
  const [view, setView] = useState("candidates");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  const reload = useCallback(async () => {
    setData(await getDashboard());
  }, []);
  useEffect(() => { void reload().catch(e => setError(e.message)); }, [reload]);
  const visible = (data?.items || []).filter(item => {
    const state = view === "all" || (view === "saved" ? item.tracking.feedback === "interested" :
      view === "skipped" ? item.tracking.feedback === "skipped" || item.review_status === "skipped" : item.candidate);
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const variants = item.content_conflicts?.flatMap(conflict => conflict.versions.map(version => version.job)) || [];
    const searchable = [item.job.title, item.job.company, item.job.description, item.evaluation.category,
      ...variants.flatMap(job => [job.title, job.company, job.description])].join(" ").toLocaleLowerCase();
    return state && (!source || item.members.some(member => member.source === source)) &&
      (!kind || [item.job, ...variants].some(job => (job.kind || "unknown") === kind)) && words.every(word => searchable.includes(word));
  });
  const active = visible.find(item => item.id === selected) || visible[0];
  const name = (key: string) => data?.platforms[key] || key;
  const saved = data?.items.filter(item => item.tracking.feedback === "interested").length || 0;
  const candidates = data?.items.filter(item => item.candidate).length || 0;
  const sourceOptions = Array.from(new Set((data?.items || []).flatMap(item => item.members.map(member => member.source)))).sort();
  const lastRun = data?.operations.last_run;
  const runLabels: Record<string, string> = { running: '執行中，需核對是否中斷', complete: '完成', failed: '部分來源或處理失敗' };
  const deliveryLabels: Record<string, string> = { pending: '待寄送', attempted: '寄送結果待核對', sent: '已寄出', unknown: '送達未知' };

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      await action();
      await reload();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await reload().catch(() => {});
      setError(e instanceof Error ? e.message : "儲存失敗"); return false;
    } finally { setBusy(false); }
  }
  async function feedback(value: Feedback['feedback']) {
    if (!active) return;
    if (await mutate(() => updateFeedback(active.id, { feedback: value, versions: Object.fromEntries(active.members.map(member => [member.id, member.token])) }))) {
      setNotice(value === "interested" ? "已加入收藏" : value === "skipped" ? "已略過，將不列入每日摘要" : "已恢復待看");
    }
  }

  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark">f<span>・</span></span><span>兼職雷達<small>FREELANCE AGENT</small></span></a>
      <p className="nav-label">我的機會</p>
      <nav aria-label="主選單">
        <button className={view === "candidates" ? "nav-active" : ""} onClick={() => setView("candidates")}>待看職缺 <b>{candidates}</b></button>
        <button className={view === "saved" ? "nav-active" : ""} onClick={() => setView("saved")}>已收藏 <b>{saved}</b></button>
        <a href="/api/digest" target="_blank" rel="noreferrer">摘要預覽 ↗</a>
        <a href="/applications">投案紀錄</a>
      </nav>
      <div className="schedule"><span className="eyebrow">每日摘要</span><strong>09:00 <small>台灣時間</small></strong>
        <p>收案設定 · {data?.intake_enabled ? "已宣告啟用" : "未宣告啟用"}</p><p>Email 設定 · {data?.schedule_enabled ? "已宣告啟用" : "未宣告啟用"}</p>
        {lastRun ? <><p>最近執行 · {lastRun.local_date} · {runLabels[lastRun.status]}</p>
          <p>Email 結果 · {lastRun.delivery_status ? deliveryLabels[lastRun.delivery_status] : '尚無寄送紀錄'}</p></> : <p>尚無每日執行紀錄</p>}</div>
      <footer>集中找機會，收藏值得投入的工作。</footer>
    </aside>
    <main>
      <header className="topbar"><span>多平台兼職探索 · <a href="/applications">投案紀錄</a></span><span className="demo-pill">{data?.mode === "demo" ? "合成資料 Demo" : data ? "個人工作台" : "載入中"}</span></header>
      <section className="intro"><div><p className="eyebrow">YOUR NEXT OPPORTUNITY</p><h1>值得看的兼職，集中在這裡。</h1><p>依專長整理多平台機會，保留原始連結與待確認條件。</p></div>
        <button className="outline-button" disabled={!data?.preferences} onClick={() => {
          setDraft(structuredClone(data!.preferences.settings)); setSettingsOpen(!settingsOpen);
        }}>篩選設定</button></section>
      {data?.mode === "demo" && <div className="demo-banner"><span>合成資料</span><p>用來預覽搜尋與收藏；重新啟動後重設。</p></div>}
      {error && <div role="alert" className="error">{error} <button onClick={() => void reload().catch(e => setError(e.message))}>重新載入</button></div>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {settingsOpen && draft && data && <PreferencesForm draft={draft} categories={data.categories} busy={busy} onChange={setDraft} onSave={async () => {
        if (await mutate(() => updatePreferences({ revision: data.preferences.revision, settings: draft }))) {
          setSettingsOpen(false); setNotice("篩選設定已儲存，清單與後續摘要會一起套用");
        }
      }} />}
      <section className="metrics" aria-label="職缺概況">
        <div><span>待看機會</span><strong>{candidates}<small>組</small></strong></div>
        <div><span>已收藏</span><strong>{saved}<small>組</small></strong></div>
        <div><span>每週工時上限</span><strong>{data?.preferences?.settings.max_weekly_hours ?? "不限"}<small>小時</small></strong></div>
        <div><span>最近讀取成功</span><strong>{Object.values(data?.sources || {}).filter(value => value === "ok").length}<small>個來源</small></strong></div>
      </section>
      <div className="search-tools">
        <label className="search">搜尋職缺<input aria-label="搜尋職缺" value={query} onChange={e => setQuery(e.target.value)} placeholder="職稱、公司或技術，例如 Python" /></label>
        <label>平台<select aria-label="平台" value={source} onChange={e => setSource(e.target.value)}><option value="">全部平台</option>{sourceOptions.map(value => <option key={value} value={value}>{name(value)}</option>)}</select></label>
        <label>合作型態<select aria-label="合作型態" value={kind} onChange={e => setKind(e.target.value)}><option value="">全部型態</option>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="unknown">型態待確認</option></select></label>
      </div>
      <div className="filters" role="group" aria-label="職缺狀態">{[["candidates", "待看"], ["saved", "收藏"], ["skipped", "已略過"], ["all", "全部"]].map(([value, label]) =>
        <button key={value} aria-pressed={view === value} className={view === value ? "selected" : ""} onClick={() => setView(value)}>{label}</button>)}</div>
      <div className="work-area">
        <section className="inbox" aria-label="職缺清單"><div className="section-heading"><h2>機會清單</h2><span>{visible.length} 組 · 相同職缺集中顯示</span></div>
          {!data && !error && <p className="empty">正在載入職缺…</p>}
          {data && !visible.length && <p className="empty">目前沒有符合這組篩選的機會。</p>}
          {visible.map(item => <button className={"job-card " + (active?.id === item.id ? "active" : "")} key={item.id} onClick={() => setSelected(item.id)}>
            <div className="card-top"><span className="platform">{Array.from(new Set(item.members.map(member => name(member.source)))).join(" · ")}</span>
              <span className={"badge " + (item.content_conflicts?.length ? "needs_info" : item.evaluation.status)}>{item.content_conflicts?.length ? "通知內容有差異" : item.evaluation.status === "excluded" ? "條件不符" : item.evaluation.status === "needs_info" ? "條件待確認" : "條件吻合"}</span></div>
            <h3>{item.job.title}</h3><p>{item.job.company || "公司未提供"} · {kinds[item.job.kind || ""] || "合作型態待確認"}</p>
            <p>{item.job.description}</p><div className="card-bottom"><span>{compensation(item.job)}</span><span>{item.job.weekly_hours ? item.job.weekly_hours + "h／週" : "工時待確認"}</span></div>
            <div className="card-meta"><span>{item.evaluation.category}</span><span>{item.tracking.feedback === "interested" ? "★ 已收藏" : item.members.length > 1 ? item.members.length + " 個來源紀錄" : ""}</span></div>
          </button>)}
        </section>
        <JobDetail active={active} busy={busy} name={name} onFeedback={feedback} />
      </div>
      <SourceStatus sources={data?.sources || {}} operations={data?.operations} name={name} />
    </main>
  </div>;
}
