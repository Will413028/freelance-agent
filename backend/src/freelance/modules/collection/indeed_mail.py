"""Offline Indeed notification inspection and summary-card parsing.

The legacy inspector remains non-ingestible. New bordered cards require
verified sender/subject and jk identities; one unsupported card
rejects the whole notification. No network or tracking links are followed.
"""
from datetime import datetime
from html.parser import HTMLParser
import re
from urllib.parse import urlsplit

from freelance.modules.collection.mail import MailParseError

SENDER = 'donotreply@jobalert.indeed.com'
FIELDS = {'r-e': 'title', 'r-g': 'company', 'r-h': 'location',
          'r-i': 'summary', 'r-j': 'relative_date', 'r-k': 'salary_text'}


class Cards(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []
        self.current = None
        self.field = None
        self.field_tag = None
        self.text = []
        self.links = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        fields = set(attrs.get('class', '').split()) & FIELDS.keys()
        if fields:
            if len(fields) != 1 or self.field:
                raise MailParseError('Ambiguous Indeed fields')
            field = FIELDS[fields.pop()]
            if field == 'title':
                if self.current is not None:
                    self.finish_card()
                self.current = {}
                self.links = 0
            if self.current is None or field in self.current:
                raise MailParseError('Incomplete Indeed card')
            self.field, self.field_tag, self.text = field, tag, []
        if tag == 'a' and self.field == 'title':
            try:
                url = urlsplit(attrs.get('href', ''))
                valid = (url.scheme == 'https' and url.netloc == 'engage.indeed.com'
                         and url.path.startswith('/f/a/') and not url.fragment)
            except ValueError:
                valid = False
            if not valid:
                raise MailParseError('Unrecognized Indeed title link')
            self.links += 1

    def handle_data(self, value):
        if self.field:
            self.text.append(value)

    def handle_endtag(self, tag):
        if self.field and tag == self.field_tag:
            value = ' '.join(''.join(self.text).split())
            if not value or len(value) > 10000:
                raise MailParseError('Invalid Indeed field')
            self.current[self.field] = value
            self.field = self.field_tag = None

    def finish_card(self):
        if self.field or self.links != 1 or not all(self.current.get(k) for k in
                ('title', 'company', 'location', 'summary', 'relative_date')):
            raise MailParseError('Incomplete Indeed card')
        self.cards.append(self.current)
        if len(self.cards) > 100:
            raise MailParseError('Too many Indeed cards')
        self.current = None


def inspect_indeed(message, *, list_id, expected_list_id):
    """Return summary-only inspection; caller supplies trusted routing metadata."""
    if (not re.fullmatch(r'jobalert\.[a-f0-9]{24}\.indeed\.com', expected_list_id)
            or list_id != expected_list_id or message.sender.casefold() != SENDER
            or not message.is_html or not isinstance(message.body, str)
            or len(message.body.encode()) > 1_000_000):
        raise MailParseError('Unsupported Indeed notification')
    try:
        received = datetime.fromisoformat(message.received_at.replace('Z', '+00:00'))
        if received.tzinfo is None:
            raise ValueError()
    except (ValueError, AttributeError):
        raise MailParseError('Invalid Indeed timestamp') from None
    parser = Cards()
    parser.feed(message.body)
    parser.close()
    if parser.current is not None:
        parser.finish_card()
    if not parser.cards:
        raise MailParseError('No Indeed cards')
    return {'status': 'blocked', 'reason': 'stable_job_url_unverified',
            'ingestible': False, 'cards': parser.cards,
            'complete_scan': False, 'body_available': False}


def _listing(value):
    from urllib.parse import parse_qs
    try:
        url = urlsplit(value)
        query = parse_qs(url.query, keep_blank_values=True, max_num_fields=50)
        ids = query.get('jk', [])
        if (len(value) > 8192 or url.scheme != 'https' or url.netloc != 'tw.indeed.com'
                or url.path != '/rc/clk/dl' or url.fragment or len(ids) != 1
                or not re.fullmatch(r'[a-f0-9]{16}', ids[0])):
            raise ValueError()
        return ids[0], 'https://tw.indeed.com/rc/clk/dl?jk=' + ids[0]
    except (ValueError, TypeError):
        raise MailParseError('Unsupported Indeed listing identity') from None


class NotificationCards(HTMLParser):
    """Read the observed bordered table cards; reject one bad card atomically."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = 0
        self.boundary = None
        self.current = None
        self.field = None
        self.parts = []
        self.cards = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'table':
            self.tables += 1
            if 'width-100' in attrs.get('class', '').split() and 'border-radius:20px' in attrs.get('style', ''):
                if self.current is not None:
                    raise MailParseError('Nested Indeed card')
                self.boundary = self.tables
                self.current = {'paragraphs': []}
        if self.current is None:
            return
        if tag in ('script', 'style'):
            raise MailParseError('Unexpected Indeed card content')
        if tag == 'a' and 'strong-text-link' in attrs.get('class', '').split():
            if 'identity' in self.current or self.field:
                raise MailParseError('Ambiguous Indeed title')
            self.current['identity'] = _listing(attrs.get('href', ''))
            self.field, self.parts = 'a', []
        elif tag == 'p':
            if self.field:
                raise MailParseError('Nested Indeed field')
            self.field, self.parts = 'p', []

    def handle_data(self, value):
        if self.field:
            self.parts.append(value)

    def handle_endtag(self, tag):
        if self.current is not None:
            if tag == self.field:
                value = ' '.join(''.join(self.parts).split())
                if not value or len(value) > 1000:
                    raise MailParseError('Invalid Indeed card field')
                if tag == 'a':
                    self.current['title'] = value
                else:
                    self.current['paragraphs'].append(value)
                self.field, self.parts = None, []
            if tag == 'table' and self.tables == self.boundary:
                fields = self.current.pop('paragraphs')
                if (self.field or not self.current.get('title') or len(fields) < 3
                        or not re.fullmatch(r'(?:\d{1,3}天前|剛才發佈)', fields[-1])):
                    raise MailParseError('Incomplete Indeed card')
                salary = None
                for badge in fields[2:-1]:
                    if badge == '輕鬆申請':
                        continue
                    if salary is None and re.fullmatch(r'(?:月薪|時薪|年薪) NT\$[\d,]+(?: - NT\$[\d,]+)?(?: 起)?', badge):
                        salary = badge
                    else:
                        raise MailParseError('Unrecognized Indeed card field')
                self.cards.append(self.current | dict(company=fields[0], location=fields[1], salary_text=salary))
                self.current, self.boundary = None, None
                if len(self.cards) > 100:
                    raise MailParseError('Too many Indeed cards')
        if tag == 'table':
            self.tables -= 1
            if self.tables < 0:
                raise MailParseError('Unbalanced Indeed tables')


def is_job_subject(subject):
    return isinstance(subject, str) and bool(re.fullmatch(r'.{1,500} 的 .{1,500}。.{1,200} 的另外 \d{1,3} 個 .{1,500} 職缺', subject))


def parse_indeed(message):
    """Offline only: verified sender/subject; unsupported ads quarantine the mail."""
    from hashlib import sha256
    import json
    if (message.sender.casefold() != SENDER
            or not message.is_html or not isinstance(message.body, str)
            or len(message.body.encode()) > 1_000_000
            or not is_job_subject(message.subject)):
        raise MailParseError('Unsupported Indeed notification')
    try:
        received = datetime.fromisoformat(message.received_at.replace('Z', '+00:00'))
        if received.tzinfo is None:
            raise ValueError()
    except (ValueError, AttributeError):
        raise MailParseError('Invalid Indeed timestamp') from None
    parser = NotificationCards()
    parser.feed(message.body)
    parser.close()
    if parser.current is not None or parser.field or parser.tables or not parser.cards:
        raise MailParseError('Incomplete Indeed notification')
    jobs, seen = [], set()
    for card in parser.cards:
        identity, url = card['identity']
        if identity in seen:
            raise MailParseError('Duplicate Indeed listing')
        seen.add(identity)
        title = card['title']
        kind = ('full_time' if re.search(r'全職|\bfull[ -]time\b', title, re.I) else
                'contract' if re.search(r'兼職|接案|\b(?:contractor|contract|freelance|part[ -]time)\b', title, re.I) else None)
        job = dict(source='indeed', external_id=identity, url=url, canonical_url=url,
                   title=title, company=card['company'], location=card['location'],
                   description='Indeed notification card only: ' + '\n'.join((title, card['company'], card['location'])),
                   salary_text=card['salary_text'], kind=kind, complete=False, body_available=False,
                   language='zh', taiwan_eligible=None, timezone_compatible=None, weekly_hours=None,
                   currency=None, budget_min=None, budget_max=None, deadline=None, published_at=None)
        receipt = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        jobs.append(job | dict(received_at=received.isoformat(), receipt_id='indeed:' + receipt))
    return jobs
