"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { getTemplates,getTemplate,createTemplate,updateTemplate,archiveTemplate } from '../../shared/api/workbench';
import type { Template } from '../../shared/api/workbench';
import { ApiError } from '../../shared/api/client';

export function Templates(){
  const [rows,setRows]=useState<Template[]>([]),[editing,setEditing]=useState<Template|null>(null),[name,setName]=useState(''),[body,setBody]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[conflict,setConflict]=useState(false),[offset,setOffset]=useState(0),[total,setTotal]=useState(0),[archived,setArchived]=useState(false);const request=useRef('');
  const reload=useCallback(async()=>{const page=await getTemplates({limit:20,offset,include_archived:archived});setRows(page.items);setTotal(page.total);},[offset,archived]);
  useEffect(()=>{request.current=crypto.randomUUID();},[]);useEffect(()=>{void reload().catch(e=>setError(e.message));},[reload]);
  async function save(){setBusy(true);setError('');try{if(editing)await updateTemplate(editing.id,{revision:editing.revision,name,body});else await createTemplate({request_id:request.current,name,body});setEditing(null);setName('');setBody('');request.current=crypto.randomUUID();await reload();}catch(e){setError(e instanceof Error?e.message:'儲存失敗');setConflict(e instanceof ApiError&&e.status===409);}finally{setBusy(false);}}
  async function reconcile(){try{if(editing){const latest=await getTemplate(editing.id);if(!window.confirm(`最新模板：${latest.name}／${latest.body}。保留本人文字並使用這份revision？`))return;setEditing(latest);}else{await reload();if(!window.confirm('已核對沒有重複模板？使用新請求並保留文字。'))return;request.current=crypto.randomUUID();}setConflict(false);}catch(e){setError(e instanceof Error?e.message:'核對失敗');}}
  return <section aria-label="提案模板"><h2>本人模板</h2><p className="hint">可用變數：{'{opportunity_title}、{client_name}、{approach}、{portfolio}、{quote}'}；不執行表達式。</p>
    {error&&<p role="alert">{error}；表單保留。</p>}{conflict&&<button onClick={()=>void reconcile()}>核對最新模板後保留我的文字</button>}
    <form aria-label="模板表單" onSubmit={e=>{e.preventDefault();void save();}}><label>模板名稱<input required maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label><label>模板內容<textarea required maxLength={20000} value={body} onChange={e=>setBody(e.target.value)}/></label><button disabled={busy||conflict}>{editing?'儲存模板':'建立模板'}</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setName('');setBody('');setConflict(false);}}>取消模板編輯</button>}</form>
    <label><input type="checkbox" checked={archived} onChange={e=>{setArchived(e.target.checked);setOffset(0);}}/>顯示封存模板</label>
    {rows.map(row=><article key={row.id}><strong>{row.name}</strong> · v{row.revision}{row.archived_at?' · 已封存':''}<pre>{row.body}</pre>{!row.archived_at&&<><button onClick={()=>{setEditing(row);setName(row.name);setBody(row.body);setConflict(false);}}>編輯模板</button><button disabled={busy} onClick={()=>{if(window.confirm('封存模板？既有草稿不變。'))void archiveTemplate(row.id,row.revision).then(reload).catch(e=>setError(e.message));}}>封存模板</button></>}</article>)}
    <div className="actions"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>上一頁模板</button><span>{Math.min(offset+20,total)} / {total}</span><button disabled={offset+20>=total} onClick={()=>setOffset(offset+20)}>下一頁模板</button></div>
  </section>;
}
