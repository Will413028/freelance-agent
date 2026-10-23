"""Incremental receiving intake; quarantined messages never discard good mail."""
from collections import Counter
from time import monotonic
import re

from freelance.modules.collection.resend_preview import read_notification, matches, NotificationError, _id, SENDERS
from freelance.platform.errors import Conflict
from freelance.modules.discovery.public import qualify_for_intake


def sync_tasker(client, store, recipient, *, max_messages=20, **limits):
    return _sync(client, store, recipient, source='tasker', max_messages=max_messages, **limits)


def sync_linkedin(client, store, recipient, *, max_messages=20, **limits):
    return _sync(client, store, recipient, source='linkedin', max_messages=max_messages, **limits)


def sync_cake(client, store, recipient, *, max_messages=20, **limits):
    return _sync(client, store, recipient, source='cake', max_messages=max_messages, **limits)


def sync_104(client, store, recipient, *, max_messages=20, **limits):
    return _sync(client, store, recipient, source='jobbank104', max_messages=max_messages, **limits)


def sync_talent(client, store, recipient, *, max_messages=20, **limits):
    return _sync(client, store, recipient, source='talent', max_messages=max_messages, **limits)


def sync_glassdoor(client, store, recipient, *, max_messages=20, **limits):
    return _sync(client, store, recipient, source='glassdoor', max_messages=max_messages, **limits)


def sync_indeed(client, store, recipient, *, max_messages=20, **limits):
    return _sync(client, store, recipient, source='indeed', max_messages=max_messages, **limits)


def _sync(client, store, recipient, *, source, max_messages, max_pages=20, max_seconds=90):
    if source not in SENDERS or not isinstance(recipient, str) or not re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.resend\.app', recipient):
        raise ValueError('Explicit Resend recipient required')
    recipient = recipient.casefold()
    if type(max_messages) is not int or not 1 <= max_messages <= 100:
        raise ValueError('Message limit must be 1–100')
    if type(max_pages) is not int or not 1 <= max_pages <= 100 or not 0 < max_seconds <= 300:
        raise ValueError('Invalid scan limits')
    counts = dict(metadata_seen=0, body_reads=0, messages=0, jobs=0, content_versions=0, pages=0)
    errors = Counter()
    complete, interrupted = False, False
    try:
        store.set_source_health(source, 'failed')
        state = store.mail_state(source, recipient)
        records = store.mail_records(source, recipient)
        existing = store.existing_source_ids(source)
        end = monotonic() + max_seconds
        def process(message_id, *, retry=False):
            counts['body_reads'] += 1
            try:
                items = read_notification(client, message_id, recipient, source, retry=retry)
            except NotificationError as error:
                errors[error.stage] += 1
                if error.stage == 'fetch':
                    return False
                store.record_mail(source, recipient, message_id, 'rejected', error.stage)
                records[message_id] = {'status': 'rejected'}
            else:
                if source == 'linkedin' and not items:
                    store.record_mail(source, recipient, message_id, 'processed', 'non_job_notification')
                    records[message_id] = {'status': 'processed', 'reason': 'non_job_notification'}
                    return True
                jobs = [item['job'] for item in items if item['job']['external_id'] in existing
                        or qualify_for_intake(item['job'])['status'] != 'excluded']
                try:
                    outcome = store.ingest_resend_batch(jobs)
                except Conflict:
                    store.record_mail(source, recipient, message_id, 'conflict', 'receipt_collision')
                    records[message_id] = {'status': 'conflict'}
                    errors['receipt_collision'] += 1
                else:
                    store.record_mail(source, recipient, message_id, 'processed',
                                      'content_changed' if outcome['content_versions'] else None)
                    records[message_id] = {'status': 'processed'}
                    counts['messages'] += 1
                    counts['jobs'] += len(jobs)
                    counts['content_versions'] += outcome['content_versions']
                    existing.update(job['external_id'] for job in jobs)
            return True

        visited = set()
        while counts['pages'] < max_pages and monotonic() < end and not complete and not interrupted:
            listing = (client.list_received(after=state['after']) if state['after']
                       else client.list_received())
            entries = listing.get('data')
            if not isinstance(entries, list) or len(entries) > 100 or type(listing.get('has_more')) is not bool:
                raise ValueError('Invalid page')
            if listing['has_more'] and not entries:
                raise ValueError('Empty nonterminal page')
            counts['pages'] += 1
            for entry in entries:
                message_id = _id(entry.get('id'))
                if message_id == state['cursor']:
                    complete = True
                    break
                if message_id in visited:
                    raise ValueError('Repeated pagination identity')
                visited.add(message_id)
                if counts['body_reads'] >= max_messages or monotonic() >= end:
                    interrupted = True
                    break
                state['head'] = state['head'] or message_id
                counts['metadata_seen'] += 1
                if message_id not in records and matches(entry, source):
                    if not process(message_id):
                        interrupted = True
                        break
                state['after'] = message_id
            if interrupted:
                break
            if not listing['has_more']:
                complete = True
        if complete:
            state = dict(cursor=state['head'] or state['cursor'], after=None, head=None)
        store.save_mail_state(source, recipient, state)
        # Recovery has its own durable IDs; an unavailable old body must not block new mail.
        for message_id, record in list(records.items()):
            if record.get('retry_pending'):
                if counts['body_reads'] >= max_messages or monotonic() >= end:
                    break
                process(message_id, retry=True)
        quarantined = sum(record['status'] != 'processed' for record in records.values())
        any_processed = any(record['status'] == 'processed'
                            and record.get('reason') != 'non_job_notification'
                            for record in records.values())
        status = ('failed' if not complete or quarantined else
                  'waiting' if source != 'tasker' and not any_processed else 'ok')
        store.set_source_health(source, status)
        return dict(status=status, reason=('incomplete_or_unsupported_scan' if status == 'failed' else
                    'no_matching_notification' if status == 'waiting' else None), **counts,
                    truncated=not complete, complete_scan=complete, quarantined=quarantined,
                    retry_pending=sum(bool(record.get('retry_pending')) for record in records.values()),
                    error_count=sum(errors.values()), error_stages=dict(errors))
    except Exception:
        return dict(status='failed', reason='source_or_reconciliation_failed', **counts,
                    truncated=True, complete_scan=False, error_stages=dict(errors))
