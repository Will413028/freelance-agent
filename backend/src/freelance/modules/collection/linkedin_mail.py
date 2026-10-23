"""Offline parser for observed English LinkedIn job-alert text MIME bodies.

No website fetches, redirects, mailbox access, or automatic applications.
Only metadata is available; callers must not treat these cards as full listings.
"""
from datetime import datetime
from hashlib import sha256
import json
import re
from urllib.parse import urlsplit

from freelance.modules.collection.mail import MailParseError

SENDER = 'jobalerts-noreply@linkedin.com'


def is_administrative_notice(subject):
    return bool(re.fullmatch(r"We[‘’']ve turned off your job alert for .{1,500}", subject))


def canonical(value):
    try:
        url = urlsplit(value)
        match = re.fullmatch(r'/(?:comm/)?jobs/view/([0-9]{1,20})/?', url.path)
        if url.scheme != 'https' or url.netloc != 'www.linkedin.com' or not match:
            raise ValueError()
        return match[1], 'https://www.linkedin.com/jobs/view/' + match[1] + '/'
    except ValueError:
        raise MailParseError('Unsupported LinkedIn job URL') from None


def parse_linkedin(message):
    if message.sender.casefold() != SENDER or message.is_html:
        raise MailParseError('Expected LinkedIn text notification')
    body = message.body
    if not isinstance(body, str) or len(body.encode()) > 1_000_000:
        raise MailParseError('Invalid LinkedIn notification size')
    try:
        received = datetime.fromisoformat(message.received_at.replace('Z', '+00:00'))
        if received.tzinfo is None:
            raise ValueError()
    except (AttributeError, ValueError):
        raise MailParseError('Invalid LinkedIn received timestamp') from None
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    if (len(lines) < 2 or not lines[0].startswith('Your job alert for ')
            or not re.fullmatch(r'(?:New|[1-9][0-9]{0,3} new) jobs match your preferences\.|'
                                r'A new job matches your preferences\.', lines[1])):
        raise MailParseError('Unsupported LinkedIn notification template')
    start = 2
    if len(lines) > 2 and lines[2].startswith('Manage alerts: '):
        value = lines[2].removeprefix('Manage alerts: ')
        url = urlsplit(value)
        if (len(value) > 8192 or url.scheme != 'https' or url.netloc != 'www.linkedin.com'
                or url.path != '/comm/jobs/alerts' or url.fragment):
            raise MailParseError('Unsupported LinkedIn management URL')
        start = 3
    jobs, card = {}, []
    for line in lines[start:]:
        if line.startswith('See all jobs on LinkedIn:'):
            break
        if re.fullmatch('-{10,}', line):
            if card:
                raise MailParseError('Incomplete LinkedIn job card')
            continue
        if not line.startswith('View job: '):
            if line.startswith('Manage alerts: '):
                raise MailParseError('Unexpected LinkedIn management URL')
            card.append(line)
            continue
        if not 3 <= len(card) <= 10 or any(len(v) > 500 or 'https://' in v for v in card):
            raise MailParseError('Unsupported LinkedIn job card')
        external_id, url = canonical(line.removeprefix('View job: ').strip())
        title, company, location = card[:3]
        kind = ('full_time' if re.search(r'\bfull[ -]time\b', title, re.I)
                else 'contract' if re.search(r'\b(?:freelance|part[ -]time|contract)\b', title, re.I) else None)
        job = dict(source='linkedin', external_id=external_id, url=url, canonical_url=url,
                   title=title, company=company, location_evidence=location,
                   description='LinkedIn notification card only: ' + title + '\n' + company + '\n' + location,
                   kind=kind, remote_evidence=bool(re.search(r'\bremote\b', title + ' ' + location, re.I)),
                   taiwan_eligible=None, timezone_compatible=None, weekly_hours=None,
                   budget_min=None, budget_max=None, currency=None, deadline=None,
                   published_at=None, complete=False, body_available=False, language='en',
                   compensation_evidence='unpaid_or_equity_only' if re.search(r'\b(?:unpaid|equity only)\b', title, re.I) else None)
        if external_id in jobs and jobs[external_id] != job:
            raise MailParseError('Conflicting LinkedIn job cards')
        jobs[external_id] = job
        card = []
    if card or not jobs:
        raise MailParseError('Missing or incomplete LinkedIn job cards')
    return [job | {'received_at': received.isoformat(),
                   'receipt_id': 'linkedin:' + sha256(json.dumps(job, sort_keys=True).encode()).hexdigest()}
            for job in jobs.values()]
