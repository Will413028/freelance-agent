"use client";
import { useState } from 'react';
import { PartyPicker } from '../relationships';
import type { PartySelection } from '../../shared/api/workbench';
import { setApplicationParty } from '../../shared/api/workbench';
import { getApplication,ApiError } from '../../shared/api/client';
import type { Application } from '../../shared/api/client';

export function ApplicationParty({row,onSaved}:{row:Application;onSaved:(row:Application)=>void}){
  const [party,setParty]=useState<PartySelection|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[conflict,setConflict]=useState(false),[latest,setLatest]=useState<Application|null>(null);
  async function save(){setBusy(true);setError('');try{onSaved(await setApplicationParty(row.id,{revision:row.revision,...(party||{client_id:null,client_revision:null,contact_id:null,contact_revision:null})}));}catch(e){setError(e instanceof Error?e.message:'關聯失敗');setConflict(e instanceof ApiError&&e.status===409);}finally{setBusy(false);}}
  return <details><summary>更正客戶／聯絡人關聯</summary><p>目前：{row.party?.client_name||'未指定'}{row.party?.contact_name?`／${row.party.contact_name}`:''}；選擇「不指定」並儲存會解除關聯。</p><PartyPicker onChange={setParty}/>
    {error&&<p role="alert">{error}；選擇保留。客戶資料變動時須重新核對並選擇。</p>}{conflict&&<div>{latest?<><p>最新投案：{latest.title}／{latest.stage}；客戶：{latest.party?.client_name||'未指定'}</p><button type="button" onClick={()=>{onSaved(latest);setConflict(false);setLatest(null);}}>已核對最新投案，保留選擇繼續</button></>:<button type="button" onClick={()=>void getApplication(row.id).then(setLatest).catch(e=>setError(e.message))}>讀取最新投案</button>}</div>}
    <button type="button" disabled={busy||conflict} onClick={()=>void save()}>儲存客戶關聯</button></details>;
}
