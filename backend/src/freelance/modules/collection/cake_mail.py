"""Parse observed Cake followed-company notifications without visiting trackers."""
import base64
import binascii
from datetime import datetime
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
from urllib.parse import parse_qs, urlsplit
import zlib

from freelance.modules.collection.mail import MailParseError

SENDER = 'notifications@no-reply.cake.me'


def canonical(value):
    try:
        if not isinstance(value, str) or len(value) > 8192:
            raise ValueError()
        url = urlsplit(value)
        if url.scheme != 'https':
            raise ValueError()
        if url.netloc == 'email.no-reply.cake.me':
            match = re.fullmatch(r'/c/([A-Za-z0-9_-]{1,8192})', url.path)
            if not match or url.query or url.fragment:
                raise ValueError()
            token = match[1]
            compressed = base64.b64decode(token + '=' * (-len(token) % 4), altchars=b'-_', validate=True)
            decoder = zlib.decompressobj()
            raw = decoder.decompress(compressed, 8193)
            if len(raw) > 8192 or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise ValueError()
            params = parse_qs(raw.decode('utf-8'), strict_parsing=True, max_num_fields=20)
            if len(params.get('l', [])) != 1:
                raise ValueError()
            url = urlsplit(params['l'][0])
        if (url.scheme != 'https' or url.netloc not in ('www.cake.me', 'cake.me')
                or not re.fullmatch(r'/companies/[A-Za-z0-9_-]+/jobs/[A-Za-z0-9_-]+/?', url.path)):
            raise ValueError()
        return 'https://www.cake.me' + url.path.rstrip('/')
    except (ValueError, TypeError, UnicodeError, zlib.error, binascii.Error):
        raise MailParseError('Unsupported Cake job link') from None


class Details(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.href = None
        self.label = []
        self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            if self.href is not None:
                raise MailParseError('Nested Cake notification links')
            self.href = dict(attrs).get('href', '')
            self.label = []

    def handle_data(self, data):
        if self.href is not None:
            self.label.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self.href is not None:
            if ''.join(self.label).strip() == '了解詳情':
                self.urls.append(canonical(self.href))
            self.href = None
            self.label = []


def parse_cake(message):
    if message.sender.casefold() != SENDER or not message.is_html:
        raise MailParseError('Expected Cake HTML notification')
    match = re.fullmatch(r'您追蹤的 (.{1,300}?) 刊登了一筆新職缺 - (.{1,500})', message.subject)
    if not match or not isinstance(message.body, str) or len(message.body.encode()) > 1_000_000:
        raise MailParseError('Unsupported Cake notification template')
    try:
        received = datetime.fromisoformat(message.received_at.replace('Z', '+00:00'))
        if received.tzinfo is None:
            raise ValueError()
    except (ValueError, AttributeError):
        raise MailParseError('Invalid Cake notification timestamp') from None
    parser = Details(); parser.feed(message.body); parser.close()
    urls = set(parser.urls)
    if len(urls) != 1 or parser.href is not None:
        raise MailParseError('Missing or ambiguous Cake job link')
    url = urls.pop()
    company, title = match.groups()
    kind = ('full_time' if re.search(r'全職|\bfull[ -]time\b', title, re.I) else
            'contract' if re.search(r'兼職|接案|\b(?:freelance|part[ -]time|contract)\b', title, re.I) else None)
    job = dict(source='cake', external_id=url, url=url, canonical_url=url, title=title,
               company=company, description='Cake 新職缺通知摘要：' + title + '\n' + company,
               kind=kind, taiwan_eligible=None, timezone_compatible=None, weekly_hours=None,
               budget_min=None, budget_max=None, currency=None, deadline=None, published_at=None,
               complete=False, body_available=False, language='zh-TW')
    receipt = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return [job | {'received_at': received.isoformat(), 'receipt_id': 'cake:' + receipt}]
