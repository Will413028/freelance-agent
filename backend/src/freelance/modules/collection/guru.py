"""Guru public programming listings and JobPosting pages; no account or bidding."""
from datetime import timedelta
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, build_opener
from urllib.error import HTTPError

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.nodesk import Metadata
from freelance.modules.collection.public_feeds import NoRedirect, published, text
from freelance.modules.collection.ptt_soho import read_body


class SourceBlocked(ValueError):
    pass


def check_public_page(raw):
    if b'_Incapsula_Resource' in raw and b'JobPosting' not in raw:
        raise SourceBlocked('Public page returned an access challenge')
    return raw

ROOT = 'https://www.guru.com'
INDEX = ROOT + '/d/jobs/c/programming-development/'
ARTICLE = re.compile(r'/jobs/[a-z0-9-]+/([0-9]+)\Z')
PAGES = re.compile(r'/d/jobs/c/programming-development/(?:pg/([0-9]+)/)?\Z')


def canonical(value, *, listing=False):
    if not isinstance(value, str): raise ValueError('Missing URL')
    # Observed listing links append a tracking suffix after the numeric id.
    if listing: value = value.split('&SearchUrl=', 1)[0]
    parsed = urlsplit(urljoin(ROOT, value))
    if parsed.scheme != 'https' or parsed.netloc != 'www.guru.com' or not ARTICLE.fullmatch(parsed.path):
        raise ValueError('Invalid Guru job URL')
    return parsed._replace(query='', fragment='').geturl()


class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.links = []; self.quote = False
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            self.links.append(attrs.get('href', ''))
            self.quote |= attrs.get('title') == 'Send a Quote' and attrs.get('href', '').startswith('/login.aspx?ReturnUrl=work/detail/')


def parse_index(raw, current):
    check_public_page(raw)
    p = Page(); p.feed(raw.decode('utf-8')); p.close()
    entries, pages, rejected = {}, [], 0
    for link in p.links:
        if link.startswith('/jobs/'):
            try:
                url = canonical(link, listing=True); entries[url] = {'url': url}
            except ValueError: rejected += 1
        if PAGES.fullmatch(link):
            page = int(PAGES.fullmatch(link)[1] or 1)
            if page > current: pages.append((page, ROOT + link))
    if not entries: raise ValueError('Missing job links')
    return list(entries.values()), min(pages)[1] if pages else None, rejected


def parse_article(raw, entry):
    url = canonical(entry['url']); identity = ARTICLE.fullmatch(urlsplit(url).path)[1]
    check_public_page(raw)
    html = raw.decode('utf-8')
    m = Metadata(); m.feed(html); m.close()
    if len(m.jobs) != 1: raise ValueError('Expected one JobPosting')
    data = m.jobs[0]
    if str(data.get('Identifier', {}).get('Value')) != identity: raise ValueError('Mismatched job id')
    title, body = text(data.get('title')), text(data.get('description'))
    if len(title) > 500 or len(body) > 100_000: raise ValueError('Oversize listing')
    p = Page(); p.feed(html); p.close()
    # Only the actual heading budget is evidence; schema's YEAR is wrong for fixed quotes.
    budget = re.search(r'<div\b[^>]*class="jobHeading__budget"[^>]*>(.*?)</div>', html, re.S)
    budget_text = text(budget[1]) if budget else None
    kind = 'fixed' if budget_text and budget_text.startswith('Fixed Price') else 'hourly' if budget_text and budget_text.startswith('Hourly') else 'contract'
    types = data.get('employmentType')
    if types == 'FULL_TIME': kind = 'full_time'
    elif types != 'CONTRACTOR': raise ValueError('Unknown employment type')
    locations = data.get('applicantLocationRequirements', {}).get('name')
    if not isinstance(locations, list) or any(not isinstance(x, str) for x in locations):
        raise ValueError('Invalid location requirements')
    unknown_or_allowed = {'not available', 'worldwide', 'anywhere', 'taiwan', 'taiwan, province of china', 'asia', 'apac'}
    excluded = bool(locations) and not any(x.lower() in unknown_or_allowed for x in locations)
    date = published(data.get('datePosted')).isoformat()
    deadline = published(data['validThrough']).isoformat() if data.get('validThrough') else None
    job = dict(source='guru', external_id=identity, title=title, description=body, url=url, canonical_url=url,
               attribution='Guru', kind=kind, published_at=date, received_at=date, deadline=deadline,
               listing_closed=None, apply_open_evidence=p.quote, location_evidence=locations, taiwan_eligible=False if excluded else None,
               remote_evidence=data.get('jobLocationType') == 'TELECOMMUTE', budget_evidence=budget_text,
               currency=None, budget_min=None, budget_max=None, weekly_hours=None, timezone_compatible=None,
               free_apply=None, language='en', complete=False, body_available=True)
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': 'guru:' + fingerprint}


def fetch():
    deadline = time.monotonic() + 120
    def read(url):
        parsed = urlsplit(url)
        if url.startswith(ROOT) and PAGES.fullmatch(parsed.path) and parsed.netloc == 'www.guru.com': pass
        else: canonical(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Guru deadline')
        req = Request(url, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery'})
        with build_opener(NoRedirect()).open(req, timeout=min(10, remaining)) as response:
            if response.status != 200: raise ValueError('Source unavailable')
            return read_body(response, deadline)
    entries, rejected, pages, url = {}, 0, 0, INDEX
    while url and pages < 10:
        page = int(PAGES.fullmatch(urlsplit(url).path)[1] or 1)
        items, next_url, bad = parse_index(read(url), page)
        for item in items: entries[item['url']] = item
        rejected += bad; pages += 1; url = next_url
        if url: time.sleep(0.7)
    jobs = []; blocked = False; unread = 0
    items = list(entries.values())
    for index, item in enumerate(items):
        if deadline - time.monotonic() <= 1:
            unread = len(items) - index; break
        try:
            time.sleep(0.7); jobs.append(parse_article(read(item['url']), item))
        except SourceBlocked:
            blocked = True; unread = len(items) - index; break
        except HTTPError as error:
            if error.code in (401, 403, 429):
                blocked = True; unread = len(items) - index; break
            rejected += 1
        except (ValueError, TypeError, KeyError, OSError): rejected += 1
    return dict(jobs=jobs, seen=len(entries), rejected_count=rejected, pages=pages,
                details_read=len(jobs), truncated=bool(url), unread_count=unread, access_blocked=blocked, complete_scan=False,
                scope='public_programming_category_max_10_pages_120_seconds')


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('guru', 'failed')
        result = reader(); count = 0; now = store.clock()
        with store.source_batch('guru') as batch:
            old = batch.existing_ids()
            for job in result['jobs']:
                fresh = now - timedelta(days=90) <= published(job['published_at']) <= now
                if job['external_id'] in old or (fresh and job['apply_open_evidence'] and job['remote_evidence'] and qualify_for_intake(job, now=now)['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id']); count += 1
            partial = bool(result['rejected_count'] or result['truncated'] or result.get('unread_count') or result.get('access_blocked'))
            batch.finish('failed' if partial else 'ok')
        return {k:v for k,v in result.items() if k != 'jobs'} | {'jobs': count, 'status': 'partial' if partial else 'ok'}
    except Exception:
        return {'status': 'failed', 'reason': 'guru_unavailable_or_unsupported'}
