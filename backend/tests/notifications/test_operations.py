from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from freelance.bootstrap.store import SQLiteStore


class OperationsTests(TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store = SQLiteStore(Path(self.tmp.name) / 'cases.db'); self.store.migrate()
        self.now = datetime(2026, 9, 30, 1, tzinfo=timezone.utc)

    def test_missing_history_is_unknown(self):
        self.assertIsNone(self.store.operations()['last_run'])
        self.assertIsNone(self.store.operations()['sources']['tasker']['checked_at'])

    def test_partial_daily_and_later_recovery_are_separate_from_delivery(self):
        recipient = 'private@example.invalid'
        self.store.claim_daily_run('2026-09-30', recipient, self.now)
        intent = self.store.create_digest('2026-09-30', recipient, self.now)
        self.store.claim_digest(intent['id']); self.store.finish_digest(intent['id'], 'sent', 'private-receipt')
        self.store.finish_daily_run('2026-09-30', recipient, 'failed', {
            'output': '/private/path', 'source_details': {'status':'failed', 'tasker': {
                'status':'partial','seen':85,'jobs':1,'rejected_count':1,
                'reason':'private-provider-payload','raw_body':'private-body'}}}, self.now)
        self.store.set_source_health('tasker', 'ok')
        result = self.store.operations()
        self.assertEqual(result['last_run']['delivery_status'], 'sent')
        self.assertEqual(result['last_run']['status'], 'failed')
        source = result['sources']['tasker']
        self.assertEqual(source['status'], 'ok')
        self.assertEqual(source['latest_daily']['status'], 'partial')
        self.assertEqual(source['latest_daily']['rejected_count'], 1)
        self.assertEqual(source['latest_daily']['reason'], 'invalid_data')
        self.assertNotIn('private', str(result))

    def test_running_does_not_claim_delivery_or_source_success(self):
        self.store.claim_daily_run('2026-09-30', 'private@example.invalid', self.now)
        result = self.store.operations()
        self.assertEqual(result['last_run']['status'], 'running')
        self.assertIsNone(result['last_run']['delivery_status'])
        self.assertIsNone(result['sources']['tasker']['latest_daily'])
