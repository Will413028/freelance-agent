"""Observed 104 matching digest cards; no website requests or recommendation guessing."""
from datetime import datetime
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
from urllib.parse import urlsplit

from freelance.modules.collection.mail import MailParseError

SENDER = 'jobbank@ms1.104.com.tw'


class Cards(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.anchor = None
        self.label = []
        self.cards = []
        self.current = None
        self.stopped = False

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            if self.anchor is not None:
                raise MailParseError('Nested 104 links')
            self.anchor = dict(attrs).get('href', '')
            self.label = []

    def handle_data(self, value):
        value = value.strip()
        if not value:
            return
        if self.anchor is not None:
            self.label.append(value)
        elif value == '適合你大展身手的工作':
            self.stopped = True
        elif self.current is not None and not self.stopped:
            self.current['parts'].append(value)

    def handle_endtag(self, tag):
        if tag != 'a' or self.anchor is None:
            return
        label = ' '.join(self.label)
        try:
            url = urlsplit(self.anchor)
        except ValueError:
            raise MailParseError('Invalid 104 link') from None
        self.anchor = None
        if self.stopped:
            return
        match = re.fullmatch(r'/job/([a-z0-9]+)', url.path)
        if match:
            if url.scheme != 'https' or url.netloc != 'www.104.com.tw' or not label:
                raise MailParseError('Unsupported 104 job link')
            if self.current is not None:
                raise MailParseError('Incomplete 104 card')
            self.current = dict(external_id=match[1], title=label,
                                url='https://www.104.com.tw' + url.path, parts=[])
        elif self.current is not None:
            if url.scheme == 'https' and url.netloc == 'www.104.com.tw' and re.fullmatch(r'/company/[a-z0-9]+', url.path):
                if self.current.get('company') or not label:
                    raise MailParseError('Ambiguous 104 company')
                self.current['company'] = label
            elif url.scheme == 'https' and url.netloc == '104app.onelink.me' and url.path == '/zB8j/apply' and label == '我要應徵':
                self.cards.append(self.current)
                self.current = None


def parse_104(message):
    match = re.fullmatch(r'.{1,100}\d{2}/\d{2}的配對日報，符合職缺(\d{1,3})筆', message.subject)
    if message.sender.casefold() != SENDER or not message.is_html or not match or not isinstance(message.body, str):
        raise MailParseError('Unsupported 104 notification')
    try:
        received = datetime.fromisoformat(message.received_at.replace('Z', '+00:00'))
        if received.tzinfo is None or len(message.body.encode()) > 1_000_000:
            raise ValueError()
    except (ValueError, AttributeError):
        raise MailParseError('Invalid 104 notification') from None
    parser = Cards(); parser.feed(message.body); parser.close()
    if (not parser.stopped or parser.current is not None or parser.anchor is not None
            or len(parser.cards) != int(match[1]) or not parser.cards):
        raise MailParseError('Incomplete 104 matching digest')
    jobs, seen = [], set()
    for card in parser.cards:
        if not card.get('company') or not card['parts'] or card['external_id'] in seen:
            raise MailParseError('Invalid or duplicate 104 card')
        seen.add(card['external_id'])
        title = card['title']
        kind = ('full_time' if re.search(r'全職|\bfull[ -]time\b', title, re.I) else
                'contract' if re.search(r'兼職|接案|\b(?:part[ -]time|freelance)\b', title, re.I) else None)
        job = dict(source='jobbank104', external_id=card['external_id'], title=title,
                   company=card['company'], url=card['url'], canonical_url=card['url'],
                   description='\n'.join(card['parts']), kind=kind, complete=False,
                   body_available=False, language='zh-TW', taiwan_eligible=None,
                   timezone_compatible=None, weekly_hours=None, currency=None,
                   budget_min=None, budget_max=None, deadline=None, published_at=None)
        receipt = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        jobs.append(job | dict(received_at=received.isoformat(), receipt_id='jobbank104:' + receipt))
    return jobs
