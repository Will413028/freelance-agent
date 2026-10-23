"""Bounded, daily public Himalayas searches; listings remain manual-review candidates."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener
from freelance.modules.collection.free_jobs import Text
from freelance.modules.collection.resend_preview import NoRedirect
from freelance.modules.discovery.public import qualify_for_intake

QUERIES = ('AI agent', 'automation', 'backend', 'full stack')


def timestamp(value):
    if type(value) in (int, float):
        return datetime.fromtimestamp(value / 1000 if value > 100000000000 else value, timezone.utc).isoformat()
    if not isinstance(value, str):
        raise ValueError('Invalid timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp timezone required')
    return parsed.isoformat()


def normalize(p):
    title, body, guid = p.get('title'), p.get('description'), p.get('guid')
    if not isinstance(title, str) or not 1 <= len(title) <= 500 or not isinstance(body, str) or not 1 <= len(body) <= 100000:
        raise ValueError('Full listing required')
    if not isinstance(guid, str) or not 1 <= len(guid) <= 2000:
        raise ValueError('Identifier required')
    u = urlsplit(p.get('applicationLink'))
    if u.scheme != 'https' or u.netloc != 'himalayas.app' or not u.path.startswith('/companies/') or '/jobs/' not in u.path:
        raise ValueError('Invalid application URL')
    url = u._replace(query='', fragment='').geturl()
    text = Text(); text.feed(body)
    description = ' '.join(''.join(text.parts).split())
    if not description:
        raise ValueError('Empty description')
    locations, offsets = p.get('locationRestrictions'), p.get('timezoneRestrictions')
    if not isinstance(locations, list) or not isinstance(offsets, list):
        raise ValueError('Location evidence required')
    countries = []
    for location in locations:
        country = location.get('alpha2') or location.get('name') if isinstance(location, dict) else location
        if not isinstance(country, str) or not country.strip():
            raise ValueError('Invalid country')
        countries.append(country.strip().lower())
    try:
        zones = [float(offset) for offset in offsets]
        if any(type(offset) is bool for offset in offsets) or any(not -12 <= zone <= 14 for zone in zones):
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('Invalid timezone evidence') from None
    employment = p.get('employmentType')
    if not isinstance(employment, str):
        raise ValueError('Employment type required')
    kind = 'contract' if employment in ('Contractor', 'Part Time') else 'full_time' if employment == 'Full Time' else None
    received = timestamp(p.get('pubDate'))
    job = dict(source='himalayas', external_id=guid, title=title, description=description,
               url=url, canonical_url=url, kind=kind, employment_types=[employment],
               location_evidence=locations, timezone_evidence=offsets,
               taiwan_eligible=False if countries and not set(countries) & {'tw', 'taiwan', 'taiwan, province of china'} else None,
               timezone_compatible=False if zones and 8 not in zones else None,
               weekly_hours=None, deadline=timestamp(p['expiryDate']) if p.get('expiryDate') is not None else None,
               currency=None, budget_min=None, budget_max=None, language='en', complete=False)
    fingerprint = sha256(json.dumps(job, sort_keys=True).encode()).hexdigest()
    return job | {'received_at':received, 'receipt_id':'himalayas:'+fingerprint}


def fetch():
    jobs = {}
    # 8 fixed searches, one page each; daily caller owns frequency. Never follow feed URLs.
    for query in QUERIES:
        for employment in ('Contractor', 'Part Time'):
            params = urlencode(dict(q=query, employment_type=employment, country='TW', sort='recent', page=1))
            request = Request('https://himalayas.app/jobs/api/search?'+params,
                              headers={'User-Agent':'freelance-agent/0.1 personal-job-discovery', 'Accept':'application/json'})
            with build_opener(NoRedirect()).open(request, timeout=25) as response:
                if response.status != 200:
                    raise ValueError('Feed unavailable')
                raw = response.read(8000001)
            if len(raw) > 8000000:
                raise ValueError('Feed too large')
            page = json.loads(raw).get('jobs')
            if not isinstance(page, list) or len(page) > 20:
                raise ValueError('Invalid feed')
            for job in page:
                jobs[job['guid']] = job
            time.sleep(0.6)
    return list(jobs.values())


def sync(store, *, reader=fetch):
    store.set_source_health('himalayas', 'failed')
    try:
        jobs = [normalize(p) for p in reader()]
        selected = [j for j in jobs if j['kind'] == 'contract' and qualify_for_intake(j)['status'] != 'excluded']
        for job in selected:
            store.ingest(job, receipt_id=job['receipt_id'])
        store.set_source_health('himalayas', 'ok')
        return dict(status='ok', seen=len(jobs), jobs=len(selected), scope='8_searches_first_page_max_160')
    except Exception:
        return dict(status='failed', reason='public_feed_unavailable_or_unsupported')
