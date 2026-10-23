"""Public engineering listing window and JobPosting pages; no accounts or private APIs."""
from datetime import timedelta
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, build_opener

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.nodesk import Metadata
from freelance.modules.collection.public_feeds import NoRedirect, published, text
from freelance.modules.collection.ptt_soho import read_body

ORIGIN = 'https://dynamitejobs.com'
INDEX = ORIGIN + '/category/development'
ARTICLE = re.compile(r'/company/[a-z0-9-]+/remote-job/[a-z0-9-]+\Z')


class AccessBlocked(ValueError):
    pass


def canonical(value):
    if not isinstance(value, str):
        raise ValueError('Missing job URL')
    url = urlsplit(urljoin(ORIGIN, value))
    if url.scheme != 'https' or url.netloc != 'dynamitejobs.com' or not ARTICLE.fullmatch(url.path):
        raise ValueError('Invalid job URL')
    return url._replace(query='', fragment='').geturl()


def page_text(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > 2_000_000:
        raise ValueError('Invalid page size')
    html = raw.decode('utf-8')
    if re.search(r'cf-chl-|_Incapsula_Resource|captcha-container|<title>\s*(?:Just a moment|Access denied)', html, re.I):
        raise AccessBlocked('Access challenge')
    return html


class Listing(HTMLParser):
    def __init__(self):
        super().__init__(); self.urls = []

    def handle_starttag(self, tag, attrs):
        href = dict(attrs).get('href', '')
        if tag == 'a' and '/remote-job/' in href:
            self.urls.append(canonical(href))


def parse_index(raw):
    parser = Listing(); parser.feed(page_text(raw)); parser.close()
    urls = list(dict.fromkeys(parser.urls))
    if not urls or len(urls) > 200:
        raise ValueError('Missing or oversized engineering listing')
    return urls


def parse_article(raw, url):
    url = canonical(url)
    parser = Metadata(); parser.feed(page_text(raw)); parser.close()
    if len(parser.jobs) != 1:
        raise ValueError('Expected one JobPosting')
    data = parser.jobs[0]
    if canonical(data.get('url')) != url:
        raise ValueError('Mismatched job URL')
    title, body = text(data.get('title')), text(data.get('description'))
    if len(title) > 500 or len(body) > 100_000:
        raise ValueError('Oversize job')
    types = data.get('employmentType')
    if isinstance(types, str): types = [types]
    if not isinstance(types, list) or not types or any(not isinstance(x, str) for x in types):
        raise ValueError('Invalid employment types')
    types = sorted(set(types))
    kind = 'full_time' if 'FULL_TIME' in types else 'contract' if set(types) & {'PART_TIME', 'CONTRACTOR', 'TEMPORARY'} else None
    locations = data.get('applicantLocationRequirements', [])
    if isinstance(locations, dict): locations = [locations]
    if not isinstance(locations, list): raise ValueError('Invalid location requirements')
    names = []
    for loc in locations:
        if not isinstance(loc, dict) or loc.get('@type') not in ('Country', 'AdministrativeArea'):
            raise ValueError('Unsupported location requirement')
        names.append(text(loc.get('name')))
    broad = {'taiwan', 'taiwan, province of china', 'asia', 'apac', 'worldwide', 'anywhere', 'global'}
    excluded = bool(names) and not any(x.lower() in broad for x in names)
    stamp = published(data.get('datePosted')).isoformat()
    expiry = data.get('validThrough')
    if expiry: expiry = published(expiry).isoformat()
    job = dict(source='dynamitejobs', external_id=urlsplit(url).path, title=title, description=body,
               url=url, canonical_url=url, attribution='Dynamite Jobs', kind=kind,
               published_at=stamp, received_at=stamp, deadline=expiry or None,
               employment_types=types, location_evidence=names, category_evidence='development',
               remote_evidence=data.get('jobLocationType') == 'TELECOMMUTE',
               weekly_hours=None, taiwan_eligible=False if excluded else None, timezone_compatible=None,
               currency=None, budget_min=None, budget_max=None, free_apply=None,
               language='en', complete=False, body_available=True)
    digest = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': 'dynamitejobs:' + digest}


def fetch(*, read=None, pause=time.sleep):
    deadline = time.monotonic() + 90
    def http_read(url):
        if url != INDEX: canonical(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Source deadline')
        request = Request(url, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery',
                                        'Accept-Encoding': 'identity'})
        with build_opener(NoRedirect()).open(request, timeout=min(10, remaining)) as response:
            if response.status != 200: raise ValueError('Source unavailable')
            return read_body(response, deadline)
    read = read or http_read
    urls = parse_index(read(INDEX)); jobs = []; rejected = 0; attempted = 0
    for url in urls:
        if deadline - time.monotonic() < 1: break
        pause(0.6); attempted += 1
        try:
            jobs.append(parse_article(read(url), url))
        except AccessBlocked:
            raise
        except HTTPError as exc:
            if exc.code in (401, 403, 429): raise
            rejected += 1
        except (ValueError, TypeError, KeyError, OSError):
            rejected += 1
    return dict(jobs=jobs, seen=len(urls), details_read=len(jobs), rejected_count=rejected,
                truncated=attempted < len(urls), complete_scan=False,
                scope='public_development_category_window_no_private_api')


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('dynamitejobs', 'failed')
        result = reader(); count = 0; now = store.clock()
        with store.source_batch('dynamitejobs') as batch:
            old = batch.existing_ids()
            for job in result['jobs']:
                recent = now - timedelta(days=90) <= published(job['published_at']) <= now
                if job['external_id'] in old or (recent and job['remote_evidence'] and job['kind'] == 'contract'
                                                and qualify_for_intake(job, now=now)['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id']); count += 1
            partial = bool(result['rejected_count'] or result['truncated'])
            batch.finish('failed' if partial else 'ok')
        return {k: v for k, v in result.items() if k != 'jobs'} | {'jobs': count, 'status': 'partial' if partial else 'ok'}
    except Exception:
        return {'status': 'failed', 'reason': 'dynamitejobs_unavailable_or_unsupported'}
