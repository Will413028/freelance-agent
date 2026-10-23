"""Explicit Resend self-test delivery; no scheduling or automatic retries."""
import argparse
from datetime import date
from hashlib import sha256
import hmac
import json
import re
from urllib.request import Request, build_opener
from uuid import UUID
from freelance.modules.notifications.digest import render
from freelance.modules.collection.public import NoRedirect, read_key, write_preview
from freelance.modules.notifications.scheduler import dispatch

class SendError(Exception):
    pass


def build_payload(snapshot, recipient):
    if (not isinstance(recipient, str) or not re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', recipient)
            or snapshot['recipient'].casefold() != recipient.casefold()):
        raise ValueError('Explicit self recipient must match snapshot')
    day = date.fromisoformat(snapshot['local_date']).isoformat()
    body = {'from': 'onboarding@resend.dev', 'to': [recipient],
            'subject': f'接案摘要 · {day} · Resend 測試',
            'html': '<p>Resend 寄送測試。以下是既有資料快照，尚未啟用自動收案或每日寄送。</p>' +
                    render(snapshot['items'], snapshot['sources'], mode='sqlite', email=True)}
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


class SendingClient:
    def __init__(self, key, *, opener=None):
        if not isinstance(key, str) or not re.fullmatch(r're_[A-Za-z0-9_-]{5,500}', key):
            raise ValueError('Invalid key')
        self._key, self._opener = key, opener or build_opener(NoRedirect())

    def send(self, raw, intent_id):
        try:
            request = Request('https://api.resend.com/emails', data=raw, method='POST', headers={
                'Authorization': 'Bearer ' + self._key, 'Content-Type': 'application/json',
                'User-Agent': 'freelance-agent/0.1',
                'Idempotency-Key': 'freelance-' + sha256(str(intent_id).encode()).hexdigest()})
            with self._opener.open(request, timeout=20) as response:
                if response.status != 200:
                    raise ValueError()
                content = response.read(65537)
            if len(content) > 65536:
                raise ValueError()
            value = json.loads(content)
            receipt = value['id']
            if str(UUID(receipt)) != receipt:
                raise ValueError()
            return {'message_id': receipt}
        except Exception:
            raise SendError('Resend delivery unavailable') from None


def send_intent(store, intent_id, recipient, expected_sha256, client_factory):
    intent = store.get_digest(intent_id)
    if intent['status'] != 'pending':
        return intent
    raw = build_payload(intent['snapshot'], recipient)
    if (not isinstance(expected_sha256, str) or not re.fullmatch('[a-f0-9]{64}', expected_sha256)
            or not hmac.compare_digest(sha256(raw).hexdigest(), expected_sha256)):
        raise ValueError('Preview hash mismatch')
    client = client_factory()
    def sender(snapshot):
        if build_payload(snapshot, recipient) != raw:
            raise ValueError('Snapshot changed')
        return client.send(raw, intent_id)
    return dispatch(store, intent_id, sender)
