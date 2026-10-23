"use client";
import './applications.css';
import { useEffect, useState } from 'react';
import { ApiError, createApplication, getOpportunity, getApplicationSummary } from '../../shared/api/client';
import type { ApplicationFields, Item } from '../../shared/api/client';
import { ApplicationForm } from './application-form';
import { getProposal,getSubmission } from '../../shared/api/workbench';
import type { PartySelection } from '../../shared/api/workbench';
import { PartyPicker } from '../relationships';

export default function NewApplicationPage() {
  const [initial,setInitial] = useState<ApplicationFields | null>(null);
  const [item,setItem] = useState<Item | null>(null);
  const [requestId,setRequestId] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [conflict,setConflict] = useState(false);
  const [uncertain,setUncertain] = useState(false);
  const [confirmed,setConfirmed] = useState(false);
  const [saved,setSaved] = useState(false);
  const [proposalId,setProposalId]=useState<string|null>(null),[proposalVersion,setProposalVersion]=useState<number|null>(null),[submissionId,setSubmissionId]=useState<string|null>(null),[party,setParty]=useState<PartySelection|null>(null);
  const [sourceChanged,setSourceChanged]=useState(false),[sourceConfirmed,setSourceConfirmed]=useState(false);

  async function load() {
    const query=new URLSearchParams(window.location.search);
    let key = query.get('opportunity');
    const intentKey=query.get('submission');let draftKey=query.get('draft');let chosenVersion=Number(query.get('version')||'1');
    const intent=intentKey?await getSubmission(intentKey):null;
    if(intent){if(intent.status!=='accepted'&&!intent.reconciliation)throw new Error('送出結果尚未查證，請先核對送出紀錄');draftKey=intent.draft_id;chosenVersion=intent.draft_version;setSubmissionId(intent.id);}
    const draft=draftKey?await getProposal(draftKey):null;
    if(draft){if(!draft.versions?.some(v=>v.version===chosenVersion))throw new Error('找不到所選草稿版本');setProposalId(draft.id);setProposalVersion(chosenVersion);key=key||Object.keys(draft.source_tokens)[0]||null;}
    const [summary,found] = await Promise.all([getApplicationSummary(),key ? getOpportunity(key) : undefined]);
    if (key && !found) throw new Error('找不到原職缺，請返回探索清單重新選擇');
    setItem(found || null);
    setSourceChanged(!!draft&&!!found&&(Object.keys(draft.source_tokens).length!==found.members.length||found.members.some(m=>draft.source_tokens[m.id]!==m.token)));
    if (found?.application_ids?.length) throw new Error('這個職缺已有投案紀錄，請到投案清單查看');
    setInitial(previous => previous || { title: draft?.title || found?.job.title || '', contact: draft?.party?.contact_name || draft?.party?.client_name || found?.job.company || '',
      url: found?.job.url?.startsWith('https://') ? found.job.url : null,
      applied_on: summary.today, stage:'applied',follow_up_on:null,note:'' });
  }
  useEffect(() => { setRequestId(crypto.randomUUID()); void load().catch(e => setError(e.message)); }, []);

  async function submit(fields:ApplicationFields) {
    if (conflict || saved || sourceChanged&&!sourceConfirmed) return;
    setBusy(true); setError('');
    try {
      await createApplication({ ...fields,request_id:requestId,
        versions:Object.fromEntries((item?.members || []).map(member => [member.id,member.token])),
        ...(proposalId?{proposal_id:proposalId,proposal_version:proposalVersion}:{}),...(submissionId?{submission_id:submissionId}:{}),...(party?{party}:{}) });
      setSaved(true); setUncertain(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
      setConflict(e instanceof ApiError && e.status===409);
      if (!(e instanceof ApiError) || e.status===503) setUncertain(true);
    } finally { setBusy(false); }
  }
  return <main className="applications-page"><header className="topbar"><a href="/">← 探索機會</a><a href="/applications">投案紀錄</a></header>
    <h1>記錄已投案</h1>
    {item && <p>關聯 {item.members.length} 個來源紀錄：{item.job.title}</p>}
    {!item && initial && <p>手動機會／熟人轉介；不建立平台職缺。</p>}
    {proposalId&&<p>關聯草稿版本 {proposalVersion}{submissionId?'及原送出證據':''}；儲存投案不會再次送出。</p>}
    {sourceChanged&&<label><input type="checkbox" checked={sourceConfirmed} onChange={e=>setSourceConfirmed(e.target.checked)}/>來源或人工狀態已變；我已核對原送出紀錄與目前職缺，確認是這次實際投案的機會</label>}
    {error && <p role="alert" className="error">{error}</p>}
    {uncertain && <p className="hint">儲存結果待確認；請先查看投案清單。原請求識別仍保留，原內容可重試。</p>}
    {conflict && <div><p>表單內容保留。請先查看既有紀錄；若尚未建立且確認要再次送出，重新核對來源。</p>
      <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />我已確認沒有重複投案紀錄</label>
      <button className="outline-button" disabled={busy || !confirmed} onClick={() => {setBusy(true); void load().then(()=> {setRequestId(crypto.randomUUID());setConflict(false);setUncertain(false);setConfirmed(false);setError('');}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>重新核對來源</button></div>}
    {saved ? <p role="status" className="notice">投案紀錄已儲存。<a href="/applications">查看投案紀錄 →</a></p>
      : initial && <><PartyPicker onChange={setParty}/><ApplicationForm initial={initial} busy={busy || conflict || sourceChanged&&!sourceConfirmed} onSubmit={submit} /></>}
  </main>;
}
