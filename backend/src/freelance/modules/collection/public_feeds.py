"""Bounded official public feeds, with source attribution and manual application only."""
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from xml.etree import ElementTree

from freelance.modules.discovery.public import qualify_for_intake

ENDPOINTS = {'remoteok': 'https://remoteok.com/api',
             'realworkfromanywhere': 'https://www.realworkfromanywhere.com/rss.xml',
             'weworkremotely': 'https://weworkremotely.com/remote-jobs.rss',
             'workingnomads': 'https://www.workingnomads.com/api/exposed_jobs/'}
ATTRIBUTION = {'remoteok': 'Remote OK', 'realworkfromanywhere': 'Real Work From Anywhere',
               'weworkremotely': 'We Work Remotely', 'workingnomads': 'Working Nomads'}
MAX_BYTES = 8_000_000
MAX_ITEMS = 200
TIMEOUT = 25


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Public feed redirects are unsupported')


def fetch(source):
    if source not in ENDPOINTS:
        raise ValueError('Unsupported public source')
    deadline = time.monotonic() + TIMEOUT
    request = Request(ENDPOINTS[source], headers={
        'User-Agent': 'freelance-agent/0.1 personal-job-discovery',
        'Accept': 'application/json' if source in ('remoteok', 'workingnomads') else 'application/rss+xml, application/xml'}, method='GET')
    with build_opener(NoRedirect()).open(request, timeout=TIMEOUT) as response:
        if response.status != 200:
            raise ValueError('Public feed unavailable')
        parts, size = [], 0
        sock = response.fp.raw._sock
        while response.fp is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Public feed deadline')
            sock.settimeout(remaining)
            chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
            if time.monotonic() > deadline:
                raise TimeoutError('Public feed deadline')
            if not chunk:
                break
            parts.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError('Public feed size limit')
        return b''.join(parts)


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        if tag in ('p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'tr'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)
        if tag in ('p', 'div', 'li', 'h1', 'h2', 'h3', 'tr'):
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 200_000:
        raise ValueError('Full feed description required')
    parser = Text()
    parser.feed(value)
    parser.close()
    result = '\n'.join(' '.join(line.split()) for line in ''.join(parser.parts).splitlines() if line.strip())
    if not result:
        raise ValueError('Empty text')
    return result


def published(value):
    if not isinstance(value, str):
        raise ValueError('Publication time required')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        result = parsedate_to_datetime(value)
    if result.tzinfo is None:
        raise ValueError('Publication timezone required')
    return result.astimezone(timezone.utc)


def normalize(source, entry):
    if not isinstance(entry, dict):
        raise ValueError('Invalid listing')
    title = text(entry.get('position') if source == 'remoteok' else entry.get('title'))
    if len(title) > 500:
        raise ValueError('Invalid title')
    body = text(entry.get('description'))
    url = entry.get('url')
    if not isinstance(url, str):
        raise ValueError('Missing canonical URL')
    parsed = urlsplit(url)
    host = {'remoteok': 'remoteok.com', 'realworkfromanywhere': 'www.realworkfromanywhere.com',
            'weworkremotely': 'weworkremotely.com', 'workingnomads': 'www.workingnomads.com'}[source]
    prefix = {'remoteok': '/remote-jobs/', 'realworkfromanywhere': '/jobs/',
              'weworkremotely': '/remote-jobs/', 'workingnomads': '/job/go/'}[source]
    if parsed.scheme != 'https' or parsed.netloc.lower() != host or not parsed.path.startswith(prefix) or len(parsed.path) <= len(prefix):
        raise ValueError('Invalid canonical URL')
    if source == 'workingnomads' and not re.fullmatch(r'/job/go/\d+/', parsed.path):
        raise ValueError('Invalid Working Nomads listing URL')
    canonical = parsed._replace(netloc=host, query='', fragment='').geturl()
    identity = entry.get('id') if source == 'remoteok' else canonical
    if source == 'remoteok' and (isinstance(identity, bool) or not str(identity).isdigit()):
        raise ValueError('Invalid listing ID')
    date = published(entry.get('pub_date') if source == 'workingnomads' else entry.get('date'))
    tags = entry.get('tags', [])
    if source == 'workingnomads' and isinstance(tags, str):
        tags = [x.strip() for x in tags.split(',') if x.strip()]
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError('Invalid tags')
    employment = ' '.join([title, *tags, str(entry.get('employment_type') or '')])
    # Body evidence must describe employment, not e.g. smart-contract development.
    explicit = re.findall(r'(?:employment|job|work|position)\s*type\s*[:：]\s*([^\n.;]+)', body, re.I)
    explicit += re.findall(r'(?:position|role|job)\s+(?:is\s+)?(?:offered\s+)?(?:on\s+)?(?:a\s+)?(?:part[ -]time|freelance|contract(?:or)?)(?:\s+basis)?\b', body, re.I)
    employment += ' ' + ' '.join(explicit)
    employment = re.sub(r'\bsmart[ -]+contracts?\b', '', employment, flags=re.I)
    fulltime = re.search(r'\bfull[\s_-]*time\b', employment + '\n' + body, re.I)
    contract = re.search(r'\b(?:part[\s_-]*time|freelance|contract(?:or)?)\b', employment, re.I)
    kind = 'full_time' if fulltime else 'contract' if contract else None
    closed = entry.get('closed') is True or entry.get('status') in ('closed', 'expired', 'filled') or bool(re.search(r'\b(?:position|job|listing)\s+(?:is\s+)?(?:closed|filled|expired)\b', title + '\n' + body, re.I))
    geo = entry.get('location') or None
    if geo is not None and not isinstance(geo, str):
        raise ValueError('Invalid location')
    job = dict(source=source, external_id=str(identity), title=title, description=body,
               url=canonical, canonical_url=canonical, attribution=ATTRIBUTION[source],
               kind=kind, listing_closed=closed, published_at=date.isoformat(), received_at=date.isoformat(),
               publication_evidence=entry.get('pub_date') if source == 'workingnomads' else entry.get('date'), employment_evidence=employment.strip(), location_evidence=geo,
               weekly_hours=None, taiwan_eligible=None, timezone_compatible=None, deadline=None,
               currency=None, budget_min=None, budget_max=None, free_apply=None,
               salary_evidence={'min': entry.get('salary_min') or None, 'max': entry.get('salary_max') or None,
                                'period': entry.get('salary_period') or None},
               language='en', complete=False, body_available=True)
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': source + ':' + str(identity) + ':' + fingerprint}


def _entries(source, raw):
    if source not in ENDPOINTS or not isinstance(raw, bytes) or not raw.strip() or len(raw) > MAX_BYTES:
        raise ValueError('Unsupported or empty public feed')
    if source in ('remoteok', 'workingnomads'):
        entries = json.loads(raw)
        if not isinstance(entries, list):
            raise ValueError('Unsupported JSON feed')
        if source == 'remoteok' and entries and isinstance(entries[0], dict) and 'legal' in entries[0] and 'id' not in entries[0]:
            entries = entries[1:]
    else:
        xml = raw.decode('utf-8')
        if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', xml, re.I):
            raise ValueError('XML declarations forbidden')
        # Official RSS emits naked query separators in enclosure URL attributes.
        # Only repair this observed defect; CDATA/content and all other XML stay intact.
        tokens = re.split(r'(<!\[CDATA\[.*?\]\]>|<!--.*?-->)', xml, flags=re.S)
        for index in range(0, len(tokens), 2):
            tokens[index] = re.sub(r'(<enclosure\b[^>]*\burl=")([^"]*)(")',
                lambda m: m[1] + re.sub(r'&(?=[A-Za-z_][A-Za-z0-9_.-]*=)', '&amp;', m[2]) + m[3], tokens[index])
        root = ElementTree.fromstring(''.join(tokens))
        channel = root.find('channel')
        if root.tag != 'rss' or channel is None:
            raise ValueError('Unsupported RSS structure')
        entries = [dict(title=item.findtext('title'), description=item.findtext('description'),
                        url=item.findtext('link'), date=item.findtext('pubDate'),
                        location=item.findtext('region'),
                        tags=[c.text or '' for c in item.findall('category')]) for item in channel.findall('item')]
    if not entries:
        raise ValueError('Empty listing feed')
    return entries[:MAX_ITEMS], len(entries) > MAX_ITEMS


def parse(source, raw):
    """Strict parsing for callers that require every listing to be valid."""
    entries, truncated = _entries(source, raw)
    return [normalize(source, entry) for entry in entries], truncated


def parse_batch(source, raw):
    """Isolate invalid individual listings; envelope failures still propagate."""
    entries, truncated = _entries(source, raw)
    jobs, rejected_count = [], 0
    for entry in entries:
        try:
            jobs.append(normalize(source, entry))
        except (ValueError, TypeError):
            rejected_count += 1
    return jobs, truncated, rejected_count


def sync(source, store, *, reader=fetch):
    try:
        if source not in ENDPOINTS:
            raise ValueError('Unsupported source')
        store.set_source_health(source, 'failed')
        jobs, truncated, rejected_count = parse_batch(source, reader(source))
        now = store.clock()
        selected = []
        with store.source_batch(source) as batch:
            existing = batch.existing_ids()
            for job in jobs:
                fresh = now - timedelta(days=90) <= published(job['published_at']) <= now
                if job['external_id'] in existing or (fresh and job['kind'] == 'contract' and qualify_for_intake(job, now=now)['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id'])
                    selected.append(job)
            batch.finish('failed' if rejected_count else 'ok')
        result = dict(status='partial' if rejected_count else 'ok', seen=len(jobs) + rejected_count,
                      jobs=len(selected), truncated=truncated, rejected_count=rejected_count,
                      scope='latest_200_public_listings_within_90_days')
        if rejected_count:
            result['reason'] = 'invalid_individual_listings_rejected'
        return result
    except Exception:
        return dict(status='failed', reason='public_feed_unavailable_or_unsupported')
