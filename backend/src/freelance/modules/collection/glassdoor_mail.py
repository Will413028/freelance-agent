"""Observed Glassdoor alerts; summary cards never imply full job evidence."""
from datetime import datetime
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
from urllib.parse import parse_qs, urlsplit

from freelance.modules.collection.mail import MailParseError

SENDER = 'noreply@glassdoor.com'
SUBJECT = r'All the top jobs for .{1,500}\. Ready to apply\?'


def is_job_subject(value):
    return isinstance(value, str) and bool(re.fullmatch(SUBJECT, value) or re.fullmatch(
        r'.{1,200} at .{1,200} and \d{1,3} more jobs in .{1,200} for you\. Apply Now\.', value))


def canonical(value):
    try:
        if not isinstance(value, str) or len(value) > 8192:
            raise ValueError()
        url = urlsplit(value)
        query = parse_qs(url.query, keep_blank_values=True, max_num_fields=50)
        ids = query.get('jobListingId', [])
        if (url.scheme != 'https' or url.netloc != 'www.glassdoor.com'
                or url.path != '/partner/jobListing.htm' or url.fragment
                or len(ids) != 1 or not re.fullmatch(r'[0-9]{10,20}', ids[0])):
            raise ValueError()
        return ids[0], 'https://www.glassdoor.com/partner/jobListing.htm?jobListingId=' + ids[0]
    except (ValueError, TypeError):
        raise MailParseError('Unsupported Glassdoor listing link') from None


class Cards(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = None
        self.spans = 0
        self.paragraph = None
        self.cards = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            if self.current is not None:
                raise MailParseError('Nested Glassdoor listing link')
            href = attrs.get('href', '')
            if 'jobListing' in href:
                identity, url = canonical(href)
                self.current = {'job_id': identity, 'source_url': url,
                                'company_parts': [], 'paragraphs': []}
        elif self.current is not None:
            if tag in ('script', 'style'):
                raise MailParseError('Unexpected Glassdoor card content')
            if tag == 'span':
                self.spans += 1
            if tag == 'p':
                if self.paragraph is not None:
                    raise MailParseError('Nested Glassdoor paragraph')
                self.paragraph = []

    def handle_data(self, value):
        if self.current is None:
            return
        if self.paragraph is not None:
            self.paragraph.append(value)
        elif self.spans:
            self.current['company_parts'].append(value)
        elif value.strip():
            raise MailParseError('Unexpected Glassdoor card text')

    def handle_endtag(self, tag):
        if self.current is None:
            return
        if tag == 'span':
            self.spans -= 1
            if self.spans < 0:
                raise MailParseError('Unbalanced Glassdoor company field')
        elif tag == 'p':
            if self.paragraph is None:
                raise MailParseError('Unbalanced Glassdoor paragraph')
            self.current['paragraphs'].append(' '.join(''.join(self.paragraph).split()))
            self.paragraph = None
        elif tag == 'a':
            company = ' '.join(''.join(self.current.pop('company_parts')).split())
            paragraphs = self.current.pop('paragraphs')
            if (self.spans or self.paragraph is not None or not company
                    or len(company) > 500 or len(paragraphs) not in (2, 3)
                    or not paragraphs[0] or len(paragraphs[0]) > 1000
                    or (len(paragraphs) == 3 and paragraphs[1] != 'Easy Apply')
                    or not re.fullmatch(r'(?:\d{1,3}[dh]|Just posted)', paragraphs[-1])):
                raise MailParseError('Incomplete Glassdoor card')
            self.cards.append(self.current | dict(company=company, title=paragraphs[0],
                relative_date=paragraphs[-1], easy_apply=len(paragraphs) == 3,
                kind=None, taiwan_eligible=None, remote=None, body_available=False))
            self.current = None
            if len(self.cards) > 100:
                raise MailParseError('Too many Glassdoor cards')


def inspect_glassdoor(message):
    if (message.sender.casefold() != SENDER or not message.is_html
            or not is_job_subject(message.subject)
            or not isinstance(message.body, str) or len(message.body.encode()) > 1_000_000):
        raise MailParseError('Unsupported Glassdoor notification')
    try:
        received = datetime.fromisoformat(message.received_at.replace('Z', '+00:00'))
        if received.tzinfo is None:
            raise ValueError()
    except (ValueError, AttributeError):
        raise MailParseError('Invalid Glassdoor timestamp') from None
    parser = Cards()
    parser.feed(message.body)
    parser.close()
    if parser.current is not None or not parser.cards:
        raise MailParseError('Incomplete Glassdoor notification')
    if len({card['job_id'] for card in parser.cards}) != len(parser.cards):
        raise MailParseError('Duplicate Glassdoor listing')
    return dict(source='glassdoor', status='sample_verified_detail_blocked',
                reason='listing_destination_unverified', ingestible=False,
                count=len(parser.cards), complete_scan=False, cards=parser.cards)


def parse_glassdoor(message):
    """Use verified listing identity; relative age is not a publication date."""
    cards = inspect_glassdoor(message)['cards']
    jobs = []
    for card in cards:
        title = card['title']
        kind = ('full_time' if re.search(r'全職|\bfull[ -]time\b', title, re.I) else
                'contract' if re.search(r'兼職|接案|\b(?:contractor|contract|freelance|part[ -]time)\b', title, re.I) else None)
        job = dict(source='glassdoor', external_id=card['job_id'],
                   url=card['source_url'], canonical_url=card['source_url'],
                   title=title, company=card['company'], location=None,
                   description='Glassdoor notification card only: ' + title + '\n' + card['company'],
                   salary_text=None, kind=kind, complete=False, body_available=False,
                   language='en', taiwan_eligible=None, timezone_compatible=None,
                   weekly_hours=None, currency=None, budget_min=None, budget_max=None,
                   deadline=None, published_at=None)
        receipt = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        jobs.append(job | dict(received_at=message.received_at, receipt_id='glassdoor:' + receipt))
    return jobs
