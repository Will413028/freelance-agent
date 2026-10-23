"""Parser for the single-listing Tasker notification template observed in 2026-09."""
from html.parser import HTMLParser
import re
from urllib.parse import urlsplit
from freelance.modules.collection.mail import MailMessage, MailParseError, parse_message


class TaskerParseError(ValueError):
    """Unsupported notifications are failures, never empty source success."""


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chunks = []
        self.links = []
        self.hidden = []
        self.anchor = None
        self.cta_starts = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'template'):
            self.hidden.append(tag)
        if self.hidden:
            return
        if tag == 'a':
            hrefs = [v for k, v in attrs if k == 'href' and v]
            self.links.extend(hrefs)
            self.anchor = (len(self.chunks), hrefs)
        if tag in ('p', 'div', 'br', 'tr', 'td', 'h1', 'h2', 'h3', 'li'):
            self.chunks.append('\n')

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
            return
        if tag == 'a' and self.anchor is not None:
            start, hrefs = self.anchor
            label = _clean(''.join(self.chunks[start:]))
            if label.startswith('查看完整資訊') and len(hrefs) == 1 and _canonical(hrefs[0]):
                self.cta_starts.append(start)
            self.anchor = None
        if tag in ('p', 'div', 'tr', 'td', 'h1', 'h2', 'h3', 'li'):
            self.chunks.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.chunks.append(data)


def _canonical(url):
    try:
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != 'www.tasker.com.tw':
            return None
        if not re.fullmatch(r'/cases/[A-Za-z0-9]+', parsed.path):
            return None
        return 'https://www.tasker.com.tw' + parsed.path
    except ValueError:
        return None


def _clean(text):
    # URLs may appear as visible pasted text, not just HTML attributes.
    text = re.sub(r'(?:[a-zA-Z][a-zA-Z0-9+.-]*://|//|www\.|mailto:|tel:)[^\s<>]+', '', text)
    return ' '.join(text.split())


def parse_tasker(message):
    try:
        mail = message if isinstance(message, MailMessage) else parse_message(message)
    except MailParseError:
        raise TaskerParseError('Malformed Tasker source message') from None
    if mail.sender != 'deals@tasker.com.tw':
        raise TaskerParseError('Unverified Tasker sender')
    if mail.is_html:
        parser = _Text()
        parser.feed(mail.body)
        links = parser.links
        if len(parser.cta_starts) != 1:
            raise TaskerParseError('Unsupported Tasker demand boundary')
        text = ''.join(parser.chunks[:parser.cta_starts[0]])
    else:
        text = mail.body
        links = re.findall(r'https?://[^\s<>]+', text)
        boundaries = [m for m in re.finditer(r'^[ \t]*查看完整資訊[ \t]+(https://[^\s<>]+)[ \t]*$', text, re.MULTILINE) if _canonical(m.group(1))]
        if len(boundaries) != 1:
            raise TaskerParseError('Unsupported Tasker demand boundary')
        text = text[:boundaries[0].start()]
    urls = {_canonical(link) for link in links} - {None}
    if len(urls) != 1:
        raise TaskerParseError('Unsupported Tasker listing count or case URL')
    titles = re.findall(r'【([^【】]+)】', mail.subject)
    if len(titles) != 1:
        raise TaskerParseError('Unsupported Tasker subject template')
    title = _clean(titles[0])
    normalized = _clean(text)
    header = re.search(r'\d{4}/\d{2}/\d{2}\s*(?:最新案件，限時搶先提案！|最新上架案件，歡迎提案)\s*' + re.escape(title) + r'\s*(?:(\$[\d,]+)|預算詳談)(.*?)需求說明\s*(.*?)\s*$', normalized)
    if not title or not header or not header.group(3).strip():
        raise TaskerParseError('Unsupported Tasker body template')
    url, = urls
    external_id = url.rsplit('/', 1)[1]
    return [{
        'source': 'tasker', 'external_id': external_id, 'canonical_url': url, 'url': url,
        'receipt_id': f'{mail.message_id}:{external_id}', 'received_at': mail.received_at,
        'title': title, 'description': header.group(3).strip(),
        'observed_amount': header.group(1), 'language': 'zh-TW', 'complete': False,
        'kind': None, 'currency': None, 'budget_min': None, 'budget_max': None,
        'weekly_hours': None, 'taiwan_eligible': None, 'timezone_compatible': None,
        'deadline': None,
    }]
