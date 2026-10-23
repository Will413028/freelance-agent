"use client";
import './applications.css';
import { useCallback, useEffect, useState } from 'react';
import { getApplications, getApplication, getApplicationSummary, updateApplication, deleteApplication, ApiError } from '../../shared/api/client';
import type { Application, ApplicationFields, ApplicationSummary } from '../../shared/api/client';
import { ApplicationForm, stageNames } from './application-form';
import { ApplicationParty } from './application-party';

export default function ApplicationsPage() {
  const [items,setItems]=useState<Application[]>([]);
  const [summary,setSummary]=useState<ApplicationSummary | null>(null);
  const [total,setTotal]=useState(0);
  const [offset,setOffset]=useState(0);
  const [stage,setStage]=useState('');
  const [due,setDue]=useState(false);
  const [editing,setEditing]=useState<Application | null>(null);
  const [conflict,setConflict]=useState(false);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [latest,setLatest]=useState<Application | null>(null);
  const reload=useCallback(async()=>{
    const [rows,counts]=await Promise.all([getApplications({stage:stage || undefined,due,offset,limit:20}),getApplicationSummary()]);
    setItems(rows.items);setTotal(rows.total);setSummary(counts);setLoading(false);
  },[stage,due,offset]);
  useEffect(()=>{if(new URLSearchParams(window.location.search).get('due')==='1')setDue(true);},[]);
  useEffect(()=>{setLoading(true);void reload().catch(e=>{setError(e.message);setLoading(false);});},[reload]);

  async function save(fields:ApplicationFields) {
    if (!editing || conflict) return;
    setBusy(true);setError('');setNotice('');
    try {await updateApplication(editing.id,{...fields,revision:editing.revision});setEditing(null);await reload();setNotice('投案紀錄已更新');}
    catch(e){setError(e instanceof Error ? e.message:'儲存失敗');setConflict(e instanceof ApiError && e.status===409);}
    finally{setBusy(false);}
  }
  async function remove(row:Application) {
    if(!window.confirm('刪除此投案紀錄？歷史更正紀錄會保留。'))return;
    setBusy(true);setError('');setNotice('');
    try{await deleteApplication(row.id,row.revision);if(editing?.id===row.id)setEditing(null);await reload();setNotice('投案紀錄已刪除');}
    catch(e){setError(e instanceof Error ? e.message:'刪除失敗');await reload().catch(()=>{});}
    finally{setBusy(false);}
  }
  return <main className="applications-page"><header className="topbar"><a href="/">← 探索機會</a><a className="primary-button" href="/applications/new">新增手動機會</a></header>
    <section className="intro"><div><h1>投案紀錄</h1><p>本人填寫的進度與下一步。</p></div></section>
    {summary && <section className="metrics" aria-label="投案概況"><div><span>本週已記錄投案</span><strong>{summary.weekly_count}</strong></div><div><span>待跟進（含今日）</span><strong>{summary.due_count}</strong></div><div><span>逾期跟進</span><strong>{summary.overdue_count}</strong></div></section>}
    <p className="hint">統計僅含新的人工投案紀錄；台灣時間週一開始，歷史投遞不推測日期。</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <div className="search-tools"><label>投案階段<select value={stage} onChange={e=>{setStage(e.target.value);setOffset(0);}}><option value="">全部階段</option>{Object.entries(stageNames).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label><input type="checkbox" checked={due} onChange={e=>{setDue(e.target.checked);setOffset(0);}} />只看待跟進</label><button className="outline-button" onClick={()=>void reload().catch(e=>setError(e.message))}>重新載入</button></div>
    {editing && <section className="detail" aria-label="編輯投案"><h2>編輯投案紀錄</h2>
      {conflict && <div><p>表單內容保留，原紀錄已變更；請核對最新紀錄再繼續。</p>
        {!latest ? <button className="outline-button" onClick={()=>{void getApplication(editing.id).then(setLatest).catch(e=>setError(e.message));}}>讀取最新版本</button>
          : <><p>最新紀錄：{latest.title}／{stageNames[latest.stage]}／投案 {latest.applied_on}／跟進 {latest.follow_up_on || '未安排'}</p><p className="application-note">最新備註：{latest.note}</p><button className="outline-button" onClick={()=>{setEditing(latest);setConflict(false);setLatest(null);setError('');}}>已核對，保留我的表單繼續編輯</button></>}
      </div>}
      <ApplicationForm key={editing.id} initial={editing} busy={busy || conflict} onSubmit={save} onCancel={()=>{setEditing(null);setConflict(false);}} />
      <ApplicationParty row={editing} onSaved={updated=>{setEditing(updated);void reload().catch(e=>setError(e.message));}}/>
    </section>}
    {loading && <p className="empty">正在載入投案紀錄…</p>}
    {!loading && !total && <p className="empty">尚無符合篩選的投案紀錄。</p>}
    <section aria-label="投案清單">{items.map(row=><article key={row.id} className="application-card"><h2>{row.title}</h2><p>{row.contact || '聯絡對象未填'} · {stageNames[row.stage]}</p>
      <p>投案 {row.applied_on} · 跟進 {row.follow_up_on || '未安排'}{row.follow_up_on && summary && row.follow_up_on<summary.today && ['applied','negotiating'].includes(row.stage) ? ' · 已逾期':''}</p>
      {row.url && <a href={row.url} target="_blank" rel="noreferrer">查看原文 ↗</a>}<p className="application-note">{row.note}</p>
      <p className="hint">{row.opportunity_ids.length ? `已關聯 ${row.opportunity_ids.length} 個來源紀錄`:'手動機會／轉介'}</p>
      {row.party&&<p>客戶：<a href="/clients">{row.party.client_name}</a>{row.party.contact_name?`／${row.party.contact_name}`:''}（關聯時名稱）</p>}
      {row.proposal&&<p>提案：<a href={'/proposals?draft='+row.proposal.draft_id}>{row.proposal.title} · 版本 {row.proposal.draft_version}</a>{row.proposal.submission_id&&<a href={'/submissions?intent='+row.proposal.submission_id}> · 查看送出／核對證據</a>}</p>}
      <div className="actions"><button className="outline-button" disabled={busy} onClick={()=>{setEditing(row);setConflict(false);setLatest(null);setError('');}}>編輯</button><button className="outline-button" disabled={busy} onClick={()=>void remove(row)}>刪除</button></div>
    </article>)}</section>
    <div className="actions"><button className="outline-button" disabled={offset===0 || loading} onClick={()=>setOffset(Math.max(0,offset-20))}>上一頁</button><span>{total ? offset+1:0}–{Math.min(offset+20,total)} / {total}</span><button className="outline-button" disabled={offset+20>=total || loading} onClick={()=>setOffset(offset+20)}>下一頁</button></div>
  </main>;
}
