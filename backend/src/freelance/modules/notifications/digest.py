from html import escape
import json
from urllib.parse import urlsplit
from freelance.modules.discovery.public import is_candidate
from freelance.modules.discovery.public import number
from freelance.modules.discovery.public import group_items

SOURCE_STATUS = {"waiting": "等待符合規則的職缺通知", "not_connected": "尚未接通", "failed": "讀取失敗或不完整", "ok": "讀取成功", "demo": "合成資料"}
CONFLICT_FIELDS = {'title': '職稱', 'company': '公司', 'description': '工作內容', 'kind': '合作型態',
                   'currency': '幣別', 'budget_min': '預算下限', 'budget_max': '預算上限',
                   'weekly_hours': '每週工時', 'location': '地點', 'location_evidence': '地點依據',
                   'taiwan_eligible': '台灣資格', 'timezone_compatible': '時區適用',
                   'deadline': '截止時間', 'listing_closed': '是否結案', 'url': '來源連結'}


def safe_url(url):
    try:
        parsed = urlsplit(url)
        return url if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password else "#"
    except (ValueError, TypeError):
        return "#"


def conflict_details(item):
    blocks = []
    for conflict in item.get('content_conflicts', []):
        fields = conflict['changed_fields']
        versions = []
        for number, version in enumerate(conflict['versions']):
            job = version['job']
            differences = []
            for field in fields:
                value = job.get(field)
                if value is None or value == '':
                    shown = '未提供'
                elif isinstance(value, bool):
                    shown = '是' if value else '否'
                elif field == 'url':
                    shown = safe_url(value)
                else:
                    shown = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
                shown = str(shown)
                shown = shown[:180] + ('…' if len(shown) > 180 else '')
                differences.append(f'{escape(CONFLICT_FIELDS.get(field, field))}：{escape(shown)}')
            label = '現有紀錄' if version['original'] else f'另一份通知內容 {number}'
            url = safe_url(job.get('url'))
            link = f' · <a href="{escape(url, quote=True)}">查看來源</a>' if url != '#' else ''
            versions.append(f'<li><strong>{label} · 版本識別 {escape(version["fingerprint"][:12])}</strong>'
                            f'（條件{escape(version["evaluation"]["status"])}）'
                            + '；'.join(differences) + link + '</li>')
        blocks.append('<section><h3>同職缺通知內容有差異</h3>'
                      '<p>各份內容都保留；轉寄時間無法判斷來源版本的新舊。</p><ul>'
                      + ''.join(versions) + '</ul></section>')
    return ''.join(blocks)


def render(items, sources, *, mode="demo", email=False, counts=None):
    if mode not in ("demo", "postgres", "sqlite"):
        raise ValueError("Unknown review mode")
    notice = ("本機 Demo 預覽 · 尚未寄出 · 合成案件，請勿實際申請" if mode == "demo"
              else "本機案件摘要預覽 · 尚未寄出 · 案件條件仍需人工確認")
    if email:
        if mode == "demo":
            raise ValueError("Demo cannot render a delivery message")
        notice = "案件條件仍需人工確認；本信不代表已投遞。"
    grouped = items if all('members' in item for item in items) else group_items(items)
    candidates = [x for x in grouped if is_candidate(x)]
    blocks = []
    for item in candidates:
        job, evaluation = item["job"], item["evaluation"]
        kind = {'fixed': '固定專案', 'hourly': '時薪', 'contract': '兼職／合約'}.get(job.get('kind'), '合作型態待確認')
        high, low = job.get('budget_max'), job.get('budget_min')
        pay = (f"{job['currency']} {low if number(low) else '?'}–{high}" + ('／時' if job.get('kind') == 'hourly' else '')
               if job.get('currency') and number(high) else '報酬待確認')
        hours = f"{job['weekly_hours']:g} 小時／週" if number(job.get('weekly_hours')) else '工時待確認'
        eligibility = '台灣資格有來源依據' if job.get('taiwan_eligible') is True else '台灣資格待確認'
        location = str(job.get('location_evidence') or job.get('location') or '地點待確認')
        reasons = [evaluation['category']]
        if item.get('tracking', {}).get('feedback') == 'interested':
            reasons.append('已收藏')
        freshness = item.get('recommendation', {}).get('freshness')
        reasons.append({'recent': '近兩日發布', 'week': '近七日發布', 'older': '發布超過七日'}.get(freshness, '發布時間未確認'))
        links = item.get('members') or [dict(source=job['source'], url=job.get('url'))]
        source_links = ' · '.join(f'<a href="{escape(safe_url(member.get("url")), quote=True)}">{escape(member["source"])}</a>' for member in links)
        summary_text = str(job.get('description') or '')
        summary_text = summary_text[:180] + ('…' if len(summary_text) > 180 else '')
        basis = item.get('display_basis')
        basis_note = (f'<p>主卡依 {escape(basis["source"])} 的{escape(basis["label"])}顯示'
                      f'（版本識別 {escape(basis["fingerprint"][:12])}）；'
                      '這不代表它較新或已核實。</p>' if basis else '')
        blocks.append(f'<article class="opportunity"><h2>{escape(job["title"])}</h2>'
                      f'<p>{escape(str(job.get("company") or "公司未提供"))} · {escape(kind)}</p>'
                      f'<p>{escape(pay)} · {escape(hours)}</p><p>{escape(location)} · {escape(eligibility)}</p>'
                      f'<p>{escape(summary_text)}</p><p>匹配理由：{escape("；".join(reasons))}</p>'
                      f'{basis_note}<p>原始職缺：{source_links}</p>{conflict_details(item)}</article>')
    summary = ''
    if counts is not None:
        summary = (f"<p>本次新案／更新 {int(counts.get('unseen_count', len(candidates)))} 件；"
                   f"本信列出 {len(candidates)} 件候選。"
                   f"已寄送或寄送結果待確認的相同版本 {int(counts.get('suppressed_count', 0))} 件不重複列入。</p>")
    statuses = "".join(f"<li>{escape(name)}：{SOURCE_STATUS.get(state, '狀態未知')}</li>" for name, state in sources.items())
    return ('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>接案摘要預覽</title>'
            '<body style="max-width:720px;margin:40px auto;font-family:system-ui;line-height:1.8;padding:24px">'
            f'<h1>今日兼職機會</h1><p>{notice}</p>{summary}'
            + ("".join(blocks) or "<p>目前沒有可列出的候選；請同時檢查來源狀態。</p>")
            + f"<h2>來源狀態</h2><ul>{statuses}</ul></body></html>")
