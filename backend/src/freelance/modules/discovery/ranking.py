"""Explainable prioritization; never changes qualification or invents evidence."""
from datetime import datetime, timezone
from freelance.modules.discovery.domain import number


def is_candidate(item):
    tracking = item.get('tracking', {})
    possible = item['evaluation']['status'] != 'excluded' or any(
        version['evaluation']['status'] != 'excluded'
        for conflict in item.get('content_conflicts', []) for version in conflict['versions'])
    return (possible
            and not item.get('application_ids')
            and item['review_status'] not in ('skipped', 'sent', 'delivered')
            and tracking.get('feedback') != 'skipped'
            and tracking.get('stage', 'not_applied') == 'not_applied')


def _recommendation_single(item, now):
    job, evaluation = item['job'], item['evaluation']
    score = evaluation['score'] * .7
    reasons = [f"專長匹配：{evaluation['category']}"]
    confirmed = [job.get('taiwan_eligible') is True, job.get('timezone_compatible') is True,
                 number(job.get('weekly_hours')) and job['weekly_hours'] > 0 and
                 (evaluation['available_hours'] is None or job['weekly_hours'] <= evaluation['available_hours']),
                 job.get('complete') is True]
    score += sum(confirmed) * 2.5
    if item.get('tracking', {}).get('feedback') == 'interested':
        score += 10
        reasons.append('你已標記想接')
    freshness = 'unknown'
    # Known parser contracts use received_at for publication; Tasker never does.
    try:
        value = job.get('published_at')
        if value is None and job.get('source') in ('himalayas', 'hackernews', 'v2ex'):
            value = job.get('received_at')
        if value is None and job.get('source') in ('jobicy', 'remotive'):
            value = job.get('publication_evidence')
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            published = datetime.fromtimestamp(value, tz=timezone.utc)
        else:
            published = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if published.tzinfo is None:
            if job.get('source') in ('jobicy', 'remotive') and not job.get('published_at'):
                published = published.replace(tzinfo=timezone.utc)  # Same explicit convention as free_jobs.normalize.
            else:
                raise ValueError('Publication timezone unknown')
        age = (now - published).total_seconds() / 86400
        if 0 <= age <= 2:
            score += 10; freshness = 'recent'; reasons.append('近兩日發布')
        elif 2 < age <= 7:
            score += 6; freshness = 'week'; reasons.append('近七日發布')
        elif age > 7:
            freshness = 'older'; reasons.append('發布超過七日')
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        pass
    if freshness == 'unknown':
        reasons.append('發布時間未確認，不以收信時間代替')
    # Completeness is documented fields, not truth confidence or a win probability.
    low, high = job.get('budget_min'), job.get('budget_max')
    budget = (job.get('kind') == 'fixed' and job.get('currency') == 'TWD'
              and number(low) and number(high) and 3000 <= low <= high)
    fields = confirmed + [budget, bool(job.get('deadline')) and not any('截止' in q for q in evaluation['questions'])]
    completeness = round(sum(fields) / len(fields) * 100)
    reasons.append(f'資訊完整度 {completeness}%（非資格保證）')
    if evaluation['status'] == 'excluded':
        reasons.append('硬條件不符，仍不推薦')
    return dict(score=round(min(100, score), 1), completeness=completeness,
                freshness=freshness, reasons=reasons, method='規則排序，非成交機率')


def recommendation(item, now):
    options = [item]
    for conflict in item.get('content_conflicts', []):
        for version in conflict['versions']:
            if version['fingerprint'] != item['fingerprint']:
                options.append(item | dict(job=version['job'], evaluation=version['evaluation'],
                                           fingerprint=version['fingerprint'], content_conflicts=[]))
    possible = [option for option in options if option['evaluation']['status'] != 'excluded']
    scored = [(_recommendation_single(option, now), option) for option in (possible or options[:1])]
    result, basis = max(scored, key=lambda entry: entry[0]['score'])
    result['basis_fingerprint'] = basis['fingerprint']
    if item.get('content_conflicts'):
        result['reasons'].append('通知內容有差異；依可能符合的一份排序，需核對原文')
    return result


def rank_items(items, now):
    for item in items:
        item['recommendation'] = recommendation(item, now)
    return sorted(items, key=lambda x: (not is_candidate(x), -x['recommendation']['score'], x['id']))
