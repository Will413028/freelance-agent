"""SQLite persistence contract using real temporary databases."""
import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier

from freelance.legacy.review import Conflict, InvalidAction
from fixtures.domain import job, legacy_proposal

import sqlite3
import tempfile
from pathlib import Path
from contextlib import contextmanager
from freelance.bootstrap.store import SQLiteStore
from freelance.modules.notifications.scheduler import daily_tick, dispatch
NOW = datetime(2026, 9, 17, 1, tzinfo=timezone.utc)

@contextmanager
def connection(path):
    conn=sqlite3.connect(path)
    try:
        with conn: yield conn
    finally: conn.close()

class SQLiteTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.dsn=str(Path(self.directory.name)/'store.sqlite3')
        self.store=SQLiteStore(self.dsn,clock=lambda:NOW)
        self.store.migrate()

    def tearDown(self):
        self.directory.cleanup()

    def test_edit_marks_human_even_when_text_matches_old_template(self):
        item=self.store.ingest(job())
        legacy_proposal(self.store, item)
        changed=self.store.review(item['id'],'edit',item['version'],text=item['proposal'])
        self.assertEqual(changed['draft_method'],'人工編輯')

    def test_receipts_unique_and_restart_preserves_manual_edits(self):
        item = self.store.ingest(job(), receipt_id='mail1')
        self.store.review(item['id'], 'edit', 1, text='Manual draft')
        self.store.review(item['id'], 'skip', 2, reason='Later')
        for receipt in ('mail1', 'mail2'):
            self.store.ingest(job(received_at='2026-09-17T01:00:00Z'), receipt_id=receipt)
        restarted = SQLiteStore(self.dsn, clock=lambda: NOW)
        result = restarted.list()
        self.assertEqual(len(result), 1)
        self.assertEqual((result[0]['proposal'], result[0]['version'], result[0]['skip_reason']), ('Manual draft', 2, 'Later'))
        with connection(self.dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM source_receipts').fetchone()[0], 2)
            self.assertEqual(conn.execute('SELECT count(*) FROM proposal_revisions').fetchone()[0], 1)

    def test_concurrent_ingest_and_edit_serialize(self):
        with ThreadPoolExecutor(4) as pool:
            items = list(pool.map(lambda _: self.store.ingest(job(), receipt_id='same'), range(4)))
        self.assertEqual(len(self.store.list()), 1)
        key = items[0]['id']
        barrier = Barrier(2)
        def edit(_):
            barrier.wait()
            try:
                self.store.review(key, 'edit', 1, text='Changed')
                return 'ok'
            except Conflict:
                return 'conflict'
        with ThreadPoolExecutor(2) as pool:
            self.assertCountEqual(list(pool.map(edit, range(2))), ['ok', 'conflict'])
        with self.assertRaises(Conflict):
            self.store.review(key, 'approve', 1)

    def test_notification_identity_keeps_manual_draft(self):
        item = self.store.ingest(job(receipt_id='m1:case'), receipt_id='m1:case')
        edited = self.store.review(item['id'], 'edit', 1, text='Keep manual draft')
        newer = self.store.ingest(job(receipt_id='m2:case'), receipt_id='m2:case')
        self.assertEqual((newer['proposal'], newer['version']), ('Keep manual draft', edited['version']))
        with connection(self.dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM source_receipts').fetchone()[0], 2)

    def test_unseen_older_notification_records_receipt_without_regression(self):
        item = self.store.ingest(job(receipt_id='new:case', received_at='2026-09-17T10:00:00Z', title='Current agent'), receipt_id='new:case')
        self.store.review(item['id'], 'edit', 1, text='Current proposal')
        stale_job = job(receipt_id='old:case', received_at='2026-09-17T09:00:00Z', title='Old agent')
        for _ in range(2):
            stale = self.store.ingest(stale_job, receipt_id='old:case')
            self.assertEqual(stale['job']['title'], 'Current agent')
            self.assertEqual((stale['proposal'], stale['version']), ('Current proposal', 2))
        with connection(self.dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM source_receipts').fetchone()[0], 2)

    def test_update_and_expiry_invalidate_approval(self):
        item = legacy_proposal(self.store, self.store.ingest(job(deadline='2026-09-17T02:00:00Z')))
        self.store.review(item['id'], 'approve', 1)
        changed = self.store.ingest(job(weekly_hours=40))
        self.assertIsNone(changed['approved_hash'])
        with self.assertRaises(InvalidAction):
            self.store.review(item['id'], 'approve', changed['version'])
        item = legacy_proposal(self.store, self.store.ingest(job(external_id='expiry', deadline='2026-09-17T02:00:00Z')))
        self.store.review(item['id'], 'approve', 1)
        later = SQLiteStore(self.dsn, clock=lambda: datetime(2026, 9, 17, 3, tzinfo=timezone.utc))
        expired = next(x for x in later.list() if x['id'] == item['id'])
        self.assertEqual(expired['review_status'], 'draft')
        self.assertIsNone(expired['approved_hash'])

    def test_tick_boundary_unique_snapshot_and_source_health(self):
        self.store.ingest(job())
        self.store.set_source_health('freelancer', 'failed')
        self.assertIsNone(daily_tick(self.store, 'test@example.invalid', NOW.replace(hour=0, minute=59)))
        with self.assertRaises(ValueError):
            daily_tick(self.store, 'test@example.invalid', NOW.replace(tzinfo=None))
        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda _: daily_tick(self.store, 'test@example.invalid', NOW), range(4)))
        self.assertEqual(len({x['id'] for x in results}), 1)
        intent = results[0]
        self.assertEqual(str(intent['local_date']), '2026-09-17')
        self.assertEqual(intent['snapshot']['sources']['freelancer'], 'failed')
        self.assertEqual(intent['snapshot']['sources']['toptal'], 'not_connected')
        self.store.ingest(job(title='AI agent changed'))
        self.store.set_source_health('freelancer', 'ok')
        self.assertEqual(daily_tick(self.store, 'test@example.invalid', NOW)['snapshot'], intent['snapshot'])
        with connection(self.dsn) as conn:
            with self.assertRaises(sqlite3.Error):
                conn.execute("UPDATE digest_outbox SET snapshot = '{}'")

    def test_all_matching_unseen_and_skip_excluded(self):
        for index in range(9):
            self.store.ingest(job(external_id=str(index)))
        item = self.store.ingest(job(external_id='skip'))
        self.store.review(item['id'], 'skip', 1, reason='no')
        self.store.ingest(job(external_id='excluded', weekly_hours=40))
        intent = daily_tick(self.store, 'test@example.invalid', NOW)
        self.assertEqual(len(intent['snapshot']['items']), 9)
        self.assertTrue(all(x['job']['external_id'] not in ('skip', 'excluded') for x in intent['snapshot']['items']))

    def test_unknown_and_crash_attempt_never_retry(self):
        intent = daily_tick(self.store, 'test@example.invalid', NOW)
        calls = []
        def timeout(snapshot):
            calls.append(snapshot)
            raise TimeoutError('uncertain')
        self.assertEqual(dispatch(self.store, intent['id'], timeout)['status'], 'unknown')
        restarted = SQLiteStore(self.dsn)
        dispatch(restarted, intent['id'], timeout)
        self.assertEqual(len(calls), 1)
        second = daily_tick(self.store, 'other@example.invalid', NOW)
        self.assertIsNotNone(self.store.claim_digest(second['id']))
        self.assertEqual(dispatch(restarted, second['id'], timeout)['status'], 'attempted')
        self.assertEqual(len(calls), 1)

    def test_concurrent_dispatch_calls_sender_once(self):
        intent = daily_tick(self.store, 'test@example.invalid', NOW)
        calls = []
        with ThreadPoolExecutor(4) as pool:
            list(pool.map(lambda _: dispatch(self.store, intent['id'], lambda snapshot: (calls.append(snapshot) or {'message_id': 'fake-123'})), range(4)))
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.store.get_digest(intent['id'])['status'], 'sent')

    def test_receipt_collision_rolls_back_listing(self):
        self.store.ingest(job(), receipt_id='same')
        with self.assertRaises(Conflict):
            self.store.ingest(job(external_id='different'), receipt_id='same')
        self.assertEqual(len(self.store.list()), 1)

    def test_missing_send_evidence_is_unknown(self):
        intent = daily_tick(self.store, 'test@example.invalid', NOW)
        self.assertEqual(dispatch(self.store, intent['id'], lambda snapshot: None)['status'], 'unknown')
        self.assertIsNone(self.store.claim_digest(intent['id']))

    def test_success_evidence_persists(self):
        intent = daily_tick(self.store, 'test@example.invalid', NOW)
        result = dispatch(self.store, intent['id'], lambda snapshot: {'message_id': 'fake-message-123'})
        self.assertEqual(result['delivery_receipt'], 'fake-message-123')

    def test_concurrent_approval_cannot_survive_edit(self):
        item = legacy_proposal(self.store, self.store.ingest(job()))
        barrier = Barrier(2)
        def approve():
            barrier.wait()
            try:
                self.store.review(item['id'], 'approve', 1)
            except Conflict:
                pass
        def edit():
            barrier.wait()
            self.store.review(item['id'], 'edit', 1, text='Replacement')
        with ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(approve), pool.submit(edit)]
            for future in futures:
                future.result()
        persisted = self.store.list()[0]
        self.assertEqual(persisted['version'], 2)
        self.assertIsNone(persisted['approved_hash'])
        self.assertEqual(persisted['review_status'], 'draft')

    def test_process_crash_after_attempt_commit_is_not_retried(self):
        import subprocess
        import sys
        intent = daily_tick(self.store, 'test@example.invalid', NOW)
        child = subprocess.run([sys.executable, '-c',
            "import os; from freelance.bootstrap.store import SQLiteStore; "
            "SQLiteStore(os.environ['FREELANCE_SQLITE_PATH']).claim_digest(os.environ['INTENT']); os._exit(23)"],
            env=os.environ | {'FREELANCE_SQLITE_PATH': self.dsn, 'INTENT': intent['id']}, capture_output=True)
        self.assertEqual(child.returncode, 23, child.stderr.decode())
        self.assertEqual(self.store.get_digest(intent['id'])['status'], 'attempted')
        self.assertIsNone(SQLiteStore(self.dsn).claim_digest(intent['id']))

    def test_opt_in_cli_migration_and_no_send_tick(self):
        import subprocess
        import sys
        import json
        env = os.environ | {'FREELANCE_SQLITE_PATH': self.dsn}
        migration = subprocess.run([sys.executable, '-m', 'freelance.bootstrap.store', '--migrate', '--database', self.dsn], env=env, capture_output=True, text=True)
        self.assertEqual(migration.returncode, 0, migration.stderr)
        self.assertIn('migration complete', migration.stdout)
        tick = subprocess.run([sys.executable, '-m', 'freelance.bootstrap.scheduler_cli', '--recipient', 'test@example.invalid', '--backend', 'sqlite', '--database', self.dsn],
                              env=env, capture_output=True, text=True)
        self.assertEqual(tick.returncode, 0, tick.stderr)
        result = json.loads(tick.stdout)
        self.assertIn(result['status'], ('pending', 'not_due'))
        with connection(self.dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM digest_outbox WHERE status <> 'pending'").fetchone()[0], 0)

    def test_replayed_old_receipt_does_not_revert_new_listing(self):
        item = self.store.ingest(job(title='API old'), receipt_id='old')
        updated = self.store.ingest(job(title='AI agent new'), receipt_id='new')
        edited = self.store.review(item['id'], 'edit', updated['version'], text='Latest manual draft')
        self.store.review(item['id'], 'approve', edited['version'])
        replayed = self.store.ingest(job(title='API old'), receipt_id='old')
        self.assertEqual(replayed['job']['title'], 'AI agent new')
        self.assertEqual(replayed['proposal'], 'Latest manual draft')
        self.assertEqual(replayed['review_status'], 'approved')
        self.assertEqual(replayed['version'], edited['version'])

    def test_listing_update_preserves_skip_until_manual_edit(self):
        item = self.store.ingest(job(), receipt_id='first')
        self.store.review(item['id'], 'skip', 1, reason='Not interested in client')
        updated = self.store.ingest(job(budget_max=9000), receipt_id='updated')
        self.assertEqual(updated['version'], 2)
        self.assertEqual(updated['review_status'], 'skipped')
        self.assertEqual(updated['skip_reason'], 'Not interested in client')
        restarted = SQLiteStore(self.dsn, clock=lambda: NOW)
        self.assertEqual(restarted.list()[0]['skip_reason'], 'Not interested in client')
        intent = daily_tick(restarted, 'test@example.invalid', NOW)
        self.assertEqual(intent['snapshot']['items'], [])
        reopened = restarted.review(item['id'], 'edit', 2, text='Reconsidered draft')
        self.assertEqual(reopened['review_status'], 'draft')
        next_intent = daily_tick(restarted, 'other@example.invalid', NOW)
        self.assertEqual(len(next_intent['snapshot']['items']), 1)

    def test_missing_database_is_not_implicitly_created(self):
        missing=Path(self.directory.name)/'missing.sqlite3'
        with self.assertRaises((ValueError,OSError,sqlite3.Error)):
            SQLiteStore(missing).list()
        self.assertFalse(missing.exists())

    def test_file_private_and_foreign_keys_enforced(self):
        self.assertEqual(Path(self.dsn).stat().st_mode & 0o777,0o600)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store._connect() as conn:
                conn.execute("INSERT INTO source_receipts(source,receipt_id,opportunity_id) VALUES ('tasker','bad','missing')")

    def test_waiting_migration_preserves_legacy_health_and_existing_jobs(self):
        item=self.store.ingest(job(),receipt_id='before-migration')
        with connection(self.dsn) as c:
            c.execute('DROP TABLE source_health')
            c.execute("CREATE TABLE source_health(source text PRIMARY KEY,status text NOT NULL CHECK(status IN ('not_connected','ok','failed')),checked_at text NOT NULL DEFAULT CURRENT_TIMESTAMP)")
            c.execute("INSERT INTO source_health VALUES ('tasker','ok','2026-09-26 00:00:00')")
        self.store.migrate();self.store.migrate()
        self.store.set_source_health('linkedin','waiting')
        self.assertEqual(self.store.sources()['linkedin'],'waiting')
        self.assertEqual(self.store.sources()['tasker'],'ok')
        self.assertEqual(self.store.list()[0]['id'],item['id'])
        with connection(self.dsn) as c:
            self.assertEqual(c.execute("SELECT checked_at FROM source_health WHERE source='tasker'").fetchone()[0],'2026-09-26 00:00:00')
            self.assertEqual(c.execute('SELECT count(*) FROM source_receipts').fetchone()[0],1)
