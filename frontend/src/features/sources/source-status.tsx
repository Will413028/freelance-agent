import type { Dashboard } from '../../shared/api/client';

const labels: Record<string, string> = { ok: '最近讀取成功', failed: '讀取失敗或不完整', waiting: '等待職缺通知', not_connected: '尚未接通' };
const reasons = { invalid_data: '有資料拒收或通知隔離', incomplete_scan: '讀取尚未完整', source_error: '來源讀取或處理失敗', waiting_for_notification: '尚未收到有效職缺通知' };

function checkedAt(value: string | null) {
  if (!value) return '尚無檢查紀錄';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? '檢查時間未知' : new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date) + ' 台灣時間';
}

export function SourceStatus({ sources, operations, name }: { sources: Record<string, string>; operations?: Dashboard['operations']; name: (key: string) => string }) {
  return <details className="source-summary"><summary>來源狀態</summary><p className="hint">讀取成功代表最近一次已配置範圍的結果；尚未接通或讀取不完整的來源不等於沒有職缺。</p>
    <div className="source-grid">{Object.entries(sources).map(([key, state]) => {
      const check = operations?.sources[key];
      const daily = check?.latest_daily;
      return <div className="source source-observation" key={key}><span>{name(key)}</span>
        <small>{labels[check?.status || state] || '狀態未知'}</small>
        <small>{checkedAt(check?.checked_at ?? null)}</small>
        {daily && <div><small>{daily.local_date} 每日收案：{daily.status === 'partial' ? '部分資料取得' : labels[daily.status] || '結果未知'}</small>
          {daily.reason && <small>{reasons[daily.reason]}</small>}
          <small>{daily.seen !== null ? `讀取 ${daily.seen} 筆` : daily.messages !== null ? `職缺通知 ${daily.messages} 封` : '讀取數量未知'}
            {daily.jobs !== null && ` · 初篩 ${daily.jobs} 筆`}
            {daily.rejected_count !== null && ` · 拒收 ${daily.rejected_count} 筆`}
            {daily.quarantined !== null && ` · 隔離 ${daily.quarantined} 封`}</small>
          {(daily.truncated || daily.limited) && <small>本次讀取未完整</small>}
          {daily.complete_scan === false && <small>有限範圍，不代表全站</small>}
        </div>}
      </div>;
    })}</div></details>;
}
