from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from fixtures.domain import job
from freelance.bootstrap.store import SQLiteStore
from freelance.platform.errors import Conflict


class SourceBatchTests(TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = SQLiteStore(Path(self.tmp.name) / 'cases.db')
        self.store.migrate()

    def test_batch_replays_and_exposes_existing_source_jobs(self):
        first = job(source='tasker', external_id='one')
        for _ in range(2):
            with self.store.source_batch('tasker') as batch:
                batch.ingest(first, receipt_id='receipt-one')
                batch.finish('ok')
        with self.store.source_batch('tasker') as batch:
            self.assertEqual(batch.existing_ids(), {'one'})
            self.assertEqual(batch.existing_jobs()['one']['title'], first['title'])
        self.assertEqual(len(self.store.list()), 1)

    def test_receipt_collision_rolls_back_entire_batch_and_health(self):
        self.store.set_source_health('tasker', 'failed')
        with self.assertRaises(Conflict):
            with self.store.source_batch('tasker') as batch:
                batch.ingest(job(source='tasker', external_id='one'), receipt_id='same')
                batch.finish('ok')
                batch.ingest(job(source='tasker', external_id='two'), receipt_id='same')
        self.assertEqual(self.store.list(), [])
        self.assertEqual(self.store.sources()['tasker'], 'failed')

    def test_batch_rejects_other_source_without_writing(self):
        with self.assertRaises(ValueError):
            with self.store.source_batch('tasker') as batch:
                batch.ingest(job(source='freelancer'), receipt_id='wrong')
        self.assertEqual(self.store.list(), [])
