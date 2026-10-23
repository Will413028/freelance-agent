"""Infrastructure preserves scalar values; owners interpret stored JSON."""
import json
import unittest
from freelance.platform.sqlite import MemoryDatabase
from freelance.bootstrap.store import SQLiteStore
from datetime import datetime, timezone

class StorageCodecTests(unittest.TestCase):
    def test_storage_does_not_interpret_product_column_names(self):
        db = MemoryDatabase()
        try:
            with db.connect() as conn:
                row = conn.execute("SELECT 'not-json' AS item, '{}' AS snapshot, NULL AS result").fetchone()
                self.assertEqual(row, {'item': 'not-json', 'snapshot': '{}', 'result': None})
        finally:
            db.close()

    def test_notification_owner_decodes_without_changing_stored_bytes(self):
        db = MemoryDatabase(); store = SQLiteStore(None, database=db); store.migrate()
        now = datetime(2026, 9, 30, tzinfo=timezone.utc)
        try:
            intent = store.create_digest('2026-09-30', 'owner@example.invalid', now)
            self.assertIsInstance(intent['snapshot'], dict)
            self.assertEqual(store.find_digest('2026-09-30', 'owner@example.invalid'), intent)
            self.assertEqual(store.get_digest(intent['id']), intent)
            with db.connect(write=False) as conn:
                encoded = conn.execute('SELECT snapshot FROM digest_outbox').fetchone()['snapshot']
                self.assertIsInstance(encoded, str)
            claimed = store.claim_digest(intent['id']); self.assertEqual(claimed['snapshot'], intent['snapshot'])
            self.assertIsNone(store.claim_digest(intent['id']))
            store.finish_digest(intent['id'], 'unknown')
            store.claim_daily_run('2026-09-30', 'owner@example.invalid', now)
            self.assertIsNone(store.get_daily_run('2026-09-30', 'owner@example.invalid')['result'])
            result = {'source_details': {'tasker': {'status': 'partial', 'jobs': 1}}}
            store.finish_daily_run('2026-09-30', 'owner@example.invalid', 'failed', result, now)
            self.assertEqual(store.get_daily_run('2026-09-30', 'owner@example.invalid')['result'], result)
            self.assertEqual(store.operations()['sources']['tasker']['latest_daily']['status'], 'partial')
            with db.connect(write=False) as conn:
                self.assertEqual(conn.execute('SELECT snapshot FROM digest_outbox').fetchone()['snapshot'], encoded)
        finally:
            db.close()

    def test_invalid_snapshot_cannot_commit_a_delivery_claim(self):
        db = MemoryDatabase(); store = SQLiteStore(None, database=db); store.migrate()
        try:
            intent = {'id': 'malformed-historical-snapshot'}
            with db.connect() as conn:
                conn.execute('INSERT INTO digest_outbox(id,local_date,recipient,snapshot) VALUES (?,?,?,?)',
                             (intent['id'], '2026-09-30', 'owner@example.invalid', 'not-json'))
            with self.assertRaises(json.JSONDecodeError):
                store.claim_digest(intent['id'])
            with db.connect(write=False) as conn:
                row = conn.execute('SELECT status,attempted_at FROM digest_outbox WHERE id=?', (intent['id'],)).fetchone()
                self.assertEqual(row, {'status': 'pending', 'attempted_at': None})
        finally:
            db.close()
