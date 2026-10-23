"""Small Huey adapter; product run/outbox claims remain authoritative."""
from datetime import datetime, timezone
import os
from pathlib import Path
from zoneinfo import ZoneInfo

from huey import SqliteHuey, crontab


def due_date(now):
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('Aware datetime required')
    local = now.astimezone(ZoneInfo('Asia/Taipei'))
    return str(local.date()) if local.hour >= 9 else None


def build_queue(path, handler, *, clock=None):
    clock = clock or (lambda: datetime.now(timezone.utc))
    path = Path(path)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    os.close(fd)
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o777 != 0o600:
        raise ValueError('Queue must be an owner-only file')
    queue = SqliteHuey('freelance', filename=str(path), results=False)

    @queue.task(retries=0)
    def daily(day):
        if due_date(clock()) != day:
            return {'status': 'expired_trigger'}
        return handler(day)

    @queue.periodic_task(crontab(minute='*'), retries=0)
    def tick():
        day = due_date(clock())
        if day is not None:
            daily(day)

    return queue, daily


def register_submission_task(queue,handler):
    @queue.task(name='submission_v1',retries=0)
    def submit(payload):
        if (not isinstance(payload,dict) or set(payload)!={'schema_version','intent_id'}
                or type(payload['schema_version']) is not int or payload['schema_version']!=1
                or not isinstance(payload['intent_id'],str)):
            return {'status':'unsupported_task'}
        return handler(payload['intent_id'])
    return submit
