"""518 public part-time software search; no login, application, or private API."""
from datetime import date
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, build_opener

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.public_feeds import NoRedirect, Text, published, text
from freelance.modules.collection.ptt_soho import read_body

ORIGIN = 'https://www.518.com.tw'
INDEX = ORIGIN + '/job-index-P-1.html?ai=2&ab=2032001005,2032001003,2032001016,2032001018'
CATEGORIES = ('軟體設計工程師', 'Internet程式設計師', 'APP工程師', 'AI工程師')
ARTICLE = re.compile(r'/job-([A-Za-z0-9]{6})\.html\Z')


class AccessBlocked(ValueError):
    pass


def canonical(value):
    if not isinstance(value, str):
        raise ValueError('Missing job URL')
    url = urlsplit(urljoin(ORIGIN, value))
    if url.scheme != 'https' or url.netloc != 'www.518.com.tw' or not ARTICLE.fullmatch(url.path):
        raise ValueError('Invalid job URL')
    return url._replace(query='', fragment='').geturl()


def page_text(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > 2_000_000:
        raise ValueError('Invalid page size')
    html = raw.decode('utf-8')
    if re.search(r'cf-chl-|_Incapsula_Resource|captcha-container|<title>\s*(?:Just a moment|Access denied)', html, re.I):
        raise AccessBlocked('Access challenge')
    return html


def visible_text(html):
    parser = Text(); parser.feed(html); parser.close()
    return '\n'.join(parser.parts)


def date_value(value):
    # Source date-only values carry no timezone; don't invent midnight UTC.
    if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return date.fromisoformat(value).isoformat()
    return published(value).isoformat()


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []; self.jobs = []; self.heading = []
        self.in_heading = False; self.in_script = False; self.parts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'h1': self.in_heading = True
        if tag == 'a':
            try: self.urls.append(canonical(attrs.get('href')))
            except ValueError: pass  # navigation, ads and external links are not jobs
        if tag == 'script' and attrs.get('type') == 'application/ld+json':
            self.in_script = True; self.parts = []

    def handle_data(self, data):
        if self.in_heading: self.heading.append(data)
        if self.in_script: self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'h1': self.in_heading = False
        if tag == 'script' and self.in_script:
            self.in_script = False
            value = json.loads(''.join(self.parts))
            values = value if isinstance(value, list) else [value]
            self.jobs.extend(v for v in values if isinstance(v, dict) and v.get('@type') == 'JobPosting')


def parse_index(raw):
    html = page_text(raw)
    page = Page(); page.feed(html); page.close()
    heading = ''.join(page.heading)
    if '兼職工作職缺' not in heading or not all(c in heading for c in CATEGORIES):
        raise ValueError('Search filters not confirmed')
    urls = list(dict.fromkeys(page.urls))
    empty = '抱歉沒有搜到適合的職缺' in visible_text(html)
    if (empty and urls) or (not empty and not urls) or len(urls) > 200:
        raise ValueError('Unrecognized search result')
    return urls


def parse_article(raw, url):
    url = canonical(url); html = page_text(raw)
    page = Page(); page.feed(html); page.close()
    if len(page.jobs) != 1: raise ValueError('Expected one JobPosting')
    data = page.jobs[0]
    if canonical(data.get('url')) != url: raise ValueError('Mismatched job URL')
    title, body = text(data.get('title')), text(data.get('description'))
    if len(title) > 500 or len(body) > 100_000: raise ValueError('Oversize job')
    types = data.get('employmentType')
    if isinstance(types, str): types = [types]
    if not isinstance(types, list) or not types or any(not isinstance(t, str) for t in types):
        raise ValueError('Invalid employment types')
    types = sorted(set(types))
    kind = 'full_time' if 'FULL_TIME' in types else 'contract' if set(types) & {'PART_TIME', 'CONTRACTOR', 'TEMPORARY'} else None
    stamp = date_value(data.get('datePosted'))
    update = re.search(r'更新日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})', visible_text(html))
    updated = date_value(update[1]) if update else None
    category = re.search(r'職務類別\s*(.*?)\s*職缺條件', body, re.S)
    category_text = category[1] if category else ''
    expiry = data.get('validThrough')
    if expiry: expiry = date_value(expiry)
    job = dict(source='jobbank518', external_id=ARTICLE.fullmatch(urlsplit(url).path)[1],
               title=title, description=body, url=url, canonical_url=url, attribution='518熊班',
               kind=kind, published_at=stamp, received_at=stamp, updated_at=updated,
               deadline=expiry or None, employment_types=types, category_evidence=category_text,
               software_category=any(c in category_text for c in CATEGORIES),
               location_evidence=data.get('jobLocation'), salary_evidence=data.get('baseSalary'),
               remote_evidence=data.get('jobLocationType') == 'TELECOMMUTE',
               weekly_hours=None, taiwan_eligible=None, timezone_compatible=None,
               currency=None, budget_min=None, budget_max=None, free_apply=None,
               language='zh-TW', complete=False, body_available=True)
    digest = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': 'jobbank518:' + digest}


def fetch(*, read=None, pause=time.sleep):
    deadline = time.monotonic() + 90
    def http_read(url):
        if url != INDEX: canonical(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Source deadline')
        req = Request(url, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery', 'Accept-Encoding': 'identity'})
        with build_opener(NoRedirect()).open(req, timeout=min(10, remaining)) as response:
            if response.status != 200: raise ValueError('Source unavailable')
            return read_body(response, deadline)
    read = read or http_read
    urls = parse_index(read(INDEX)); jobs = []; rejected = 0; attempted = 0
    for url in urls:
        if deadline - time.monotonic() < 1: break
        pause(0.6); attempted += 1
        try: jobs.append(parse_article(read(url), url))
        except AccessBlocked: raise
        except HTTPError as exc:
            if exc.code in (401, 403, 429): raise
            exc.close(); rejected += 1
        except (ValueError, TypeError, KeyError, OSError): rejected += 1
    return dict(jobs=jobs, seen=len(urls), details_read=len(jobs), rejected_count=rejected,
                truncated=attempted < len(urls), complete_scan=False,
                scope='public_part_time_four_software_categories_first_page')


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('jobbank518', 'failed')
        result = reader(); count = 0; now = store.clock()
        with store.source_batch('jobbank518') as batch:
            old = batch.existing_ids()
            for job in result['jobs']:
                if job['external_id'] in old or (job['software_category'] and job['kind'] == 'contract'
                                                and qualify_for_intake(job, now=now)['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id']); count += 1
            partial = bool(result['rejected_count'] or result['truncated'])
            batch.finish('failed' if partial else 'ok')
        return {k: v for k, v in result.items() if k != 'jobs'} | {'jobs': count, 'status': 'partial' if partial else 'ok'}
    except Exception:
        return {'status': 'failed', 'reason': 'jobbank518_unavailable_or_unsupported'}
