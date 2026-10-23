"""NoDesk's advertised RSS plus public JobPosting metadata, without account access."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from xml.etree import ElementTree

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.public_feeds import NoRedirect, published, text
from freelance.modules.collection.ptt_soho import read_body

FEED = 'https://nodesk.co/remote-jobs/index.xml'
ARTICLE = re.compile(r'/remote-jobs/[a-z0-9][a-z0-9-]+/\Z')


def canonical(url):
    parsed = urlsplit(url) if isinstance(url, str) else None
    if parsed is None or parsed.scheme != 'https' or parsed.netloc != 'nodesk.co' or not ARTICLE.fullmatch(parsed.path):
        raise ValueError('Invalid NoDesk job URL')
    return parsed._replace(query='', fragment='').geturl()


def parse_feed(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > 2_000_000:
        raise ValueError('Invalid NoDesk feed')
    xml = raw.decode('utf-8')
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', xml, re.I):
        raise ValueError('XML declarations forbidden')
    # The advertised feed contains these two HTML entities outside CDATA.
    # Repair only the observed defect, leaving CDATA and other errors intact.
    parts = re.split(r'(<!\[CDATA\[.*?\]\]>|<!--.*?-->)', xml, flags=re.S)
    for index in range(0, len(parts), 2):
        parts[index] = parts[index].replace('&ndash;', '&#8211;').replace('&rsquo;', '&#8217;')
    try:
        root = ElementTree.fromstring(''.join(parts))
    except ElementTree.ParseError:
        raise ValueError('Malformed NoDesk RSS') from None
    if root.tag != 'rss' or root.find('channel') is None:
        raise ValueError('Unsupported NoDesk RSS')
    items = root.findall('./channel/item')
    if not items:
        raise ValueError('Empty NoDesk RSS')
    entries, rejected, seen = [], 0, set()
    for item in items[:20]:
        try:
            url = canonical(item.findtext('link'))
            date = published(item.findtext('pubDate'))
            if url not in seen:
                entries.append({'url': url, 'published_at': date.isoformat()})
                seen.add(url)
        except (ValueError, TypeError):
            rejected += 1
    return entries, rejected, len(items) > 20


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(); self.active = False; self.parts = []; self.jobs = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('type') == 'application/ld+json':
            self.active = True; self.parts = []

    def handle_data(self, data):
        if self.active: self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            self.active = False
            value = json.loads(''.join(self.parts))
            if isinstance(value, dict) and value.get('@type') == 'JobPosting':
                self.jobs.append(value)


def parse_article(raw, entry):
    url = canonical(entry['url'])
    if not isinstance(raw, bytes) or not raw or len(raw) > 2_000_000:
        raise ValueError('Invalid job page')
    parser = Metadata(); parser.feed(raw.decode('utf-8')); parser.close()
    if len(parser.jobs) != 1:
        raise ValueError('Expected one JobPosting')
    data = parser.jobs[0]
    title, body = text(data.get('title')), text(data.get('description'))
    if len(title) > 500 or len(body) > 100_000:
        raise ValueError('Oversize listing')
    types = data.get('employmentType')
    if isinstance(types, str): types = [types]
    if not isinstance(types, list) or any(not isinstance(value, str) for value in types):
        raise ValueError('Missing employment types')
    types = sorted({value.upper() for value in types})
    kind = 'full_time' if 'FULL_TIME' in types else 'contract' if set(types) & {'PART_TIME', 'CONTRACTOR', 'TEMPORARY'} else None
    deadline = data.get('validThrough')
    if deadline is not None and not isinstance(deadline, str):
        raise ValueError('Invalid deadline')
    job = dict(source='nodesk', external_id=url, title=title, description=body,
               url=url, canonical_url=url, attribution='NoDesk', kind=kind,
               published_at=entry['published_at'], received_at=entry['published_at'],
               employment_types=types, location_evidence=data.get('applicantLocationRequirements'),
               remote_evidence=data.get('jobLocationType') == 'TELECOMMUTE',
               publication_evidence=data.get('datePosted'), deadline=deadline,
               weekly_hours=None, taiwan_eligible=None, timezone_compatible=None,
               currency=None, budget_min=None, budget_max=None, free_apply=None,
               language='en', complete=False, body_available=True)
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'receipt_id': 'nodesk:' + fingerprint}


def fetch():
    deadline = time.monotonic() + 90
    def read(url):
        if url != FEED: canonical(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('NoDesk deadline')
        req = Request(url, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery'})
        with build_opener(NoRedirect()).open(req, timeout=min(10, remaining)) as response:
            if response.status != 200: raise ValueError('NoDesk unavailable')
            return read_body(response, deadline)
    entries, rejected, truncated = parse_feed(read(FEED))
    seen = len(entries) + rejected
    now, jobs = datetime.now(timezone.utc), []
    recent = [entry for entry in entries if now - timedelta(days=90) <= published(entry['published_at']) <= now]
    for index, entry in enumerate(recent):
        if deadline - time.monotonic() <= 1:
            rejected += len(recent) - index
            break
        try:
            time.sleep(1)
            jobs.append(parse_article(read(entry['url']), entry))
        except (ValueError, OSError, TimeoutError):
            rejected += 1
    return {'jobs': jobs, 'seen': seen, 'rejected_count': rejected, 'truncated': truncated}


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('nodesk', 'failed')
        result = reader(); selected = 0
        with store.source_batch('nodesk') as batch:
            existing = batch.existing_ids()
            for job in result['jobs']:
                if job['external_id'] in existing or (job['remote_evidence'] and job['kind'] == 'contract' and qualify_for_intake(job, now=store.clock())['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id']); selected += 1
            batch.finish('failed' if result['rejected_count'] else 'ok')
        return {key: value for key, value in result.items() if key != 'jobs'} | {
            'status': 'partial' if result['rejected_count'] else 'ok', 'jobs': selected,
            'scope': 'advertised_rss_max_20_public_job_pages_90_days', 'complete_scan': False}
    except Exception:
        return {'status': 'failed', 'reason': 'nodesk_unavailable_or_unsupported'}
