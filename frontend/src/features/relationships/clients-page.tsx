"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { getClients,getClient,createClient,updateClient,archiveClient,getContacts,getContact,createContact,updateContact,archiveContact } from '../../shared/api/workbench';
import type { Client,Contact } from '../../shared/api/workbench';
import { ApiError,getApplications } from '../../shared/api/client';
import type { Application } from '../../shared/api/client';
import '../workbench/workbench.css';

export default function ClientsPage(){
  const [clients,setClients]=useState<Client[]>([]),[total,setTotal]=useState(0),[offset,setOffset]=useState(0),[archived,setArchived]=useState(false);
  const [selected,setSelected]=useState<Client|null>(null),[contacts,setContacts]=useState<Contact[]>([]),[contactTotal,setContactTotal]=useState(0),[contactOffset,setContactOffset]=useState(0);
  const [applications,setApplications]=useState<Application[]>([]),[applicationTotal,setApplicationTotal]=useState(0),[applicationOffset,setApplicationOffset]=useState(0);
  const [editing,setEditing]=useState<Client|null>(null),[name,setName]=useState(''),[note,setNote]=useState('');
  const [editingContact,setEditingContact]=useState<Contact|null>(null),[contactName,setContactName]=useState(''),[address,setAddress]=useState(''),[contactNote,setContactNote]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[conflict,setConflict]=useState<'client'|'contact'|null>(null);
  const request=useRef(''),contactRequest=useRef('');
  const reload=useCallback(async()=>{const rows=await getClients({limit:20,offset,include_archived:archived});setClients(rows.items);setTotal(rows.total);},[offset,archived]);
  const detail=useCallback(async(key:string)=>{const [client,people,apps]=await Promise.all([getClient(key),getContacts(key,{limit:20,offset:contactOffset,include_archived:archived}),getApplications({client_id:key,limit:20,offset:applicationOffset})]);setSelected(client);setContacts(people.items);setContactTotal(people.total);setApplications(apps.items);setApplicationTotal(apps.total);},[contactOffset,applicationOffset,archived]);
  useEffect(()=>{request.current=crypto.randomUUID();contactRequest.current=crypto.randomUUID();},[]);
  useEffect(()=>{void reload().catch(e=>setError(e.message));},[reload]);
  useEffect(()=>{if(selected)void detail(selected.id).catch(e=>setError(e.message));},[selected?.id,detail]);
  async function mutate(action:()=>Promise<unknown>,refreshDetail=true){setBusy(true);setError('');setNotice('');try{await action();await reload();if(selected&&refreshDetail)await detail(selected.id);}catch(e){setError(e instanceof Error?e.message:'儲存失敗');}finally{setBusy(false);}}
  async function saveClient(){await mutate(async()=>{try{const row=editing?await updateClient(editing.id,{revision:editing.revision,name,note}):await createClient({request_id:request.current,name,note});setEditing(null);setName('');setNote('');request.current=crypto.randomUUID();setNotice('客戶已儲存');setSelected(row);}catch(e){if(e instanceof ApiError&&e.status===409)setConflict('client');throw e;}},false);}
  async function saveContact(){if(!selected)return;await mutate(async()=>{try{if(editingContact)await updateContact(editingContact.id,{revision:editingContact.revision,name:contactName,address,note:contactNote});else await createContact({request_id:contactRequest.current,client_id:selected.id,client_revision:selected.revision,name:contactName,address,note:contactNote});setEditingContact(null);setContactName('');setAddress('');setContactNote('');contactRequest.current=crypto.randomUUID();setNotice('聯絡人已儲存');}catch(e){if(e instanceof ApiError&&e.status===409)setConflict('contact');throw e;}});}
  async function reconcile(){await mutate(async()=>{if(conflict==='client'&&editing){const latest=await getClient(editing.id);if(!window.confirm(`最新客戶：${latest.name}；備註：${latest.note}。保留目前表單並使用這個版本？`))return;setEditing(latest);}
    else if(conflict==='contact'&&editingContact){const latest=await getContact(editingContact.id);if(!window.confirm(`最新聯絡人：${latest.name}／${latest.address}。保留目前表單並使用這個版本？`))return;setEditingContact(latest);}
    else{if(!window.confirm('已查看客戶／聯絡人清單，確認沒有重複紀錄？將保留表單並建立新的請求。'))return;if(conflict==='client')request.current=crypto.randomUUID();else{if(selected)setSelected(await getClient(selected.id));contactRequest.current=crypto.randomUUID();}}setConflict(null);});}
  return <main className="workbench-page"><h1>客戶與聯絡人</h1><p>明確關聯到投案，保留歷史名稱；建立客戶不代表投案。</p>
    {error&&<p className="error" role="alert">{error}（表單保留；結果不確定時先查看清單。）</p>}{notice&&<p role="status">{notice}</p>}
    {conflict&&<button disabled={busy} onClick={()=>void reconcile()}>核對最新紀錄並保留我的表單</button>}
    <form aria-label="客戶表單" onSubmit={e=>{e.preventDefault();void saveClient();}}><h2>{editing?'編輯客戶':'新增客戶'}</h2>
      <label>客戶名稱<input required maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label><label>客戶備註<textarea maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label>
      <button disabled={busy||!!conflict}>{editing?'儲存客戶':'建立客戶'}</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setName('');setNote('');setConflict(null);}}>取消編輯</button>}</form>
    <section aria-label="客戶清單"><h2>客戶</h2><label><input type="checkbox" checked={archived} onChange={e=>{setArchived(e.target.checked);setOffset(0);setContactOffset(0);}}/>包含封存</label>
      {clients.map(row=><article key={row.id}><button onClick={()=>{setContactOffset(0);setApplicationOffset(0);setSelected(row);setEditingContact(null);setContactName('');setAddress('');setContactNote('');}}>{row.name}</button>{row.archived_at&&<span> · 已封存</span>}
        <p>{row.note}</p>{!row.archived_at&&<><button disabled={busy} onClick={()=>{setEditing(row);setName(row.name);setNote(row.note);setConflict(null);}}>編輯客戶</button><button disabled={busy} onClick={()=>{if(window.confirm('封存客戶？舊關聯保留。'))void mutate(()=>archiveClient(row.id,row.revision));}}>封存客戶</button></>}</article>)}
      <div className="actions"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>上一頁客戶</button><span>{Math.min(offset+20,total)} / {total}</span><button disabled={offset+20>=total} onClick={()=>setOffset(offset+20)}>下一頁客戶</button></div></section>
    {selected&&<section aria-label="客戶詳情"><h2>{selected.name}的聯絡人與投案</h2><a href={'/proposals?client='+selected.id}>為此客戶準備提案</a>
      {!selected.archived_at&&<form aria-label="聯絡人表單" onSubmit={e=>{e.preventDefault();void saveContact();}}><h3>{editingContact?'編輯聯絡人':'新增聯絡人'}</h3>
        <label>聯絡人名稱<input required maxLength={200} value={contactName} onChange={e=>setContactName(e.target.value)}/></label><label>聯絡方式<input maxLength={200} value={address} onChange={e=>setAddress(e.target.value)}/></label>
        <label>聯絡人備註<textarea maxLength={2000} value={contactNote} onChange={e=>setContactNote(e.target.value)}/></label><button disabled={busy||!!conflict}>{editingContact?'儲存聯絡人':'建立聯絡人'}</button>
        {editingContact&&<button type="button" onClick={()=>{setEditingContact(null);setContactName('');setAddress('');setContactNote('');setConflict(null);}}>取消編輯聯絡人</button>}</form>}
      {contacts.map(row=><article key={row.id}><strong>{row.name}</strong><p>{row.address||'未填聯絡方式'}{row.archived_at?' · 已封存':''}</p><p>{row.note}</p>{!row.archived_at&&<><button disabled={busy} onClick={()=>{setEditingContact(row);setContactName(row.name);setAddress(row.address);setContactNote(row.note);setConflict(null);}}>編輯聯絡人</button><button disabled={busy} onClick={()=>{if(window.confirm('封存聯絡人？'))void mutate(()=>archiveContact(row.id,row.revision));}}>封存聯絡人</button></>}</article>)}
      <div className="actions"><button disabled={!contactOffset} onClick={()=>setContactOffset(Math.max(0,contactOffset-20))}>上一頁聯絡人</button><span>{Math.min(contactOffset+20,contactTotal)} / {contactTotal}</span><button disabled={contactOffset+20>=contactTotal} onClick={()=>setContactOffset(contactOffset+20)}>下一頁聯絡人</button></div>
      <h3>關聯投案</h3>{applications.map(row=><p key={row.id}><a href="/applications">{row.title}</a> · {row.applied_on} · {row.stage}</p>)}{!applicationTotal&&<p>沒有關聯投案。</p>}
      <div className="actions"><button disabled={!applicationOffset} onClick={()=>setApplicationOffset(Math.max(0,applicationOffset-20))}>上一頁投案</button><span>{Math.min(applicationOffset+20,applicationTotal)} / {applicationTotal}</span><button disabled={applicationOffset+20>=applicationTotal} onClick={()=>setApplicationOffset(applicationOffset+20)}>下一頁投案</button></div></section>}
  </main>;
}
