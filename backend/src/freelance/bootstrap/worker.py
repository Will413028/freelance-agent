"""Single Huey scheduler/consumer; no automatic recovery of uncertain effects."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path

from .settings import DailySettings
from .jobs import execute_daily
from .queue import build_queue, due_date,register_submission_task
from .submission_runtime import SubmissionRuntime
from .store import SQLiteStore


@contextmanager
def exclusive_worker(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('A worker already owns this queue') from None
        yield
    finally:
        os.close(fd)


def run_once(args, day):
    existing = SQLiteStore(args.database).get_daily_run(day, args.recipient.strip().casefold())
    if existing:
        return {'status': existing['status']}
    return execute_daily(args)


def worker_is_running(path):
    """Liveness only; business completion must be checked in the product DB."""
    try:
        with open(path, 'rb') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            return False
    except FileNotFoundError:
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--queue', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--submissions-config',type=Path)
    args = parser.parse_args(argv)
    os.umask(0o077)
    settings = DailySettings(**json.loads(args.config.read_text()))
    with exclusive_worker(args.queue.with_suffix('.lock')):
        queue, daily = build_queue(args.queue, lambda day: run_once(settings, day))
        runtime=SubmissionRuntime(SQLiteStore(settings.database),args.submissions_config)
        register_submission_task(queue,runtime.dispatch)
        today = due_date(datetime.now(timezone.utc))
        if today:
            daily(today)
        queue.create_consumer(workers=1, worker_type='thread', periodic=True,
                              shutdown_timeout=30).run()


if __name__ == '__main__':
    main()
