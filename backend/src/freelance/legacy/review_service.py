"""Historical proposal operations; not exposed by the discovery HTTP API."""
from hashlib import sha256
import json
from freelance.modules.discovery.rules import evaluate
from freelance.platform.errors import Conflict, InvalidAction
from freelance.modules.discovery.ranking import is_candidate
from freelance.modules.preferences.domain import STAGES

class Legacy:
    def __init__(self, database, records, preferences, settings, discovery):
        self.database, self.records = database, records
        self.preferences, self.settings, self.discovery = preferences, settings, discovery

    def review(self, key, action, version, text='', reason=''):
        with self.database.connect() as conn:
            item = self.records.get(conn, key)
            if item is None:
                raise KeyError(key)
            if isinstance(version, bool) or not isinstance(version, int) or version != item['version']:
                raise Conflict('草稿已更新，請重新載入後確認')
            if action == 'edit':
                if not isinstance(text, str) or not text.strip() or len(text) > 10000:
                    raise InvalidAction('申請稿需為 1–10000 字')
                item.update(proposal=text.strip(), version=version + 1, review_status='draft', approved_hash=None, draft_method='人工編輯')
            elif action == 'approve':
                if not item['proposal'].strip():
                    raise InvalidAction('尚未建立提案，無法核准')
                tracking = self.preferences.state(conn, key)
                if tracking['feedback'] == 'skipped':
                    raise InvalidAction('已略過案件需先恢復未決定或想接，才能核准')
                item['evaluation'] = evaluate(item['job'], self.settings.read(conn)['settings'], self.database.clock())
                if item['evaluation']['status'] != 'qualified' or item['review_status'] == 'skipped':
                    raise InvalidAction('案件仍有未確認條件或已略過，無法核准')
                item.update(review_status='approved', approved_hash=sha256(item['proposal'].encode()).hexdigest())
            elif action == 'skip':
                if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
                    raise InvalidAction('請填寫 1–500 字略過原因')
                item.update(review_status='skipped', skip_reason=reason.strip(), approved_hash=None)
            else:
                raise InvalidAction('不支援的操作；尚未配置投遞 adapter')
            self.records.save(conn, item)
            return item


    def tracking_summary(self):
        with self.database.connect(write=False) as conn:
            items = self.discovery.list_in(conn, self.database.clock())
            sources, reasons = {}, {}
            for item in items:
                stats = sources.setdefault(item['job']['source'], dict(total=0, candidates=0, interested=0,
                                          skipped=0, **{s: 0 for s in STAGES if s != 'not_applied'}))
                stats['total'] += 1
                stats['candidates'] += int(is_candidate(item))
                state = item['tracking']
                stats['interested'] += int(state['feedback'] == 'interested')
                stats['skipped'] += int(state['feedback'] == 'skipped' or item['review_status'] == 'skipped')
                if state['feedback'] == 'skipped':
                    reasons[state['reason']] = reasons.get(state['reason'], 0) + 1
            seen = set()
            source_by_id = {item['id']: item['job']['source'] for item in items}
            for event in self.preferences.events(conn):
                stage = json.loads(event['state'])['stage']
                key = (event['opportunity_id'], stage)
                if stage != 'not_applied' and key not in seen:
                    sources[source_by_id[event['opportunity_id']]][stage] += 1
                    seen.add(key)
            return dict(sources=sources, skip_reasons=reasons, period='all_time',
                        provenance='user_reported', counts='distinct_ever_recorded')
