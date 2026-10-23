"""Explicit bounded Resend Receiving preview. No DB, AI, sending, or attachments."""
import argparse
from datetime import datetime
from email.utils import getaddresses
import json
import os
from pathlib import Path
import re
import stat
import time
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID

from freelance.modules.collection.mail import MailMessage
from freelance.modules.collection.intake import preview as preview_message
from freelance.modules.collection.talent_mail import subject_format
from freelance.modules.collection.glassdoor_mail import is_job_subject
from freelance.modules.collection.indeed_mail import is_job_subject as is_indeed_subject

MAX_BYTES = 2 * 1024 * 1024
ROOT = 'https://api.resend.com/emails/receiving'
SENDER = 'deals@tasker.com.tw'
SENDERS = {'tasker': SENDER, 'linkedin': 'jobalerts-noreply@linkedin.com',
           'cake': 'notifications@no-reply.cake.me', 'jobbank104': 'jobbank@ms1.104.com.tw',
           'talent': 'no-reply@alerts.talent.com', 'glassdoor': 'noreply@glassdoor.com',
           'indeed': 'donotreply@jobalert.indeed.com'}

class ResendError(Exception):
    pass

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_key(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096):
                raise ValueError()
            data = json.loads(source.read(4097))
        key = data['api_key']
        if not isinstance(key, str) or not re.fullmatch(r're_[A-Za-z0-9_-]{5,500}', key):
            raise ValueError()
        return key
    except Exception:
        raise ResendError('Resend key unavailable') from None


def _id(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ResendError('Invalid Resend identifier')
    return value


def _sender(value):
    if not isinstance(value, str) or any(x in value for x in '\r\n'):
        return None
    addresses = getaddresses([value])
    return addresses[0][1].casefold() if len(addresses) == 1 else None


class ReceivingClient:
    def __init__(self, key, *, opener=None, pause=time.sleep, sources=('tasker',)):
        if not isinstance(key, str) or not re.fullmatch(r're_[A-Za-z0-9_-]{5,500}', key):
            raise ResendError('Invalid Resend key')
        if not sources or any(source not in SENDERS for source in sources):
            raise ResendError('Unsupported receiving source')
        self._senders = {SENDERS[source] for source in sources}
        self._key, self._opener, self._pause = key, opener or build_opener(NoRedirect()), pause
        self._allowed = set()
        self._requested = False

    def _get(self, suffix):
        try:
            if self._requested:
                self._pause(0.6)
            self._requested = True
            request = Request(ROOT + suffix, method='GET', headers={
                'Authorization': 'Bearer ' + self._key, 'Accept': 'application/json',
                'User-Agent': 'freelance-agent/0.1'})
            with self._opener.open(request, timeout=20) as response:
                if response.status != 200:
                    raise ValueError()
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError()
            data = json.loads(raw)
            if not isinstance(data, dict) or 'error' in data:
                raise ValueError()
            return data
        except Exception:
            raise ResendError('Resend read failed') from None

    def list_received(self, *, after=None):
        data = self._get('?limit=100' + ('&after=' + _id(after) if after is not None else ''))
        if (not isinstance(data.get('data'), list) or len(data['data']) > 100
                or type(data.get('has_more')) is not bool):
            raise ResendError('Invalid Resend list')
        self._allowed.clear()
        for entry in data['data']:
            if not isinstance(entry, dict):
                raise ResendError('Invalid Resend list')
            mid = _id(entry.get('id'))
            if _sender(entry.get('from')) in self._senders:
                self._allowed.add(mid)
        return data

    def get_received(self, mid, *, retry_source=None):
        if retry_source is not None:
            if retry_source not in SENDERS or SENDERS[retry_source] not in self._senders:
                raise ResendError('Retry source is not enabled')
        elif mid not in self._allowed:
            raise ResendError('Message not listed as an enabled source')
        return self._get('/' + _id(mid) + '?html_format=cid')


def matches(entry, source):
    subject = str(entry.get('subject', ''))
    return (_sender(entry.get('from')) == SENDERS[source]
            and (source != 'talent' or subject_format(subject) is not None)
            and (source != 'glassdoor' or is_job_subject(subject))
            and (source != 'indeed' or is_indeed_subject(subject))
            and not (source == 'linkedin' and 'has been created' in subject.casefold())
            and (source != 'jobbank104' or re.fullmatch(r'.{1,100}\d{2}/\d{2}的配對日報，符合職缺\d{1,3}筆', subject))
            and (source != 'cake' or '刊登了一筆新職缺' in subject))


class NotificationError(ValueError):
    def __init__(self, stage):
        super().__init__('Notification unavailable or unsupported')
        self.stage = stage


def read_notification(client, mid, recipient, source, *, retry=False):
    """Read one allowlisted message; callers own paging, persistence and recovery."""
    stage = 'fetch'
    try:
        mail = client.get_received(mid, retry_source=source) if retry else client.get_received(mid)
        stage = 'metadata'
        recipients, to = mail.get('received_for', []), mail.get('to', [])
        if (mail.get('id') != mid or _sender(mail.get('from')) != SENDERS[source]
                or not isinstance(recipients, list) or not isinstance(to, list)
                or any(not isinstance(x, str) for x in recipients + to)
                or recipient.casefold() not in [x.casefold() for x in recipients + to]):
            raise ValueError()
        timestamp = datetime.fromisoformat(mail['created_at'].replace('Z', '+00:00'))
        if timestamp.tzinfo is None or timestamp.utcoffset() is None:
            raise ValueError()
        subject = mail['subject']
        body = mail.get('text') if source == 'linkedin' else mail.get('html') or mail.get('text')
        if not isinstance(subject, str) or not isinstance(body, str) or len(body.encode()) > MAX_BYTES:
            raise ValueError()
        message = MailMessage('resend:' + mid, SENDERS[source], subject, body,
                              source != 'linkedin' and bool(mail.get('html')), timestamp.isoformat())
        stage = 'template'
        if source == 'tasker':
            return preview_message(message)
        from freelance.modules.collection.linkedin_mail import parse_linkedin, is_administrative_notice
        if source == 'linkedin' and is_administrative_notice(subject):
            return []
        from freelance.modules.collection.cake_mail import parse_cake
        from freelance.modules.collection.jobbank104_mail import parse_104
        from freelance.modules.collection.talent_mail import parse_talent
        from freelance.modules.collection.glassdoor_mail import parse_glassdoor
        from freelance.modules.collection.indeed_mail import parse_indeed
        from freelance.modules.discovery.public import qualify
        parse_jobs = {'linkedin': parse_linkedin, 'cake': parse_cake, 'jobbank104': parse_104,
                      'talent': parse_talent, 'glassdoor': parse_glassdoor, 'indeed': parse_indeed}[source]
        return [dict(job=job, evaluation=qualify(job)) for job in parse_jobs(message)]
    except Exception:
        raise NotificationError(stage) from None


def preview(client, recipient, *, max_messages=20, source='tasker'):
    if source not in SENDERS:
        raise ValueError('Unsupported receiving source')
    if (not isinstance(recipient, str) or not re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.resend\.app', recipient)
            or type(max_messages) is not int or not 1 <= max_messages <= 20):
        raise ValueError('Explicit Resend recipient and body limit required')
    listing = client.list_received()
    if not isinstance(listing.get('data'), list) or len(listing['data']) > 100 or type(listing.get('has_more')) is not bool:
        raise ResendError('Invalid Resend list')
    ids = []
    for entry in listing['data']:
        mid = _id(entry.get('id'))
        if mid not in ids and matches(entry, source):
            ids.append(mid)
    items, errors = [], []
    reads = 0
    for mid in ids[:max_messages]:
        reads += 1
        try:
            items.extend(read_notification(client, mid, recipient, source))
        except NotificationError as error:
            errors.append({'id': mid, 'reason': 'unsupported_or_unavailable_message', 'stage': error.stage})
    return {'status': 'partial_preview' if errors else 'preview_only',
            'metadata_seen': len(listing['data']), 'body_reads': reads,
            'truncated': listing['has_more'] or len(ids) > max_messages,
            'complete_scan': False, 'items': items, 'errors': errors}


def write_preview(result, path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as target:
        json.dump(result, target, ensure_ascii=False, indent=2)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key-file', required=True)
    parser.add_argument('--recipient', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--max-messages', type=int, default=20)
    parser.add_argument('--live-read', action='store_true')
    parser.add_argument('--source', choices=tuple(SENDERS), default='tasker')
    args = parser.parse_args(argv)
    if not args.live_read or not 1 <= args.max_messages <= 20:
        parser.error('--live-read and max-messages 1..20 required')
    if os.path.lexists(args.output) or not Path(args.output).parent.is_dir():
        parser.error('Output must be a new file in an existing directory')
    try:
        result = preview(ReceivingClient(read_key(args.key_file), sources=(args.source,)), args.recipient,
                         max_messages=args.max_messages, source=args.source)
        write_preview(result, args.output)
    except Exception:
        parser.exit(1, 'Resend preview failed; no database changes or delivery.\n')
    print(json.dumps({k: result[k] for k in ('status', 'metadata_seen', 'body_reads', 'truncated')}))
    return 0 if not result['errors'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
