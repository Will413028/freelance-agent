"""Observed Talent.com related-job email cards; offline, summary-only.

The legacy hexadecimal ID resolves through the public /view endpoint. Keep
that source identity; do not guess the numeric ID returned by the website.
"""
from datetime import datetime
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
from urllib.parse import parse_qs, urlsplit

from freelance.modules.collection.mail import MailParseError

SENDER = 'no-reply@alerts.talent.com'
FIELDS = ('Title', 'Location', 'Company', 'Salary', 'Description')


def subject_format(subject):
    if not isinstance(subject, str):
        return None
    if re.fullmatch(r'更多职位，例如.{1,500}', subject):
        return 'described'
    if re.fullmatch(r"software engineer(?: - [^\r\n]{1,200})? jobs you don't want to miss",
                    subject, re.I):
        return 'card_only'
    return None


def canonical(value):
    try:
        if not isinstance(value, str) or len(value) > 8192:
            raise ValueError()
        url = urlsplit(value)
        query = parse_qs(url.query, keep_blank_values=True, max_num_fields=30)
        ids = query.get('id', [])
        if (url.scheme != 'https' or url.netloc != 'tw.talent.com'
                or url.path != '/redirect' or url.fragment or len(ids) != 1
                or not re.fullmatch(r'[a-f0-9]{12}', ids[0])):
            raise ValueError()
        return ids[0], 'https://tw.talent.com/view?id=' + ids[0]
    except (ValueError, TypeError):
        raise MailParseError('Unsupported Talent job link') from None


class Cards(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.current = None
        self.stage = -1
        self.cards = []
        self.links = 0

    def handle_comment(self, value):
        value = value.strip()
        if value not in FIELDS:
            return
        stage = FIELDS.index(value)
        if stage == 0:
            if self.current is not None or self.depth != 1:
                raise MailParseError('Malformed Talent card boundary')
            self.current = {key: [] for key in FIELDS}
            self.stage, self.links = -1, 0
        if self.current is None or stage != self.stage + 1:
            raise MailParseError('Missing or reordered Talent fields')
        self.stage = stage

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            self.depth += 1
            if 'job__link' in attrs.get('class', '').split():
                if self.current is None or self.stage != 0 or self.links:
                    raise MailParseError('Unexpected Talent job link')
                self.current['identity'] = canonical(attrs.get('href'))
                self.links += 1

    def handle_data(self, value):
        if self.current is not None:
            self.current[FIELDS[self.stage]].append(value)

    def handle_endtag(self, tag):
        if tag != 'a':
            return
        self.depth -= 1
        if self.depth < 0:
            raise MailParseError('Unbalanced Talent links')
        if self.current is not None and self.depth == 0:
            if self.stage != 4 or self.links != 1:
                raise MailParseError('Incomplete Talent card')
            card = {key: ' '.join(''.join(self.current[key]).split()) for key in FIELDS}
            if any(not card[key] for key in ('Title', 'Location', 'Company', 'Description')):
                raise MailParseError('Empty Talent card')
            card['identity'] = self.current['identity']
            self.cards.append(card)
            self.current = None


class CardOnlyCards(HTMLParser):
    """The observed English alert has two matching links and three fields per card."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.section = 0
        self.tr_depth = 0
        self.link_depth = 0
        self.title_row_depth = None
        self.stage = None
        self.current = None
        self.cards = []

    def handle_comment(self, value):
        marker = value.strip()
        if marker == 'Job cards':
            if self.section:
                raise MailParseError('Duplicate Talent card section')
            self.section = 1
        elif marker == 'View more jobs button' and self.section == 1:
            if self.current is not None or self.link_depth or self.tr_depth:
                raise MailParseError('Incomplete Talent card section')
            self.section = 2

    def handle_starttag(self, tag, attrs):
        if self.section != 1:
            return
        if tag == 'tr':
            self.tr_depth += 1
        elif tag == 'a':
            identity = canonical(dict(attrs).get('href'))
            if self.link_depth == 0:
                self.current = {'identity': identity, 'Title': [], 'Location': [], 'Company': []}
                self.stage = 'await_title'
                self.link_depth = 1
            elif self.link_depth == 1 and self.stage == 'await_title' and identity == self.current['identity']:
                self.title_row_depth = self.tr_depth
                self.stage = 'title'
                self.link_depth = 2
            else:
                raise MailParseError('Unexpected Talent card link')

    def handle_data(self, value):
        if self.section != 1 or self.current is None:
            return
        if self.stage == 'title' and self.link_depth == 2:
            self.current['Title'].append(value)
        elif (self.link_depth == 1 and self.tr_depth == self.title_row_depth
              and self.stage in ('location', 'company')):
            self.current[self.stage.title()].append(value)

    def handle_endtag(self, tag):
        if self.section != 1:
            return
        if tag == 'tr':
            if self.tr_depth < 1:
                raise MailParseError('Unbalanced Talent card rows')
            if self.current is not None and self.link_depth == 1 and self.tr_depth == self.title_row_depth:
                if self.stage == 'title_row':
                    self.stage = 'location'
                elif self.stage == 'location':
                    self.stage = 'company'
                elif self.stage == 'company':
                    self.stage = 'done'
            self.tr_depth -= 1
        elif tag == 'a':
            if self.link_depth == 2 and self.stage == 'title':
                self.link_depth = 1
                self.stage = 'title_row'
            elif self.link_depth == 1 and self.stage == 'done':
                card = {key: ' '.join(''.join(self.current[key]).split())
                        for key in ('Title', 'Location', 'Company')}
                if not card['Title']:
                    raise MailParseError('Empty Talent card title')
                card['identity'] = self.current['identity']
                self.cards.append(card)
                self.current = None
                self.link_depth = 0
                self.title_row_depth = None
                self.stage = None
            else:
                raise MailParseError('Incomplete Talent card')


def parse_talent(message):
    template = subject_format(message.subject)
    if (message.sender.casefold() != SENDER or not message.is_html
            or template is None
            or not isinstance(message.body, str) or len(message.body.encode()) > 1_000_000):
        raise MailParseError('Unsupported Talent notification')
    try:
        received = datetime.fromisoformat(message.received_at.replace('Z', '+00:00'))
        if received.tzinfo is None:
            raise ValueError()
    except (ValueError, AttributeError):
        raise MailParseError('Invalid Talent timestamp') from None
    parser = Cards() if template == 'described' else CardOnlyCards()
    parser.feed(message.body); parser.close()
    if ((template == 'described' and parser.depth)
            or (template == 'card_only' and (parser.section != 2 or parser.link_depth or parser.tr_depth))
            or parser.current is not None or not 1 <= len(parser.cards) <= 100):
        raise MailParseError('Incomplete Talent notification')
    jobs, seen = [], set()
    for card in parser.cards:
        identity, url = card['identity']
        if identity in seen:
            raise MailParseError('Duplicate Talent card')
        seen.add(identity)
        description = (card['Description'] if template == 'described' else
                       'Talent.com notification card only: ' +
                       '\n'.join(value for value in (card['Title'], card['Company'], card['Location']) if value))
        evidence = card['Title'] + ('\n' + card['Description'] if template == 'described' else '')
        kind = ('full_time' if re.search(r'全職|\bfull[ -]time\b', evidence, re.I) else
                'contract' if re.search(r'兼職|接案|\b(?:contractor|contract|freelance|part[ -]time)\b', evidence, re.I) else None)
        job = dict(source='talent', external_id=identity, url=url, canonical_url=url,
                   title=card['Title'], company=card['Company'] or None, location=card['Location'] or None,
                   description=description, salary_text=card.get('Salary'), kind=kind,
                   complete=False, body_available=False, language='en',
                   taiwan_eligible=None, timezone_compatible=None, weekly_hours=None,
                   currency=None, budget_min=None, budget_max=None, deadline=None, published_at=None)
        receipt = sha256(json.dumps(job, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        jobs.append(job | dict(received_at=received.isoformat(), receipt_id='talent:' + receipt))
    return jobs
