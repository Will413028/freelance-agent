"""Bounded read of Arbeitnow's official free job-board API; discovery only."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import re
import time
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, build_opener

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.public_feeds import NoRedirect, text

ENDPOINT = 'https://www.arbeitnow.com/api/job-board-api'
MAX_BYTES = 8_000_000
MAX_PAGE_ENTRIES = 10_000  # Resource bound, not the provider's page-size contract.
PROMOTIONAL_FOOTERS = (
    '<p>Find more <a href="https://www.arbeitnow.com/english-speaking-jobs">English Speaking Jobs in Germany</a> on Arbeitnow</a>',
    '<p>Find <a href="https://www.arbeitnow.com">Jobs in Germany</a> on Arbeitnow</a>',
)


def description_text(value):
    # These exact terminal fragments were observed varying on identical jobs.
    # Keep all other content; attribution and the canonical link remain separate.
    if isinstance(value, str):
        value = value.rstrip()
        for footer in PROMOTIONAL_FOOTERS:
            if value.endswith(footer):
                value = value[:-len(footer)]
                break
    return text(value)


def fetch(url=ENDPOINT, *, timeout=25):
    request = Request(url, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery',
                                         'Accept': 'application/json'}, method='GET')
    with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError('Arbeitnow unavailable')
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('Arbeitnow response too large')
    return raw


def normalize(entry):
    if not isinstance(entry, dict):
        raise ValueError('Invalid listing')
    slug, url = entry.get('slug'), entry.get('url')
    if not isinstance(slug, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', slug):
        raise ValueError('Invalid slug')
    parsed = urlsplit(url) if isinstance(url, str) else None
    if (parsed is None or parsed.scheme != 'https' or
            parsed.netloc not in ('www.arbeitnow.com', 'www.arbeitnow.co.uk', 'www.arbeitnow.fr', 'www.arbeitnow.ch') or
            not parsed.path.startswith('/jobs/companies/') or parsed.path.rstrip('/').split('/')[-1] != slug):
        raise ValueError('Invalid canonical URL')
    canonical = parsed._replace(query='', fragment='').geturl()
    stamp = entry.get('created_at')
    if type(stamp) is not int or stamp <= 0:
        raise ValueError('Invalid publication time')
    published = datetime.fromtimestamp(stamp, timezone.utc)
    types = entry.get('job_types')
    if not isinstance(types, list) or any(not isinstance(item, str) for item in types):
        raise ValueError('Invalid job types')
    normalized_types = {item.strip().lower().replace('-', ' ') for item in types}
    kind = ('full_time' if any('fulltime' in item or 'full time' in item for item in normalized_types)
            else 'contract' if normalized_types & {'part time', 'parttime', 'freelance', 'contract'} else None)
    location = entry.get('location')
    if location is not None and not isinstance(location, str):
        raise ValueError('Invalid location')
    title, description = text(entry.get('title')), description_text(entry.get('description'))
    if len(title) > 500 or len(description) > 100_000:
        raise ValueError('Listing too long')
    job = dict(source='arbeitnow', external_id=slug, title=title, description=description,
               url=canonical, canonical_url=canonical, attribution='Arbeitnow',
               kind=kind, remote_evidence=entry.get('remote') is True,
               employment_types=sorted(normalized_types), location_evidence=location,
               published_at=published.isoformat(), received_at=published.isoformat(),
               weekly_hours=None, taiwan_eligible=None, timezone_compatible=None, deadline=None,
               currency=None, budget_min=None, budget_max=None, free_apply=None,
               language='en', complete=False, body_available=True)
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': 'arbeitnow:' + slug + ':' + fingerprint}


def parse_batch(raw, *, page=1):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BYTES:
        raise ValueError('Invalid API response')
    data = json.loads(raw)
    if not isinstance(data, dict) or not isinstance(data.get('data'), list) or len(data['data']) > MAX_PAGE_ENTRIES:
        raise ValueError('Invalid API envelope')
    if (not isinstance(data.get('meta'), dict) or type(data['meta'].get('current_page')) is not int
            or data['meta']['current_page'] != page):
        raise ValueError('Unexpected pagination')
    jobs, rejected = [], 0
    for entry in data['data']:
        try:
            jobs.append(normalize(entry))
        except (ValueError, TypeError, OverflowError):
            rejected += 1
    links = data.get('links')
    if not isinstance(links, dict) or 'next' not in links:
        raise ValueError('Missing pagination evidence')
    next_url = links['next']
    if next_url is not None:
        if not isinstance(next_url, str) or not data['data']:
            raise ValueError('Invalid next page')
        parsed = urlsplit(next_url)
        if (parsed.scheme != 'https' or parsed.netloc not in ('www.arbeitnow.com', 'www.arbeitnow.nl')
                or parsed.path != '/api/job-board-api' or parsed.fragment
                or parse_qs(parsed.query) != {'page': [str(page + 1)]}
                or parsed.query != 'page=' + str(page + 1)):
            raise ValueError('Unsupported next page URL')
        # Official API responses may carry the observed regional alias; requests stay pinned.
        next_url = ENDPOINT + '?page=' + str(page + 1)
    return jobs, rejected, next_url


def scan(*, reader=fetch, max_pages=20, max_seconds=120, monotonic=time.monotonic):
    if type(max_pages) is not int or not 1 <= max_pages <= 100 or not 0 < max_seconds <= 300:
        raise ValueError('Invalid scan limits')
    end = monotonic() + max_seconds
    url, page, rejected, seen = ENDPOINT, 1, 0, 0
    jobs = {}
    page_size = None
    pagination_consistent = True
    while url and page <= max_pages:
        remaining = end - monotonic()
        if remaining <= 0:
            break
        if page > 1:
            if remaining <= 3:
                break
            time.sleep(3)
            remaining = end - monotonic()
            if remaining <= 0:
                break
        raw = reader(url, timeout=min(25, remaining))
        batch, bad, next_url = parse_batch(raw, page=page)
        envelope = json.loads(raw)
        meta, count = envelope['meta'], len(envelope['data'])
        size = meta.get('per_page')
        valid_size = type(size) is int and 0 < size <= MAX_PAGE_ENTRIES
        if page_size is None and valid_size:
            page_size = size
        expected_from = (page - 1) * size + 1 if valid_size else None
        valid_range = (valid_size and size == page_size and count <= size
                       and ((count == 0 and meta.get('from') is None and meta.get('to') is None)
                            or (count > 0 and type(meta.get('from')) is int
                                and type(meta.get('to')) is int
                                and meta['from'] == expected_from
                                and meta['to'] == expected_from + count - 1))
                       and (next_url is None or count == size))
        pagination_consistent = pagination_consistent and valid_range
        seen += len(batch) + bad
        rejected += bad
        for job in batch:
            previous = jobs.get(job['external_id'])
            if previous and previous['receipt_id'] != job['receipt_id']:
                raise ValueError('Listing changed during pagination')
            jobs[job['external_id']] = job
        url = next_url
        page += 1
    return list(jobs.values()), dict(seen=seen, pages=page - 1, rejected_count=rejected,
                                    truncated=bool(url), pagination_consistent=pagination_consistent,
                                    complete_scan=not url and not rejected and pagination_consistent,
                                    scope='official_public_api_pages')


def sync(store, *, reader=fetch, max_pages=20, max_seconds=120):
    try:
        store.set_source_health('arbeitnow', 'failed')
        jobs, coverage = scan(reader=reader, max_pages=max_pages, max_seconds=max_seconds)
        incomplete = not coverage['complete_scan']
        now = store.clock()
        selected = []
        with store.source_batch('arbeitnow') as batch:
            existing = batch.existing_ids()
            for job in jobs:
                fresh = now - timedelta(days=90) <= datetime.fromisoformat(job['published_at']) <= now
                evaluation = qualify_for_intake(job, now=now)
                if job['external_id'] in existing or (fresh and job['remote_evidence'] and
                    job['kind'] == 'contract' and evaluation['status'] != 'excluded' and evaluation['score'] > 0):
                    batch.ingest(job, receipt_id=job['receipt_id'])
                    selected.append(job)
            batch.finish('failed' if incomplete else 'ok')
        return {'status': 'partial' if incomplete else 'ok', 'jobs': len(selected), **coverage}
    except Exception:
        return {'status': 'failed', 'reason': 'arbeitnow_source_unavailable_or_unsupported'}
