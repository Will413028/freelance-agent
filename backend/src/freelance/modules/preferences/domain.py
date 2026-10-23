"""Manual feedback/outcomes, independent of proposal authorization and delivery."""
from freelance.platform.errors import Conflict, InvalidAction

FEEDBACK = ('neutral', 'interested', 'skipped')
REASONS = ('budget', 'skills', 'hours', 'location', 'scope', 'other')
STAGES = ('not_applied', 'applied', 'replied', 'negotiating', 'won', 'lost', 'withdrawn')
TRANSITIONS = {
    'not_applied': ('applied',),
    'applied': ('replied', 'negotiating', 'won', 'lost', 'withdrawn'),
    'replied': ('negotiating', 'won', 'lost', 'withdrawn'),
    'negotiating': ('won', 'lost', 'withdrawn'),
    'won': (), 'lost': (), 'withdrawn': (),
}


def empty_tracking():
    return dict(revision=0, feedback='neutral', stage='not_applied', reason='',
                note='', evidence='', updated_at=None, provenance='user_reported')


def update_tracking(current, revision, now, *, feedback=None, stage=None, reason='', note='', evidence=''):
    if isinstance(revision, bool) or not isinstance(revision, int) or revision != current['revision']:
        raise Conflict('追蹤紀錄已更新，請重新載入')
    for value, limit in ((note, 2000), (evidence, 2000), (reason, 50)):
        if not isinstance(value, str) or len(value) > limit:
            raise InvalidAction('追蹤欄位格式或長度不符限制')
    note, evidence, reason = note.strip(), evidence.strip(), reason.strip()
    if feedback is None and stage is None:
        raise InvalidAction('請選擇回饋或應徵進度')
    result = dict(current)
    if feedback is not None:
        if feedback not in FEEDBACK:
            raise InvalidAction('不支援的回饋')
        if feedback == 'skipped' and reason and (reason not in REASONS or (reason == 'other' and not note)):
            raise InvalidAction('請選擇略過原因；其他原因需填寫說明')
        result.update(feedback=feedback, reason=reason if feedback == 'skipped' else '')
    if stage is not None:
        if stage not in STAGES:
            raise InvalidAction('不支援的應徵進度')
        if stage == 'not_applied' and current['stage'] != 'not_applied':
            if not note:
                raise InvalidAction('重設進度需填寫更正原因，歷史紀錄會保留')
            result['evidence'] = ''
        elif stage != current['stage']:
            if stage not in TRANSITIONS[current['stage']]:
                raise InvalidAction('請先記錄已投遞；此進度轉換不被允許')
        if stage == 'applied' and current['stage'] == 'not_applied' and not evidence:
            raise InvalidAction('已投遞需填寫平台確認編號或送出紀錄；不會代為投遞')
        result['stage'] = stage
    if evidence and stage != 'not_applied':
        result['evidence'] = evidence
    result.update(note=note, revision=revision + 1, updated_at=now.isoformat())
    return result
