"""Public computer-task category and visible task sections; no private API or login."""
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, build_opener

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.public_feeds import NoRedirect
from freelance.modules.collection.ptt_soho import read_body

ORIGIN = 'https://www.chickpt.com.tw'
INDEX = ORIGIN + '/cases?categories=105'
ARTICLE = re.compile(r'/job-([A-Za-z0-9]{12})\Z')
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


class AccessBlocked(ValueError):
    pass


def canonical(value):
    if not isinstance(value, str): raise ValueError('Missing task URL')
    url = urlsplit(urljoin(ORIGIN, value))
    if url.scheme != 'https' or url.netloc != 'www.chickpt.com.tw' or not ARTICLE.fullmatch(url.path):
        raise ValueError('Invalid task URL')
    return url._replace(query='', fragment='').geturl()


class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.stack = []; self.parts = {}; self.links = []; self.og_url = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs); classes = attrs.get('class', '').split(); key = None
        if tag == 'meta' and attrs.get('property') == 'og:url': self.og_url = attrs.get('content')
        if tag == 'a' and any(a.get('id') == 'job-list' for _, a, _ in self.stack):
            self.links.append(canonical(attrs.get('href')))
        if tag == 'h1': key = 'title'
        elif attrs.get('id') == 'job-count': key = 'count'
        elif tag == 'section' and 'job-content' in classes: key = 'body'
        elif 'job_salary_address-block' in classes: key = 'salary'
        elif tag == 'section' and 'job-work_time' in classes: key = 'work_time'
        elif tag == 'section' and 'job-address' in classes: key = 'location'
        if key: self.parts.setdefault(key, [])
        if tag not in VOID: self.stack.append((tag, attrs, key))

    def handle_endtag(self, tag):
        for index in range(len(self.stack)-1, -1, -1):
            if self.stack[index][0] == tag:
                self.stack = self.stack[:index]; break

    def handle_data(self, data):
        if any(t in ('script', 'style') for t, _, _ in self.stack): return
        for _, _, key in self.stack:
            if key: self.parts[key].append(data)

    def value(self, key):
        return ' '.join(' '.join(self.parts.get(key, [])).split())


def parse_page(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > 2_000_000: raise ValueError('Invalid page size')
    html = raw.decode('utf-8')
    if re.search(r'cf-chl-|_Incapsula_Resource|captcha-container|<title>\s*(?:Just a moment|Access denied)', html, re.I):
        raise AccessBlocked('Access challenge')
    page = Page(); page.feed(html); page.close()
    return page


def parse_index(raw):
    page = parse_page(raw)
    if page.value('title').replace(' ', '') != '電腦接案任務' or not page.value('count').isdigit():
        raise ValueError('Wrong category or missing result count')
    total = int(page.value('count')); urls = list(dict.fromkeys(page.links))
    if len(urls) > 200 or len(urls) > total or (total and not urls):
        raise ValueError('Invalid listing/count')
    return urls, total


def parse_article(raw, url, *, observed_at=None):
    url = canonical(url); page = parse_page(raw)
    if canonical(page.og_url) != url: raise ValueError('Mismatched task URL')
    title, body, salary = page.value('title'), page.value('body'), page.value('salary')
    if not title or not body.startswith('任務內容') or len(title) > 500 or len(body) > 100_000:
        raise ValueError('Missing task content')
    body = body[len('任務內容'):].strip()
    if not body: raise ValueError('Empty task content')
    # Preserve the visible asking amount; an hourly rate must never become a fixed total.
    money = re.match(r'單次\$([\d,]+)(?:\s*[~～]\s*\$?([\d,]+))?(?=\s|/|$)', salary)
    low = int(money[1].replace(',', '')) if money else None
    high = int((money[2] or money[1]).replace(',', '')) if money else None
    if money and (low <= 0 or high < low): raise ValueError('Invalid task budget')
    kind = 'fixed' if money else 'hourly' if salary.startswith('時薪$') else None
    job = dict(source='chickpt', external_id=ARTICLE.fullmatch(urlsplit(url).path)[1],
               title=title, description=body, url=url, canonical_url=url, attribution='小雞上工',
               kind=kind, currency='TWD' if money else None, budget_min=low, budget_max=high,
               salary_evidence=salary, location_evidence=page.value('location') or None,
               work_time_evidence=page.value('work_time') or None,
               published_at=None, deadline=None, weekly_hours=None, taiwan_eligible=None,
               timezone_compatible=None, free_apply=None, complete=False, body_available=True,
               language='zh-TW', category_evidence='電腦接案任務')
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'received_at': (observed_at or datetime.now(timezone.utc)).isoformat(),
                  'receipt_id': 'chickpt:' + fingerprint}


def fetch(*, read=None, pause=time.sleep):
    deadline = time.monotonic() + 90
    def http_read(url):
        if url != INDEX: canonical(url)
        remaining = deadline-time.monotonic()
        if remaining <= 0: raise TimeoutError('Source deadline')
        req = Request(url, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery', 'Accept-Encoding': 'identity'})
        with build_opener(NoRedirect()).open(req, timeout=min(10, remaining)) as response:
            if response.status != 200: raise ValueError('Source unavailable')
            return read_body(response, deadline)
    read = read or http_read
    urls, total = parse_index(read(INDEX)); jobs = []; rejected = 0; attempted = 0
    for url in urls:
        if deadline-time.monotonic() < 1: break
        pause(.6); attempted += 1
        try: jobs.append(parse_article(read(url), url))
        except AccessBlocked: raise
        except HTTPError as exc:
            if exc.code in (401, 403, 429): raise
            exc.close(); rejected += 1
        except (ValueError, TypeError, OSError): rejected += 1
    return dict(jobs=jobs, seen=len(urls), reported_total=total, details_read=len(jobs),
                rejected_count=rejected, truncated=attempted < len(urls) or total > len(urls),
                complete_scan=False, scope='public_computer_task_category_first_page')


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('chickpt', 'failed'); result = reader(); count = 0
        with store.source_batch('chickpt') as batch:
            old = batch.existing_ids()
            for job in result['jobs']:
                if job['external_id'] in old or qualify_for_intake(job, now=store.clock())['status'] != 'excluded':
                    batch.ingest(job, receipt_id=job['receipt_id']); count += 1
            partial = bool(result['rejected_count'] or result['truncated'])
            batch.finish('failed' if partial else 'ok')
        return {k:v for k,v in result.items() if k != 'jobs'} | {'jobs':count, 'status':'partial' if partial else 'ok'}
    except Exception:
        return {'status':'failed', 'reason':'chickpt_unavailable_or_unsupported'}
