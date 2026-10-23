"""Revision-safe background drafting. Generation never runs inside a DB lock."""
from copy import deepcopy
from datetime import datetime, timezone
from time import monotonic
from zoneinfo import ZoneInfo

from freelance.legacy.proposals import draft

from freelance.modules.discovery.ranking import is_candidate

_TEMPLATE_METHOD = '範本草稿（尚未連接 LLM）'


def _eligible(item):
    return (is_candidate(item) and item['review_status'] == 'draft'
            and item.get('draft_method') == _TEMPLATE_METHOD
            and item['proposal'] == draft(item['job'], item['evaluation']))


def _priority(item):
    if not _eligible(item):
        return None
    job = item['job']
    if job.get('body_available') is False:
        return None
    if item.get('tracking', {}).get('feedback') == 'interested':
        return 'interested' if job.get('description', '').strip() else None
    if (item['evaluation']['status'] == 'qualified'
            and item['recommendation']['completeness'] >= 67
            and item['recommendation']['freshness'] in ('recent', 'week')
            and len(job.get('description', '').strip()) >= 80):
        return 'prewrite'
    return None


def draft_state(item, attempt=None):
    if item.get('draft_method') != _TEMPLATE_METHOD:
        return 'ready_for_review'
    if attempt is not None:
        return attempt['status']
    return 'pending' if _priority(item) else 'needs_info'


def _claim(store, recipient, now, attempted_ids, prewrite_per_day):
    local_date = now.astimezone(ZoneInfo('Asia/Taipei')).date().isoformat()
    with store._connect() as conn:
        prewrites = conn.execute("SELECT count(*) AS n FROM ai_draft_attempts WHERE local_date=? AND priority='prewrite'",
                                 (local_date,)).fetchone()['n']
        candidates = store._list(conn, now)
        candidates.sort(key=lambda item: (item.get('tracking', {}).get('feedback') != 'interested',
                                          -item['recommendation']['score'], item['id']))
        for item in candidates:
            priority = _priority(item)
            if item['id'] in attempted_ids or priority is None:
                continue
            legacy = conn.execute("SELECT status FROM ai_draft_attempts WHERE opportunity_id=? AND fingerprint=? AND priority='legacy'",
                                  (item['id'], item['fingerprint'])).fetchone()
            if legacy is not None and priority != 'interested':
                continue
            if priority == 'prewrite' and prewrites >= prewrite_per_day:
                continue
            claimed = conn.execute('''INSERT INTO ai_draft_attempts
                (opportunity_id,fingerprint,version,local_date,recipient,status,attempted_at,priority)
                VALUES (?,?,?,?,?,'attempted',?,?) ON CONFLICT DO NOTHING''',
                (item['id'], item['fingerprint'], item['version'], local_date, recipient,
                 now.isoformat(), priority))
            if claimed.rowcount:
                return item, priority
    return None


def _valid(result):
    return (isinstance(result, dict) and result.get('status') == 'draft'
            and result.get('requires_review') is True
            and isinstance(result.get('proposal'), str) and 0 < len(result['proposal'].strip()) <= 10000
            and isinstance(result.get('questions'), list) and len(result['questions']) <= 30
            and all(isinstance(x, str) and 0 < len(x.strip()) <= 1000 for x in result['questions'])
            and isinstance(result.get('method'), str) and 0 < len(result['method'].strip()) <= 200
            and result['method'] != _TEMPLATE_METHOD)


def _finish(store, item, priority, result):
    with store._connect() as conn:
        now = store.clock()
        current = next((x for x in store._list(conn, now) if x['id'] == item['id']), None)
        if result is None:
            status, reason = 'failed', 'generation_failed'
        elif (current is None or current['version'] != item['version']
              or current['fingerprint'] != item['fingerprint'] or not _eligible(current)
              or current.get('tracking') != item.get('tracking')
              or _priority(current) is None):
            status, reason = 'stale', 'opportunity_changed'
        else:
            current.update(proposal=result['proposal'].strip(), ai_questions=list(result['questions']),
                           requires_review=True, draft_method=result['method'].strip(),
                           version=current['version'] + 1, approved_hash=None, review_status='draft')
            # Tracking and recommendation are derived independently by the store.
            current.pop('tracking', None)
            current.pop('recommendation', None)
            store._save(conn, current)
            status, reason = 'succeeded', None
        conn.execute('''UPDATE ai_draft_attempts SET status=?,reason=?,finished_at=?
                        WHERE opportunity_id=? AND fingerprint=? AND priority=? AND status='attempted' ''',
                     (status, reason, now.isoformat(), item['id'], item['fingerprint'], priority))
        return status


def run(store, recipient, generate, now=None, limit=5, prewrite_per_day=2, max_seconds=240):
    """Process a bounded batch; interested work has no daily quota.

    Only unsolicited prewrites share a Taipei-day ceiling. A claim is unique
    for the source fingerprint and priority, including errors or process interruption.
    The callable accepts a copied normalized job and returns a validated draft.
    Return counts only; never expose proposal payloads or provider exceptions.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= 20:
        raise ValueError('AI batch limit must be an integer from 0 to 20')
    if isinstance(prewrite_per_day, bool) or not isinstance(prewrite_per_day, int) or not 0 <= prewrite_per_day <= 20:
        raise ValueError('Prewrite daily limit must be an integer from 0 to 20')
    if isinstance(max_seconds, bool) or not isinstance(max_seconds, int) or not 1 <= max_seconds <= 540:
        raise ValueError('AI worker time budget must be an integer from 1 to 540 seconds')
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('AI drafting requires timezone-aware time')
    counts = dict(attempted=0, succeeded=0, failed=0, stale=0)
    attempted_ids = set()
    deadline = monotonic() + max_seconds
    while counts['attempted'] < limit and monotonic() < deadline:
        claim = _claim(store, recipient, store.clock(), attempted_ids, prewrite_per_day)
        if claim is None:
            break
        item, priority = claim
        attempted_ids.add(item['id'])
        counts['attempted'] += 1
        try:
            result = generate(deepcopy(item['job']))
            if not _valid(result):
                result = None
        except Exception:
            result = None
        status = _finish(store, item, priority, result)
        counts[status] += 1
        if status == 'failed':
            break
    return counts
