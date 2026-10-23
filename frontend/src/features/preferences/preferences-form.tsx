import type { Settings } from '../../shared/api/client';

export function PreferencesForm({ draft, categories, busy, onChange, onSave }: {
  draft: Settings; categories: string[]; busy: boolean;
  onChange: (value: Settings) => void; onSave: () => Promise<void>;
}) {
  return <form className="preferences" aria-label="篩選設定" onSubmit={async event => { event.preventDefault(); await onSave(); }}>
    <h2>我的篩選條件</h2>
    <div className="preference-fields"><label>每週工時上限<input aria-label="每週工時上限" type="number" min="1" max="168" value={draft.max_weekly_hours ?? ''}
      placeholder="留空表示不限" onChange={e => onChange({ ...draft, max_weekly_hours: e.target.value === '' ? null : Number(e.target.value) })} /></label>
      <label>固定專案最低預算（TWD）<input aria-label="固定專案最低預算" type="number" min="0" max="10000000" value={draft.min_fixed_twd}
        onChange={e => onChange({ ...draft, min_fixed_twd: Number(e.target.value) })} /></label></div>
    <fieldset><legend>專長分類</legend>{categories.map(category => <label key={category}><input type="checkbox" checked={draft.categories.includes(category)}
      onChange={e => onChange({ ...draft, categories: e.target.checked ? [...draft.categories, category] : draft.categories.filter(value => value !== category) })} />{category}</label>)}</fieldset>
    <p className="hint">未提供工時或報酬的機會仍會保留並標示待確認；時薪與外幣不套固定案 TWD 門檻。</p>
    <button className="primary-button" disabled={busy || !draft.categories.length}>儲存篩選設定</button>
  </form>;
}
