"""Synthetic AI worker acceptance against real SQLite; no credentials or network."""
import tempfile
import unittest
import sqlite3
import os
from unittest.mock import patch
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from datetime import datetime, timedelta, timezone
from pathlib import Path

import freelance.legacy.ai_drafts as ai_drafts
from freelance.bootstrap.store import SQLiteStore
from fixtures.domain import job, legacy_proposal

NOW = datetime(2026, 9, 18, 17, tzinfo=timezone.utc)
RESULT = dict(proposal='AI proposal for human review', questions=['Confirm milestones'],
              requires_review=True, method='Antigravity CLI', status='draft')
DESCRIPTION = 'Build an AI agent with API integration, tests, deployment, and a documented review workflow for the client.'


def run_process(path):
    return ai_drafts.run(SQLiteStore(path, clock=lambda: NOW), 'owner@example.test',
                         lambda listing: dict(RESULT), now=NOW)


class AIDraftTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'test.sqlite3'
        self.store = SQLiteStore(self.path, clock=lambda: NOW)
        self.store.migrate()

    def add(self, *, interested=False, **changes):
        item = self.store.ingest(job(**(dict(description=DESCRIPTION, published_at=NOW.isoformat()) | changes)))
        item = legacy_proposal(self.store, item)
        if interested:
            self.store.track(item['id'], 0, feedback='interested')
        return item

    def run_batch(self, generate=lambda listing: dict(RESULT), **kwargs):
        return ai_drafts.run(self.store, 'owner@example.test', generate, now=NOW, **kwargs)

    def attempts(self):
        with self.store._connect() as conn:
            return conn.execute('SELECT * FROM ai_draft_attempts').fetchall()

    def test_interested_first_even_after_digest_and_beyond_prewrite_budget(self):
        for i in range(4):
            self.add(external_id=str(i))
        self.assertEqual(self.run_batch()['succeeded'], 2)
        digest = self.store.create_digest(NOW.date(), 'owner@example.test', NOW)
        self.store.claim_digest(digest['id'])
        self.store.finish_digest(digest['id'], 'sent', receipt='provider-id')
        remaining = [x for x in self.store.list() if x['draft_method'].startswith('範本')]
        for item in remaining:
            self.store.track(item['id'], 0, feedback='interested')
        self.assertEqual(self.run_batch()['succeeded'], 2)
        self.assertEqual(len(self.attempts()), 4)
        self.assertEqual(self.run_batch(lambda _: self.fail('replayed'))['attempted'], 0)
        next_digest = self.store.create_digest(NOW.date() + timedelta(days=1), 'owner@example.test', NOW + timedelta(days=1))
        self.assertEqual(next_digest['snapshot']['items'], [])

    def test_interested_has_priority_over_higher_scored_prewrite(self):
        high = self.add(external_id='high')
        low = self.add(external_id='low', title='Backend API', description='Build an API service.', interested=True)
        self.assertEqual(self.run_batch(limit=1)['succeeded'], 1)
        rows = {x['id']: x for x in self.store.list()}
        self.assertEqual(rows[low['id']]['proposal'], RESULT['proposal'])
        self.assertNotEqual(rows[high['id']]['proposal'], RESULT['proposal'])

    def test_low_information_not_preprinted(self):
        self.add(external_id='thin', description='Build API', taiwan_eligible=None)
        self.assertEqual(self.run_batch()['attempted'], 0)

    def test_failure_keeps_template_and_does_not_retry(self):
        item = self.add(interested=True)
        result = self.run_batch(lambda _: (_ for _ in ()).throw(RuntimeError('PRIVATE')))
        self.assertEqual(result, dict(attempted=1, succeeded=0, failed=1, stale=0))
        self.assertEqual(self.store.list()[0]['proposal'], item['proposal'])
        self.assertNotIn('PRIVATE', str(self.attempts()))
        self.assertEqual(self.run_batch(lambda _: self.fail('retry'))['attempted'], 0)

    def test_invalid_result_and_inflight_user_change_do_not_overwrite(self):
        item = self.add(interested=True)
        def change(_):
            self.store.track(item['id'], 1, feedback='skipped', reason='other', note='No')
            return dict(RESULT)
        self.assertEqual(self.run_batch(change)['stale'], 1)
        self.assertNotEqual(self.store.list()[0]['proposal'], RESULT['proposal'])
        second = self.add(external_id='second', interested=True)
        self.assertEqual(self.run_batch(lambda _: RESULT | {'requires_review': False})['failed'], 1)
        self.assertEqual(next(x for x in self.store.list() if x['id'] == second['id'])['proposal'], second['proposal'])

    def test_processes_share_prewrite_budget(self):
        for i in range(8):
            self.add(external_id=str(i))
        with ProcessPoolExecutor(3, mp_context=get_context('spawn')) as pool:
            results = list(pool.map(run_process, [str(self.path)] * 3))
        self.assertEqual(sum(x['succeeded'] for x in results), 2)
        self.assertEqual(len(self.attempts()), 2)

    def test_interruption_is_not_retried_automatically(self):
        self.add(interested=True)
        with self.assertRaises(KeyboardInterrupt):
            self.run_batch(lambda _: (_ for _ in ()).throw(KeyboardInterrupt()))
        self.assertEqual(self.attempts()[0]['status'], 'attempted')
        self.assertEqual(self.run_batch(lambda _: self.fail('replayed'))['attempted'], 0)

    def test_deadline_during_generation_discards_result(self):
        clock = [NOW]
        self.store.clock = lambda: clock[0]
        item = self.add(interested=True, deadline=(NOW + timedelta(seconds=1)).isoformat())
        def generate(_):
            clock[0] = NOW + timedelta(seconds=2)
            return dict(RESULT)
        self.assertEqual(self.run_batch(generate)['stale'], 1)
        self.assertEqual(self.store.list()[0]['proposal'], item['proposal'])

    def test_limits_are_execution_and_prewrite_separate(self):
        for i in range(3):
            self.add(external_id=str(i), interested=True)
        self.assertEqual(self.run_batch(limit=1, prewrite_per_day=0)['succeeded'], 1)
        self.assertEqual(self.run_batch(limit=1, prewrite_per_day=0)['succeeded'], 1)
        for value in (-1, 21, True, 1.5):
            with self.assertRaises(ValueError):
                self.run_batch(limit=value)

    def test_old_sqlite_schema_migrates_without_losing_attempts(self):
        legacy = Path(self.directory.name) / 'legacy.sqlite3'
        schema = (__import__('importlib.resources', fromlist=['files']).files('freelance.platform').joinpath('schema/001_sqlite.sql')).read_text()
        schema = schema.replace("    priority text NOT NULL CHECK (priority IN ('interested', 'prewrite', 'legacy')),\n", '')
        schema = schema.replace('PRIMARY KEY (opportunity_id, fingerprint, priority)',
                                'PRIMARY KEY (opportunity_id, fingerprint)')
        connection = sqlite3.connect(legacy)
        connection.executescript(schema)
        connection.close()
        os.chmod(legacy, 0o600)
        store = SQLiteStore(legacy, clock=lambda: NOW)
        item = store.ingest(job())
        with store._connect() as conn:
            conn.execute("""INSERT INTO ai_draft_attempts
                (opportunity_id,fingerprint,version,local_date,recipient,status,attempted_at)
                VALUES (?,?,?,?,?,'succeeded',?)""",
                (item['id'], item['fingerprint'], 1, '2026-09-19', 'owner@example.test', NOW.isoformat()))
        store.migrate()
        with store._connect() as conn:
            columns = {row['name'] for row in conn.execute('PRAGMA table_info(ai_draft_attempts)')}
            old = conn.execute('SELECT status, priority FROM ai_draft_attempts WHERE opportunity_id=?',
                               (item['id'],)).fetchone()
        self.assertIn('priority', columns)
        self.assertEqual(old, {'status': 'succeeded', 'priority': 'legacy'})

    def test_interested_request_can_retry_failed_prewrite_once(self):
        item = self.add()
        self.assertEqual(self.run_batch(lambda _: None)['failed'], 1)
        self.store.track(item['id'], 0, feedback='interested')
        self.assertEqual(self.run_batch()['succeeded'], 1)
        self.assertEqual({row['priority'] for row in self.attempts()}, {'prewrite', 'interested'})
        self.assertEqual(self.run_batch(lambda _: self.fail('replayed'))['attempted'], 0)

    def test_time_budget_stops_before_claiming_next_item(self):
        for i in range(3):
            self.add(external_id=str(i), interested=True)
        with patch('freelance.legacy.ai_drafts.monotonic', side_effect=[0, 0, 2]):
            self.assertEqual(self.run_batch(max_seconds=1)['attempted'], 1)
        self.assertEqual(len(self.attempts()), 1)

    def test_interest_and_ai_failure_do_not_reannounce_seen_job(self):
        item = self.add(description='Build API', taiwan_eligible=None)
        first = self.store.create_digest(NOW.date(), 'owner@example.test', NOW)
        self.store.claim_digest(first['id'])
        self.store.finish_digest(first['id'], 'sent', receipt='provider-id')
        self.store.track(item['id'], 0, feedback='interested')
        second = self.store.create_digest(NOW.date() + timedelta(days=1), 'owner@example.test', NOW + timedelta(days=1))
        self.assertEqual(second['snapshot']['items'], [])
        self.store.claim_digest(second['id'])
        self.store.finish_digest(second['id'], 'sent', receipt='provider-id')
        self.assertEqual(self.run_batch(lambda _: None)['failed'], 1)
        third = self.store.create_digest(NOW.date() + timedelta(days=2), 'owner@example.test', NOW + timedelta(days=2))
        self.assertEqual(third['snapshot']['items'], [])
