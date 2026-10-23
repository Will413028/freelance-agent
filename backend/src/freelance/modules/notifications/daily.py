"""Once-per-Taipei-day intake; delivery requires explicit opt-in."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path

from freelance.modules.notifications.digest import render
from freelance.modules.collection.public import sync_tasker
from freelance.modules.collection.public import open_session
from freelance.modules.collection.public import GmailTransport
from freelance.modules.notifications.scheduler import TAIPEI, daily_tick


def run_daily(store, client_factory, *, recipient, output_dir, now=None, max_messages=100, send_session_factory=None, source_sync=None, delivery=None):
    if delivery is not None and send_session_factory is not None:
        raise ValueError("Only one delivery adapter may be configured")
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('Aware datetime required')
    if not isinstance(recipient, str) or not recipient.strip() or any(c in recipient for c in '\r\n'):
        raise ValueError('Explicit recipient required')
    recipient = recipient.strip().casefold()
    if type(max_messages) is not int or not 1 <= max_messages <= 100:
        raise ValueError('Message limit must be from 1 to 100')
    local = now.astimezone(TAIPEI)
    if local.hour < 9:
        return {'status': 'not_due'}
    directory = Path(output_dir)
    if not directory.is_dir():
        raise ValueError('Existing output directory required')
    local_date = str(local.date())
    suffix = sha256(recipient.encode()).hexdigest()[:12]
    output = directory / f'digest-{local_date}-{suffix}.html'
    if not store.claim_daily_run(local_date, recipient, now):
        record = store.get_daily_run(local_date, recipient)
        return {'status': 'already_run', 'run_status': record['status'], 'local_date': local_date}
    try:
        # A previous crash leaves running; no second mailbox scan that day.
        if os.path.lexists(output):
            raise ValueError('Output already exists')
        intent = store.find_digest(local_date, recipient)
        reused = intent is not None
        if reused:
            source = {'status': intent['snapshot']['sources'].get('tasker', 'not_connected')}
        else:
            try:
                with client_factory() as client:
                    source = (source_sync(client, store) if source_sync is not None else
                              sync_tasker(client, store, max_messages=max_messages, max_pages=20))
            except Exception:
                store.set_source_health('tasker', 'failed')
                source = {'status': 'failed', 'reason': 'source_unavailable'}
            intent = daily_tick(store, recipient, now)
        snapshot = intent['snapshot']
        html = render(snapshot['items'], snapshot['sources'], mode='sqlite', counts=snapshot)
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'w') as target:
            target.write(html)
        result = {'status': 'existing_digest' if reused else ('digest_ready' if source['status'] == 'ok' else 'source_failed'),
                  'local_date': local_date, 'intent_id': intent['id'], 'output': str(output),
                  'source_status': source['status'], 'source_reason': source.get('reason'), 'source_details': source,
                  'candidates': len(snapshot['items']),
                  'delivery_status': intent['status']}
        status = 'complete' if reused or source['status'] == 'ok' else 'failed'
        if delivery is not None:
            if reused:
                result['delivery_error'] = 'existing_snapshot_requires_review'
                status = 'failed'
            else:
                try:
                    delivered = delivery(store, intent['id'])
                    result['delivery_status'] = delivered['status']
                    if delivered['status'] != 'sent':
                        status = 'failed'
                except Exception:
                    result['delivery_error'] = 'send_preflight_failed'
                    status = 'failed'
        if send_session_factory is not None:
            from freelance.modules.notifications.gmail_send import build_message, send_intent
            try:
                raw = build_message(snapshot, intent['id'], recipient)
                delivered = send_intent(store, intent['id'], recipient,
                                        sha256(raw).hexdigest(), send_session_factory)
                result['delivery_status'] = delivered['status']
                if delivered['status'] != 'sent':
                    status = 'failed'
            except Exception:
                result['delivery_error'] = 'send_preflight_failed'
                status = 'failed'

    except Exception:
        status, result = 'failed', {'status': 'failed', 'local_date': local_date,
                                    'reason': 'daily_processing_failed'}
    store.finish_daily_run(local_date, recipient, status, result, now)
    return result
