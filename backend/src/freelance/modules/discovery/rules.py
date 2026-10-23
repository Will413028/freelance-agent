"""Discovery preferences and reversible grouping of source observations."""
from copy import deepcopy
from hashlib import sha256
import json
import unicodedata
from urllib.parse import urlsplit

from freelance.modules.discovery.domain import qualify, number, DEFAULT_HOURS
from freelance.modules.discovery.ranking import is_candidate

CATEGORIES = ('AI agent', 'AI 整合／自動化', '後端／API', '全端 MVP')
DEFAULTS = dict(max_weekly_hours=DEFAULT_HOURS, min_fixed_twd=3000, categories=list(CATEGORIES))
PUBLIC_JOB_FIELDS = frozenset(('source', 'external_id', 'title', 'company', 'description',
    'url', 'canonical_url', 'kind', 'currency', 'budget_min', 'budget_max', 'weekly_hours',
    'taiwan_eligible', 'timezone_compatible', 'deadline', 'listing_closed', 'location',
    'location_evidence', 'published_at', 'publication_evidence', 'complete', 'body_available',
    'observed_amount', 'compensation_evidence', 'language', 'remote_scope'))


def public_job(job):
    return {key: deepcopy(value) for key, value in job.items() if key in PUBLIC_JOB_FIELDS}


def preferences(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise ValueError('篩選設定欄位不符')
    hours, budget, categories = value['max_weekly_hours'], value['min_fixed_twd'], value['categories']
    if hours is not None and (not number(hours) or not 1 <= hours <= 168):
        raise ValueError('工時上限需為 1–168 小時，或不限')
    if not number(budget) or not 0 <= budget <= 10000000:
        raise ValueError('最低固定案預算不符範圍')
    if (not isinstance(categories, list) or not categories
            or any(not isinstance(category, str) or category not in CATEGORIES for category in categories)
            or len(set(categories)) != len(categories)):
        raise ValueError('請至少選擇一種專長分類')
    return deepcopy(value)


def evaluate(job, settings, now):
    result = qualify(job, available_hours=settings['max_weekly_hours'],
                     minimum_budget=settings['min_fixed_twd'], now=now)
    if result['category'] not in settings['categories'] and result['status'] != 'excluded':
        result['reasons'].append('不在目前選擇的專長分類')
        result['status'] = 'excluded'
    return result


def project(item, settings, now):
    result = deepcopy(item)
    result['evaluation'] = evaluate(result['job'], settings, now)
    if result['evaluation']['status'] != 'qualified' and result['review_status'] == 'approved':
        result.update(review_status='draft', approved_hash=None)
    return result


def text(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).casefold().split())


def _hash(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def identity_keys(job):
    keys = set()
    url = job.get('canonical_url') or job.get('url')
    try:
        parsed = urlsplit(url)
        if parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password:
            # Query parameters may identify a job; only the fragment is cosmetic.
            keys.add('url:' + parsed._replace(fragment='').geturl())
    except (ValueError, TypeError, AttributeError):
        pass
    company, title, body = text(job.get('company')), text(job.get('title')), text(job.get('description'))
    if company and title and len(body) >= 80 and job.get('body_available') is not False:
        keys.add('content:' + _hash([company, title, body, job.get('kind'),
                                    text(job.get('location_evidence') or job.get('location'))]))
    return keys


def novelty(item):
    if 'novelty_keys' in item:
        return {tuple(key) for key in item['novelty_keys']}
    job = item['job']
    content = {key: job.get(key) for key in ('title', 'description', 'company', 'kind', 'currency',
               'budget_min', 'budget_max', 'weekly_hours', 'taiwan_eligible', 'timezone_compatible',
               'deadline', 'listing_closed', 'compensation_evidence')}
    fingerprint = _hash(content)
    observed = {(item['id'], item['fingerprint'])}
    for conflict in item.get('content_conflicts', []):
        observed.update((item['id'], version['fingerprint']) for version in conflict['versions'])
    return {(key, fingerprint) for key in identity_keys(job)} | observed


def group_items(items):
    """Keep every source row; group presentation and feedback with revision tokens."""
    parents = list(range(len(items)))
    grouped_indices = {index: [index] for index in parents}

    def compatible(left, right):
        # Conflicting known conditions remain separate cards for human inspection.
        for field in ('title', 'company', 'kind', 'currency', 'budget_min', 'budget_max',
                      'weekly_hours', 'taiwan_eligible', 'timezone_compatible', 'listing_closed'):
            a, b = left.get(field), right.get(field)
            if a is not None and b is not None and a != '' and b != '' and text(a) != text(b):
                return False
        return True

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    keys = {}
    for index, item in enumerate(items):
        for key in identity_keys(item['job']):
            for prior in keys.get(key, []):
                left, right = root(index), root(prior)
                if left != right and all(compatible(items[a]['job'], items[b]['job'])
                        for a in grouped_indices[left] for b in grouped_indices[right]):
                    parents[left] = right
                    grouped_indices[right].extend(grouped_indices.pop(left))
            keys.setdefault(key, []).append(index)
    buckets = {}
    for index, item in enumerate(items):
        buckets.setdefault(root(index), []).append(item)
    result = []
    for members in buckets.values():
        representative = next((item for item in members if is_candidate(item)), members[0])
        grouped = deepcopy(representative)
        grouped['members'] = [dict(id=item['id'], source=item['job']['source'],
                                   url=item['job'].get('url'), fingerprint=item['fingerprint'],
                                   observation_fingerprints=sorted({item['fingerprint']} | {
                                       version['fingerprint'] for conflict in item.get('content_conflicts', [])
                                       for version in conflict['versions']}),
                                   token=item['fingerprint'] + ':' + str(item.get('tracking', {}).get('revision', 0))
                                   + (':' + _hash(sorted(version['fingerprint']
                                       for conflict in item.get('content_conflicts', [])
                                       for version in conflict['versions'])) if item.get('content_conflicts') else '')
                                   + (':applications:' + _hash(item['application_token']) if item.get('application_token') else ''),
                                   revision=item.get('tracking', {}).get('revision', 0)) for item in members]
        grouped['member_ids'] = [item['id'] for item in members]
        grouped['application_ids'] = sorted({key for item in members for key in item.get('application_ids',[])})
        grouped['novelty_keys'] = sorted(set().union(*(novelty(item) for item in members)))
        grouped['content_conflicts'] = [conflict for item in members
                                         for conflict in item.get('content_conflicts', [])]
        if grouped['content_conflicts']:
            basis = grouped['recommendation']['basis_fingerprint']
            chosen = next((version for conflict in grouped['content_conflicts']
                           for version in conflict['versions'] if version['fingerprint'] == basis), None)
            if chosen and not chosen['original']:
                grouped['job'] = deepcopy(chosen['job'])
                grouped['evaluation'] = deepcopy(chosen['evaluation'])
            grouped['display_basis'] = dict(source=grouped['job']['source'], fingerprint=basis,
                                            label='另一份通知內容' if chosen and not chosen['original'] else '現有紀錄')
        states = [item.get('tracking', {}).get('feedback', 'neutral') for item in members]
        feedback = 'skipped' if 'skipped' in states else 'interested' if 'interested' in states else 'neutral'
        grouped.setdefault('tracking', {})['feedback'] = feedback
        if any(item.get('review_status') == 'skipped' for item in members):
            grouped['review_status'] = 'skipped'
        if any(item.get('tracking', {}).get('stage', 'not_applied') != 'not_applied' for item in members):
            grouped['tracking']['stage'] = next(item['tracking']['stage'] for item in members
                                               if item.get('tracking', {}).get('stage', 'not_applied') != 'not_applied')
        result.append(grouped)
    return sorted(result, key=lambda item: (not is_candidate(item),
                  -item.get('recommendation', {}).get('score', item['evaluation']['score']), item['id']))


def unseen(item, seen):
    known_ids = {identity for identity, _ in seen}
    changed = any(member['id'] in known_ids and any((member['id'], fingerprint) not in seen
                  for fingerprint in member.get('observation_fingerprints', [member['fingerprint']]))
                  for member in item.get('members', [item]))
    return changed or not novelty(item).intersection(seen)


def public_item(item):
    """The discovery API does not expose proposal or CRM payloads."""
    result = {key: item[key] for key in ('id', 'job', 'evaluation', 'recommendation',
                                        'review_status', 'members', 'member_ids', 'content_conflicts',
                                        'display_basis') if key in item}
    result['job'] = public_job(item['job'])
    result['content_conflicts'] = [dict(conflict,
        versions=[dict(version, job=public_job(version['job'])) for version in conflict['versions']])
        for conflict in item.get('content_conflicts', [])]
    result['tracking'] = {key: item.get('tracking', {}).get(key) for key in ('feedback', 'stage', 'revision')}
    result['candidate'] = is_candidate(item)
    if item.get('application_ids'):
        result['application_ids'] = item['application_ids']
    return result
