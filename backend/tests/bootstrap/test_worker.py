from pathlib import Path
import tempfile
import unittest
from freelance.bootstrap.worker import exclusive_worker, run_once, worker_is_running
from freelance.bootstrap.settings import DailySettings
from freelance.bootstrap.store import SQLiteStore

class WorkerTests(unittest.TestCase):
    def test_second_scheduler_cannot_start(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(worker_is_running(Path(directory) / 'worker.lock'))
            with exclusive_worker(Path(directory) / 'worker.lock'):
                self.assertTrue(worker_is_running(Path(directory) / 'worker.lock'))
                with self.assertRaises(RuntimeError):
                    with exclusive_worker(Path(directory) / 'worker.lock'):
                        self.fail('second scheduler acquired same queue')
            self.assertFalse(worker_is_running(Path(directory) / 'worker.lock'))

    def test_existing_run_does_not_open_delivery_configuration(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'app.db'
            store = SQLiteStore(path)
            store.migrate()
            store.claim_daily_run('2026-09-28', 'owner@example.test', datetime.now(timezone.utc))
            args = DailySettings(database=str(path), recipient='owner@example.test',
                                 key_file='never-read', inbox='synthetic', output_dir=directory,
                                 live_read=True)
            self.assertEqual(run_once(args, '2026-09-28')['status'], 'running')
