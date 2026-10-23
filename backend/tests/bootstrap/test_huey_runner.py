"""Real SQLite queue and consumer process contracts; no external services."""
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from freelance.bootstrap.queue import build_queue, due_date


class QueueTests(unittest.TestCase):
    def test_interrupted_run_and_uncertain_send_are_not_reexecuted(self):
        from freelance.bootstrap.store import SQLiteStore
        code = '''
import os, signal, sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from freelance.modules.notifications.daily import run_daily
from freelance.bootstrap.store import SQLiteStore
from freelance.bootstrap.queue import build_queue
root, phase = Path(sys.argv[1]), sys.argv[2]
now = datetime(2026, 9, 28, 1, tzinfo=timezone.utc)
store = SQLiteStore(root/'app.db', clock=lambda: now)
@contextmanager
def client(): yield None
def source(client, store):
    with (root/'calls').open('a') as f: f.write('source\\n')
    if phase == 'collection': os._exit(99)
    return {'status': 'ok'}
def delivery(store, intent):
    if store.claim_digest(intent):
        with (root/'calls').open('a') as f: f.write('send\\n')
        if phase == 'delivery': os._exit(99)
        store.finish_digest(intent, 'sent', 'synthetic')
    return store.get_digest(intent)
def handler(day):
    result = run_daily(store, client, recipient='owner@example.test', output_dir=root,
                       now=now, source_sync=source, delivery=delivery)
    (root/'done').write_text(result['status'])
q, task = build_queue(root/'queue.db', handler, clock=lambda: now)
q.create_consumer(workers=1, periodic=False).run()
'''
        for phase in ('collection', 'delivery'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                store = SQLiteStore(root / 'app.db')
                store.migrate()
                q, task = build_queue(root / 'queue.db', lambda day: None)
                task('2026-09-28')
                first = subprocess.Popen([sys.executable, '-c', code, directory, phase],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    self.assertEqual(first.wait(timeout=10), 99)
                finally:
                    if first.poll() is None:
                        first.kill()
                        first.wait(timeout=5)
                before = (root / 'calls').read_text()
                self.assertEqual(store.get_daily_run('2026-09-28', 'owner@example.test')['status'], 'running')
                if phase == 'delivery':
                    self.assertEqual(store.find_digest('2026-09-28', 'owner@example.test')['status'], 'attempted')
                task('2026-09-28')
                second = subprocess.Popen([sys.executable, '-c', code, directory, 'restart'],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    deadline = time.monotonic() + 10
                    while not (root / 'done').exists() and time.monotonic() < deadline:
                        time.sleep(.02)
                    self.assertEqual((root / 'done').read_text(), 'already_run')
                    self.assertEqual((root / 'calls').read_text(), before)
                finally:
                    second.terminate()
                    second.wait(timeout=10)

    def test_schedule_uses_taipei_date_and_only_catches_up_today(self):
        self.assertIsNone(due_date(datetime(2026, 9, 28, 0, 59, tzinfo=timezone.utc)))
        self.assertEqual(due_date(datetime(2026, 9, 28, 1, tzinfo=timezone.utc)), '2026-09-28')
        self.assertEqual(due_date(datetime(2026, 9, 28, 15, 59, tzinfo=timezone.utc)), '2026-09-28')
        self.assertIsNone(due_date(datetime(2026, 9, 28, 16, tzinfo=timezone.utc)))
        with self.assertRaises(ValueError):
            due_date(datetime(2026, 9, 28))

    def test_stale_queued_day_is_not_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            called = []
            queue, task = build_queue(Path(directory) / 'queue.db', called.append,
                                      clock=lambda: datetime(2026, 9, 29, 1, tzinfo=timezone.utc))
            task('2026-09-28')
            queue.execute(queue.dequeue())
            self.assertEqual(called, [])

    def test_pending_job_survives_consumer_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / 'queue.db'
            marker = Path(directory) / 'executed'
            now = datetime(2026, 9, 28, 1, tzinfo=timezone.utc)
            queue, task = build_queue(db, lambda day: None, clock=lambda: now)
            task('2026-09-28')
            code = '''
import sys
from pathlib import Path
from datetime import datetime, timezone
from freelance.bootstrap.queue import build_queue
q, task = build_queue(Path(sys.argv[1]), lambda day: Path(sys.argv[2]).write_text(day),
                      clock=lambda: datetime(2026, 9, 28, 1, tzinfo=timezone.utc))
q.create_consumer(workers=1, periodic=False).run()
'''
            process = subprocess.Popen([sys.executable, '-c', code, str(db), str(marker)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 10
                while not marker.exists() and time.monotonic() < deadline:
                    if process.poll() is not None:
                        self.fail('consumer exited before executing persisted job')
                    time.sleep(.02)
                self.assertTrue(marker.exists(), 'consumer did not execute persisted job')
                self.assertEqual(marker.read_text(), '2026-09-28')
            finally:
                process.terminate()
                process.wait(timeout=10)
            self.assertEqual(len(queue), 0)
            self.assertEqual(os.stat(db).st_mode & 0o777, 0o600)
