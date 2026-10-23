import type { Item, Feedback } from '../../shared/api/client';
import { kinds, compensation, fieldNames, fieldValue, safeUrl } from './format';

export function JobDetail({ active, busy, name, onFeedback }: {
  active?: Item; busy: boolean; name: (key: string) => string;
  onFeedback: (value: Feedback['feedback']) => Promise<void>;
}) {
  return <section className="detail" aria-label="職缺詳情">{active ? <>
          <p className="eyebrow">OPPORTUNITY</p><h2>{active.job.title}</h2>
          <p>{active.job.company || "公司未提供"} · {kinds[active.job.kind || ""] || "合作型態待確認"}</p>
          <p>{active.application_ids?.length ? <a className="outline-button" href="/applications">已記錄投案 · 查看紀錄</a>
            : <a className="outline-button" href={'/applications/new?opportunity=' + encodeURIComponent(active.id)}>記錄已投案</a>}</p>
          <p><a className="outline-button" href={'/proposals?opportunity='+encodeURIComponent(active.id)}>準備提案草稿</a></p>
          {active.display_basis && <p className="hint">主卡依 {name(active.display_basis.source)} 的{active.display_basis.label}顯示（版本識別 {active.display_basis.fingerprint.slice(0, 12)}）；這不代表它較新或已核實。</p>}
          <div className="actions discovery-actions"><button className="primary-button" disabled={busy} onClick={() => void onFeedback(active.tracking.feedback === "interested" ? "neutral" : "interested")}>{active.tracking.feedback === "interested" ? "取消收藏" : "收藏職缺"}</button>
            <button className="outline-button" disabled={busy} onClick={() => void onFeedback(active.tracking.feedback === "skipped" || active.review_status === "skipped" ? "neutral" : "skipped")}>{active.tracking.feedback === "skipped" || active.review_status === "skipped" ? "恢復待看" : "略過"}</button></div>
          <dl className="job-facts"><div><dt>報酬</dt><dd>{compensation(active.job)}</dd></div><div><dt>每週工時</dt><dd>{active.job.weekly_hours ? active.job.weekly_hours + " 小時" : "待確認"}</dd></div>
            <div><dt>地點</dt><dd>{active.job.location_evidence ? fieldValue(active.job, "location_evidence") : active.job.location || "待確認"}</dd></div><div><dt>台灣資格</dt><dd>{active.job.taiwan_eligible === true ? "有來源依據" : active.job.taiwan_eligible === false ? "不符合" : "待確認"}</dd></div></dl>
          <h3>匹配理由</h3><p>{active.evaluation.category}</p>
          {active.evaluation.reasons.length > 0 && <ul className="reasons">{active.evaluation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <h3>工作內容</h3><p className="detail-desc">{active.job.description}</p>
          {!!active.content_conflicts?.length && <section className="content-conflicts" aria-label="通知內容差異">
            <h3>同職缺通知內容有差異</h3><p className="hint">各份內容都保留；轉寄時間無法判斷來源版本的新舊。請對照原始職缺確認。</p>
            {active.content_conflicts.map(conflict => <div key={conflict.source + ":" + conflict.external_id}>
              <p className="conflict-fields">差異欄位：{conflict.changed_fields.map(field => fieldNames[field] || field).join("、")}</p>
              <div className="content-versions">{conflict.versions.map((version, index) => <article key={version.fingerprint}>
                <h4>{version.original ? "現有紀錄" : `另一份通知內容 ${index}`} · 版本識別 {version.fingerprint.slice(0, 12)}</h4>
                <p>條件{version.evaluation.status === "excluded" ? "不符" : version.evaluation.status === "qualified" ? "吻合" : "待確認"}</p>
                <dl>{conflict.changed_fields.map(field => <div key={field}><dt>{fieldNames[field] || field}</dt>
                  <dd>{field === "url" && safeUrl(version.job.url) ? <a href={safeUrl(version.job.url)} target="_blank" rel="noreferrer">{version.job.url}</a> : fieldValue(version.job, field)}</dd></div>)}</dl>
                {safeUrl(version.job.url) && <a href={safeUrl(version.job.url)} target="_blank" rel="noreferrer">查看這份內容的來源 ↗</a>}
              </article>)}</div>
            </div>)}
          </section>}
          <h3>原始職缺</h3><ul className="source-links">{active.members.map(member => <li key={member.id}>{safeUrl(member.url) ? <a href={safeUrl(member.url)} target="_blank" rel="noreferrer">{name(member.source)} ↗</a> : name(member.source)}</li>)}</ul>
          {active.members.length > 1 && <p className="hint">依相同連結或相同公司、職稱及完整內容分組，各平台紀錄均保留。</p>}
          {!!active.evaluation.questions.length && <details className="unknowns"><summary>待確認資訊</summary><ul className="questions">{active.evaluation.questions.map(question => <li key={question}>{question}</li>)}</ul></details>}
        </> : <p className="empty">選取職缺查看工作內容。</p>}</section>;
}
