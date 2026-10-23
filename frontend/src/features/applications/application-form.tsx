"use client";
import { useState } from 'react';
import type { ApplicationFields } from '../../shared/api/client';

export const stageNames: Record<ApplicationFields['stage'], string> = {
  applied: '已投案', negotiating: '洽談中', won: '已承接', closed: '結束'
};

export function ApplicationForm({ initial, busy, onSubmit, onCancel }: {
  initial: ApplicationFields; busy: boolean; onSubmit: (fields: ApplicationFields) => Promise<void>; onCancel?: () => void;
}) {
  const [fields, setFields] = useState<ApplicationFields>(() => ({
    title:initial.title,contact:initial.contact,url:initial.url,applied_on:initial.applied_on,
    stage:initial.stage,follow_up_on:initial.follow_up_on,note:initial.note
  }));
  return <form className="application-form" aria-label="投案表單" onSubmit={e => { e.preventDefault(); void onSubmit(fields); }}>
    <p className="hint">本人填寫的投案紀錄；請在實際送出後填寫。</p>
    <div className="preference-fields">
      <label>機會名稱<input required maxLength={200} value={fields.title} onChange={e => setFields({ ...fields, title: e.target.value })} /></label>
      <label>公司／聯絡對象<input maxLength={200} value={fields.contact} onChange={e => setFields({ ...fields, contact: e.target.value })} /></label>
      <label>原文連結（可留空）<input type="url" maxLength={2048} value={fields.url || ''} onChange={e => setFields({ ...fields, url: e.target.value || null })} /></label>
      <label>投案日期<input required type="date" value={fields.applied_on} onChange={e => setFields({ ...fields, applied_on: e.target.value })} /></label>
      <label>目前階段<select value={fields.stage} onChange={e => setFields({ ...fields, stage: e.target.value as ApplicationFields['stage'] })}>{Object.entries(stageNames).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>下次跟進日期<input type="date" value={fields.follow_up_on || ''} onChange={e => setFields({ ...fields, follow_up_on: e.target.value || null })} /></label>
    </div>
    <label>簡短備註<textarea maxLength={2000} value={fields.note} onChange={e => setFields({ ...fields, note: e.target.value })} /></label>
    <div className="actions">{onCancel && <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>取消編輯</button>}<button className="primary-button" disabled={busy} type="submit">儲存投案紀錄</button></div>
  </form>;
}
