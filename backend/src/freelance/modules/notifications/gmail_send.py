"""Explicit, self-addressed Gmail digest delivery through the durable outbox."""
import argparse
import base64
from datetime import date, datetime
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import hashlib
import hmac
import json
import os
import re

from freelance.modules.notifications.digest import render, SOURCE_STATUS, safe_url
from freelance.modules.collection.public import PROFILE_URL
from freelance.modules.notifications.scheduler import dispatch
from freelance.modules.discovery.public import is_candidate

SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
_ADDRESS = re.compile(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\Z')


class SendError(Exception):
    """A fixed message, without provider payloads or credentials."""


def build_message(snapshot, intent_id, expected_email):
    if (not isinstance(expected_email, str) or not _ADDRESS.fullmatch(expected_email)
            or snapshot['recipient'].casefold() != expected_email.casefold()):
        raise ValueError('Digest must be addressed only to the verified account')
    local_date = date.fromisoformat(snapshot['local_date']).isoformat()
    generated = datetime.fromisoformat(snapshot['generated_at'])
    if generated.tzinfo is None or generated.utcoffset() is None:
        raise ValueError('Snapshot requires an aware timestamp')
    key = hashlib.sha256(str(intent_id).encode()).hexdigest()
    msg = EmailMessage(policy=SMTP)
    msg['From'] = expected_email
    msg['To'] = expected_email
    msg['Subject'] = f'接案摘要 · {local_date}'
    msg['Date'] = format_datetime(generated)
    msg['Message-ID'] = f'<{key}@freelance-agent.local>'
    items = [x for x in snapshot['items'] if is_candidate(x)]
    lines = [f'接案摘要 · {local_date}', '案件條件仍需人工確認；本信不代表已投遞。', '']
    if 'unseen_count' in snapshot:
        lines.append(f"新案／更新 {snapshot['unseen_count']} 件；本信列出 {len(items)} 件候選。")
    for item in items:
        if 'recommendation' in item:
            rank = item['recommendation']
            lines.append(f"推薦排序 {rank['score']} 分 · 資訊完整度 {rank['completeness']}%（非成交機率）")
        lines.extend([item['job']['title'], '；'.join(item['evaluation']['questions']),
                      safe_url(item['job'].get('url', '')), ''])
    if not items:
        lines.append('目前沒有可列出的候選；請同時檢查來源狀態。')
    lines.append('來源狀態')
    lines.extend(f'{name}：{SOURCE_STATUS.get(state, "狀態未知")}' for name, state in snapshot['sources'].items())
    msg.set_content('\n'.join(lines))
    msg.add_alternative(render(items, snapshot['sources'], mode='sqlite', email=True, counts=snapshot), subtype='html')
    msg.set_boundary('digest_' + key)
    return msg.as_bytes()


def write_preview(raw, path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(raw)
    return hashlib.sha256(raw).hexdigest()


def _payload(response):
    if response.status_code != 200 or len(response.content) > 65536:
        raise SendError('Gmail delivery request failed')
    value = response.json()
    if not isinstance(value, dict) or 'error' in value:
        raise SendError('Gmail delivery request failed')
    return value


def send_intent(store, intent_id, expected_email, expected_sha256, session_factory):
    intent = store.get_digest(intent_id)
    if intent['status'] != 'pending':
        return intent
    raw = build_message(intent['snapshot'], intent_id, expected_email)
    if (not isinstance(expected_sha256, str) or not re.fullmatch('[a-f0-9]{64}', expected_sha256)
            or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), expected_sha256)):
        raise ValueError('Digest preview hash mismatch')
    session = session_factory()
    try:
        try:
            profile = _payload(session.get(PROFILE_URL, timeout=20, allow_redirects=False))
            if not isinstance(profile.get('emailAddress'), str) or profile['emailAddress'].casefold() != expected_email.casefold():
                raise SendError('Gmail account verification failed')
        except Exception:
            raise SendError('Gmail account verification failed') from None

        def sender(snapshot):
            # Bind the persisted claim to exactly the bytes reviewed before authentication.
            if build_message(snapshot, intent_id, expected_email) != raw:
                raise SendError('Digest changed')
            payload = _payload(session.post(SEND_URL,
                json={'raw': base64.urlsafe_b64encode(raw).decode('ascii')},
                timeout=20, allow_redirects=False))
            receipt = payload.get('id')
            if not isinstance(receipt, str) or not re.fullmatch('[A-Za-z0-9_-]+', receipt):
                raise SendError('Gmail delivery receipt missing')
            return {'message_id': receipt}

        return dispatch(store, intent_id, sender)
    finally:
        session.close()
