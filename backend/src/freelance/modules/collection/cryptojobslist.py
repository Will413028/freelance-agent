"""Official advertised CryptoJobsList RSS, without API keys or account access."""
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from xml.etree import ElementTree as ET

from freelance.modules.discovery.public import qualify_for_intake
from freelance.modules.collection.public_feeds import NoRedirect, published, text
from freelance.modules.collection.ptt_soho import read_body

FEED = 'https://api.cryptojobslist.com/jobs.rss'
MEDIA = '{http://search.yahoo.com/mrss/}'


def canonical(value):
    if not isinstance(value, str): raise ValueError('Missing job URL')
    url = urlsplit(value)
    if url.scheme != 'https' or url.netloc != 'cryptojobslist.com' or not re.fullmatch(r'/jobs/[a-z0-9][a-z0-9-]+', url.path):
        raise ValueError('Invalid job URL')
    return url._replace(query='', fragment='').geturl()


class Tags(HTMLParser):
    """Read only the feed's initial Tags paragraph, not links inside employer text."""
    def __init__(self):
        super().__init__(); self.paragraph = False; self.started = False; self.done = False; self.tags = set(); self.label = False
    def handle_starttag(self, tag, attrs):
        if tag == 'p' and not self.started:
            self.started = True; self.paragraph = True
        if tag in ('h2', 'h3') or (tag == 'p' and self.done): self.paragraph = False
        if tag == 'a' and self.paragraph and self.label:
            url = urlsplit(dict(attrs).get('href', ''))
            if url.scheme == 'https' and url.netloc == 'cryptojobslist.com': self.tags.add(url.path.strip('/'))
    def handle_data(self, data):
        if self.paragraph and data.strip().startswith('Tags:'): self.label = True
    def handle_endtag(self, tag):
        if tag == 'p': self.paragraph = False; self.done = True


def normalize(item, observed_at):
    url = canonical(item.findtext('link'))
    advertised = item.findtext(MEDIA + 'canonical')
    if advertised and canonical(advertised) != url: raise ValueError('Canonical mismatch')
    title = text(item.findtext('title')); html = item.findtext('description'); body = text(html)
    if len(title) > 500 or len(body) > 100_000: raise ValueError('Oversize listing')
    parser = Tags(); parser.feed(html); parser.close(); tags = sorted(parser.tags)
    # "contract" is also used for smart-contract engineering; it is not an employment type.
    kind = 'full_time' if 'full-time' in tags else 'contract' if set(tags) & {'part-time', 'freelance'} else None
    location = (item.findtext(MEDIA + 'location') or '').strip() or None
    regional = bool(re.search(r'\b(?:US only|USA only|United States|Europe only|UK only)\b', location or '', re.I))
    publication = item.findtext('pubDate')
    date = published(publication).isoformat() if publication else None
    job = dict(source='cryptojobslist', external_id=url, title=title, description=body, url=url, canonical_url=url,
               attribution='CryptoJobsList', kind=kind, employment_tags=tags, published_at=date,
               publication_evidence='RSS pubDate' if date else 'RSS omits job publication date',
               location_evidence=location, remote_evidence='remote' in tags or bool(re.search(r'\bremote\b', location or '', re.I)),
               taiwan_eligible=False if regional else None, timezone_compatible=None, weekly_hours=None,
               deadline=None, currency=None, budget_min=None, budget_max=None, free_apply=None,
               language='en', complete=False, body_available=True)
    fingerprint = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return job | {'received_at': observed_at.isoformat(), 'receipt_id': 'cryptojobslist:' + fingerprint}


def parse(raw, *, now=None):
    if not isinstance(raw, bytes) or not raw or len(raw) > 2_000_000: raise ValueError('Invalid RSS')
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', raw, re.I): raise ValueError('XML declarations forbidden')
    root = ET.fromstring(raw)
    if root.tag != 'rss' or root.find('channel') is None: raise ValueError('Expected RSS channel')
    items = root.findall('./channel/item')
    if not items or len(items) > 2000: raise ValueError('Invalid RSS item count')
    jobs = {}; rejected = 0; now = now or datetime.now(timezone.utc)
    for item in items:
        try:
            job = normalize(item, now); jobs[job['external_id']] = job
        except (ValueError, TypeError, AttributeError): rejected += 1
    return dict(jobs=list(jobs.values()), seen=len(items), rejected_count=rejected, complete_scan=False,
                scope='official_rss_window_no_job_dates', feed_built_at=root.findtext('./channel/lastBuildDate'))


def fetch():
    deadline = time.monotonic() + 25
    req = Request(FEED, headers={'User-Agent': 'freelance-agent/0.1 personal-job-discovery', 'Accept': 'application/rss+xml'})
    with build_opener(NoRedirect()).open(req, timeout=15) as response:
        if response.status != 200: raise ValueError('RSS unavailable')
        return parse(read_body(response, deadline))


def sync(store, *, reader=fetch):
    try:
        store.set_source_health('cryptojobslist', 'failed'); result = reader(); count = 0
        with store.source_batch('cryptojobslist') as batch:
            existing = batch.existing_ids()
            for job in result['jobs']:
                if job['external_id'] in existing or (job['remote_evidence'] and job['kind'] == 'contract' and qualify_for_intake(job, now=store.clock())['status'] != 'excluded'):
                    batch.ingest(job, receipt_id=job['receipt_id']); count += 1
            batch.finish('failed' if result['rejected_count'] else 'ok')
        return {k:v for k,v in result.items() if k != 'jobs'} | {'jobs': count, 'status': 'partial' if result['rejected_count'] else 'ok'}
    except Exception:
        return {'status': 'failed', 'reason': 'cryptojobslist_unavailable_or_unsupported'}
