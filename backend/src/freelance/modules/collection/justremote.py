"""Read JustRemote's public HTML listing state and JobPosting metadata; no private API."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, build_opener

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.nodesk import Metadata
from freelance.modules.collection.public_feeds import NoRedirect, published, text
from freelance.modules.collection.ptt_soho import read_body

INDEX = 'https://justremote.co/remote-jobs'
TECH = {'developer', 'devopsandsysadmin'}
ARTICLE = re.compile(r'/remote-[a-z-]+-jobs/[a-z0-9][a-z0-9-]+\Z')


def canonical(value):
    if not isinstance(value, str): raise ValueError('Missing job link')
    url = urlsplit(urljoin('https://justremote.co/', value))
    if url.scheme != 'https' or url.netloc != 'justremote.co' or not ARTICLE.fullmatch(url.path):
        raise ValueError('Invalid job link')
    return url._replace(query='', fragment='').geturl()


class ListingState(HTMLParser):
    def __init__(self):
        super().__init__(); self.active = False; self.parts = []; self.states = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script': self.active = True; self.parts = []

    def handle_data(self, data):
        if self.active: self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            self.active = False
            raw = ''.join(self.parts).strip()
            prefix = 'window.__PRELOADED_STATE__ = '
            if raw.startswith(prefix):
                # Parse literal JSON only. Never execute the site's JavaScript.
                value, end = json.JSONDecoder().raw_decode(raw[len(prefix):])
                if raw[len(prefix) + end:].strip() not in ('', ';'):
                    raise ValueError('Unsupported state suffix')
                self.states.append(value)


def parse_index(raw):
    parser = ListingState(); parser.feed(raw.decode('utf-8')); parser.close()
    if len(parser.states) != 1: raise ValueError('Missing listing state')
    state = parser.states[0]['jobsState']
    entries = state['entity']['all']
    if state.get('meta', {}).get('status') != 'success' or not isinstance(entries, list) or not entries:
        raise ValueError('Incomplete listing state')
    if len(entries) > 2000: raise ValueError('Oversize listing state')
    valid, rejected, ids = [], 0, set()
    for entry in entries:
        try:
            if type(entry.get('id')) is not int or entry['id'] <= 0: raise ValueError('Invalid id')
            if entry.get('job_type') not in ('permanent', 'contract'): raise ValueError('Unknown employment type')
            locations = entry.get('location_restrictions')
            if not isinstance(locations, list) or any(not isinstance(x, str) or not x.strip() for x in locations):
                raise ValueError('Invalid location restrictions')
            if not isinstance(entry.get('category'), str) or type(entry.get('is_active')) is not bool:
                raise ValueError('Invalid category or status')
            url = canonical(entry.get('href')); text(entry.get('title'))
            if entry['id'] in ids: raise ValueError('Duplicate id')
            ids.add(entry['id']); valid.append(entry | {'url': url})
        except (ValueError, TypeError, AttributeError): rejected += 1
    return valid, rejected


def parse_article(raw, entry):
    parser = Metadata(); parser.feed(raw.decode('utf-8')); parser.close()
    if len(parser.jobs) != 1: raise ValueError('Expected one JobPosting')
    data = parser.jobs[0]
    title, body = text(data.get('title')), text(data.get('description'))
    if title != text(entry['title']) or len(title) > 500 or len(body) > 100_000:
        raise ValueError('Mismatched or oversize job')
    types = data.get('employmentType')
    if isinstance(types, str): types = [types]
    if not isinstance(types, list) or any(not isinstance(x, str) for x in types):
        raise ValueError('Invalid employment types')
    kind = 'full_time' if 'FULL_TIME' in types else 'contract' if set(types) & {'PART_TIME', 'CONTRACTOR', 'TEMPORARY'} else None
    # Prefer explicit detail metadata; inconsistent contract/permanent is not silently accepted.
    if entry['job_type'] == 'permanent' and kind != 'full_time': raise ValueError('Employment mismatch')
    date = published(data.get('datePosted')).isoformat()
    deadline = data.get('validThrough')
    if deadline: deadline = published(deadline).isoformat()
    locations = entry['location_restrictions']
    broad = {'worldwide', 'anywhere', 'asia', 'apac', 'global', 'taiwan', 'taiwan, province of china'}
    excluded = bool(locations) and not any(x.lower() in broad for x in locations)
    url = canonical(entry['url'])
    job = dict(source='justremote', external_id=str(entry['id']), title=title, description=body,
               url=url, canonical_url=url, attribution='JustRemote', kind=kind,
               published_at=date, received_at=date, deadline=deadline, employment_types=types,
               location_evidence=locations, category_evidence=entry['category'],
               remote_evidence=data.get('jobLocationType') == 'TELECOMMUTE',
               active_evidence=entry['is_active'], weekly_hours=None, taiwan_eligible=False if excluded else None,
               timezone_compatible=None, currency=None, budget_min=None, budget_max=None,
               language='en', complete=False, body_available=True)
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': 'justremote:' + fingerprint}


def fetch():
    deadline = time.monotonic() + 90
    def read(url):
        if url != INDEX: canonical(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Source deadline')
        req = Request(url, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery'})
        with build_opener(NoRedirect()).open(req, timeout=min(10, remaining)) as response:
            if response.status != 200: raise ValueError('Source unavailable')
            return read_body(response, deadline)
    entries, rejected = parse_index(read(INDEX))
    # Read every contract and technical detail, including full-time updates to previously known jobs.
    selected = [e for e in entries if e['job_type'] == 'contract' or e['category'] in TECH]
    jobs = []
    for index, entry in enumerate(selected):
        if deadline - time.monotonic() <= 1:
            rejected += len(selected) - index; break
        try:
            time.sleep(0.6); jobs.append(parse_article(read(entry['url']), entry))
        except (ValueError, TypeError, KeyError, OSError): rejected += 1
    return dict(jobs=jobs, seen=len(entries), rejected_count=rejected, details_read=len(jobs),
                listing_metadata=entries, complete_scan=False, scope='public_html_listing_window')


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('justremote', 'failed')
        result = reader(); count = 0; now = store.clock()
        with store.source_batch('justremote') as batch:
            old = batch.existing_ids()
            for job in result['jobs']:
                recent = now - timedelta(days=90) <= published(job['published_at']) <= now
                if job['external_id'] in old or (recent and job['active_evidence'] and job['remote_evidence'] and
                    job['kind'] == 'contract' and job['category_evidence'] in TECH and qualify_for_intake(job, now=now)['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id']); count += 1
            batch.finish('failed' if result['rejected_count'] else 'ok')
        return {k:v for k,v in result.items() if k not in ('jobs', 'listing_metadata')} | {
            'jobs': count, 'status': 'partial' if result['rejected_count'] else 'ok'}
    except Exception:
        return {'status': 'failed', 'reason': 'justremote_unavailable_or_unsupported'}
