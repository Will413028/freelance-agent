"""Official public Get on Board API; paginated remote discovery, never applications."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import re
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.public_feeds import NoRedirect, text
from freelance.modules.collection.ptt_soho import read_body

ROOT = 'https://www.getonbrd.com/api/v0/'
TECH = {'Programming', 'Machine Learning & AI', 'Mobile Development', 'Data Science / Analytics', 'SysAdmin / DevOps / QA'}


def normalize(item, modalities):
    identity, attrs = item.get('id'), item.get('attributes')
    if not isinstance(identity, str) or not re.fullmatch(r'[a-z0-9_-]{1,250}', identity) or not isinstance(attrs, dict):
        raise ValueError('Invalid job identity')
    parsed = urlsplit(item.get('links', {}).get('public_url', ''))
    if parsed.scheme != 'https' or parsed.netloc != 'www.getonbrd.com' or parsed.path != '/jobs/' + identity:
        raise ValueError('Invalid canonical job URL')
    url = parsed._replace(query='', fragment='').geturl()
    title = text(attrs.get('title'))
    body = text(attrs.get('description'))
    for field in ('projects', 'functions', 'desirable', 'benefits'):
        if attrs.get(field): body += '\n' + text(attrs[field])
    if len(title) > 500 or len(body) > 100_000:
        raise ValueError('Oversize listing')
    stamp = attrs.get('published_at')
    if type(stamp) is not int or stamp <= 0: raise ValueError('Invalid publication')
    published = datetime.fromtimestamp(stamp, timezone.utc).isoformat()
    modality = modalities.get(str(attrs.get('modality', {}).get('data', {}).get('id')))
    if modality is None: raise ValueError('Unknown modality')
    kind = 'full_time' if modality == 'full_time' else 'contract' if modality in ('part_time', 'freelance') else None
    countries = attrs.get('countries')
    if not isinstance(countries, list) or any(not isinstance(value, str) for value in countries):
        raise ValueError('Invalid countries')
    # A platform's worldwide flag is not evidence of payroll/work eligibility.
    # Explicit regional requirements in the title still exclude Taiwan.
    excluded = bool(re.search(r'\b(?:LATAM|Latin America|US[- ]only|EU[- ]only)\b', title, re.I))
    job = dict(source='getonboard', external_id=identity, title=title, description=body,
               canonical_url=url, url=url, attribution='Get on Board', kind=kind,
               published_at=published, received_at=published, employment_evidence=modality,
               remote_evidence=attrs.get('remote') is True, remote_modality=attrs.get('remote_modality'),
               location_evidence=countries, category_evidence=attrs.get('category_name'),
               weekly_hours=None, taiwan_eligible=False if excluded else None,
               timezone_compatible=None, deadline=None, currency=None, budget_min=None, budget_max=None,
               salary_evidence={'min': attrs.get('min_salary'), 'max': attrs.get('max_salary'), 'period': None},
               language=attrs.get('lang'), complete=False, body_available=True)
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': 'getonboard:' + identity + ':' + fingerprint}


def fetch():
    deadline = time.monotonic() + 90
    def get(path, params):
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Source deadline')
        request = Request(ROOT + path + '?' + urlencode(params), headers={
            'User-Agent': 'freelance-agent/0.1', 'Accept': 'application/json'})
        with build_opener(NoRedirect()).open(request, timeout=min(15, remaining)) as response:
            if response.status != 200: raise ValueError('API unavailable')
            data = json.loads(read_body(response, deadline))
        if not isinstance(data, dict) or not isinstance(data.get('data'), list) or len(data['data']) > 120:
            raise ValueError('Invalid API envelope')
        return data
    taxonomy = get('modalities', {'per_page': 120, 'page': 1})
    if taxonomy.get('meta', {}).get('total_pages') != 1: raise ValueError('Incomplete modality taxonomy')
    modalities = {str(item['id']): item['attributes']['locale_key'] for item in taxonomy['data']}
    jobs, seen, rejected, total_pages = {}, 0, 0, 1
    for page in range(1, 11):
        time.sleep(0.6)
        data = get('search/jobs', {'remote': 'true', 'per_page': 120, 'page': page})
        meta = data.get('meta', {})
        total_pages = meta.get('total_pages')
        if meta.get('page') != page or type(total_pages) is not int or total_pages < 0:
            raise ValueError('Invalid pagination')
        seen += len(data['data'])
        for entry in data['data']:
            try:
                job = normalize(entry, modalities)
                jobs[job['external_id']] = job
            except (ValueError, TypeError, AttributeError, OverflowError):
                rejected += 1
        if page >= total_pages: break
    return {'jobs': list(jobs.values()), 'seen': seen, 'rejected_count': rejected,
            'pages': page, 'truncated': page < total_pages}


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('getonboard', 'failed')
        result = reader(); selected = 0; now = store.clock()
        with store.source_batch('getonboard') as batch:
            old = batch.existing_ids()
            for job in result['jobs']:
                fresh = now - timedelta(days=90) <= datetime.fromisoformat(job['published_at']) <= now
                if job['external_id'] in old or (fresh and job['remote_evidence'] and job['kind'] == 'contract' and
                    job['category_evidence'] in TECH and qualify_for_intake(job, now=now)['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id']); selected += 1
            partial = bool(result['rejected_count'] or result['truncated'])
            batch.finish('failed' if partial else 'ok')
        return {key: value for key, value in result.items() if key != 'jobs'} | {
            'status': 'partial' if partial else 'ok', 'jobs': selected,
            'scope': 'public_remote_search_max_10_pages_120_each_90_days'}
    except Exception:
        return {'status': 'failed', 'reason': 'getonboard_unavailable_or_unsupported'}
