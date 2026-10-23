from fixtures.daily_setup import DailyTestsFixture
from fixtures.daily import NOW
import freelance.bootstrap.daily_cli as daily_command
import contextlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from freelance.bootstrap.store import SQLiteStore
import freelance.modules.notifications.daily as daily
from fixtures.gmail import Client, mail


class DailyTests(DailyTestsFixture, unittest.TestCase):




    def test_before_taipei_nine_does_not_open_mail_or_claim(self):
        result=daily.run_daily(self.store,self.client,recipient='test@example.invalid',output_dir=self.root,now=NOW.replace(hour=0,minute=59))
        self.assertEqual(result['status'],'not_due')
        self.assertEqual(self.calls,[])
        self.assertIsNone(self.store.get_daily_run('2026-09-17','test@example.invalid'))

    def test_run_imports_once_and_writes_private_unsent_snapshot(self):
        result=self.run_daily()
        self.assertEqual(result['status'],'digest_ready')
        output=Path(result['output']);self.assertEqual(output.stat().st_mode&0o777,0o600)
        self.assertIn('尚未寄出',output.read_text())
        self.assertEqual(len(self.store.list()),1)
        record=self.store.get_daily_run('2026-09-17','test@example.invalid')
        self.assertEqual(record['status'],'complete')
        self.assertEqual(self.store.get_digest(record['result']['intent_id'])['status'],'pending')
        repeated=daily.run_daily(SQLiteStore(self.root/'daily.sqlite3'),self.client,recipient='test@example.invalid',output_dir=self.root,now=NOW)
        self.assertEqual(repeated['status'],'already_run')
        self.assertEqual(len(self.calls),1)

    def test_concurrent_invocations_only_one_reads_mail(self):
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda _:self.run_daily(),range(2)))
        self.assertCountEqual([r['status'] for r in results],['digest_ready','already_run'])
        self.assertEqual(len(self.calls),1)

    def test_unknown_template_keeps_source_failure_visible_and_no_auto_retry(self):
        @contextlib.contextmanager
        def bad():
            yield Client({None:{'messages':[{'id':'bad'}]}},{'bad':mail('bad',body='PRIVATE BODY')})
        result=daily.run_daily(self.store,bad,recipient='test@example.invalid',output_dir=self.root,now=NOW)
        self.assertEqual(result['status'],'source_failed')
        self.assertEqual(result['source_reason'],'source_read_failed')
        self.assertIn('讀取失敗',Path(result['output']).read_text())
        self.assertNotIn('PRIVATE',json.dumps(result))
        self.assertEqual(self.run_daily()['status'],'already_run')
        self.assertEqual(self.calls,[])

    def test_auth_failure_is_content_free_and_creates_failed_source_digest(self):
        @contextlib.contextmanager
        def bad():
            raise RuntimeError('PRIVATE credential')
            yield
        result=daily.run_daily(self.store,bad,recipient='test@example.invalid',output_dir=self.root,now=NOW)
        self.assertEqual(result['status'],'source_failed')
        self.assertNotIn('PRIVATE',json.dumps(result))
        self.assertEqual(self.store.sources()['tasker'],'failed')

    def test_inflight_claim_survives_restart_without_second_read(self):
        self.assertTrue(self.store.claim_daily_run('2026-09-17','test@example.invalid',NOW))
        result=self.run_daily()
        self.assertEqual(result['status'],'already_run')
        self.assertEqual(result['run_status'],'running')
        self.assertEqual(self.calls,[])

    def test_bad_output_directory_does_not_read_or_claim(self):
        with self.assertRaises(ValueError):
            daily.run_daily(self.store,self.client,recipient='test@example.invalid',output_dir=self.root/'missing',now=NOW)
        self.assertEqual(self.calls,[])
        self.assertIsNone(self.store.get_daily_run('2026-09-17','test@example.invalid'))

    def test_cli_requires_explicit_live_read_before_token_access(self):
        with patch.object(daily,'open_session',side_effect=AssertionError('token accessed')),contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                daily_command.main(['--database',str(self.root/'daily.sqlite3'),'--token','unused','--expected-email','test@example.invalid','--recipient','test@example.invalid','--output-dir',str(self.root)])

    def test_interruption_after_claim_prevents_automatic_second_scan(self):
        @contextlib.contextmanager
        def interrupted():
            raise KeyboardInterrupt()
            yield
        with self.assertRaises(KeyboardInterrupt):
            daily.run_daily(self.store,interrupted,recipient='test@example.invalid',output_dir=self.root,now=NOW)
        self.assertEqual(self.run_daily()['run_status'],'running')
        self.assertEqual(self.calls,[])

    def test_existing_daily_snapshot_is_reused_without_another_mail_scan(self):
        from freelance.modules.notifications.scheduler import daily_tick
        intent=daily_tick(self.store,'test@example.invalid',NOW)
        result=self.run_daily()
        self.assertEqual(result['status'],'existing_digest')
        self.assertEqual(result['intent_id'],intent['id'])
        self.assertEqual(self.calls,[])
        self.assertTrue(Path(result['output']).exists())


    def test_digest_does_not_create_proposals(self):
        result=self.run_daily()
        self.assertEqual(result['delivery_status'],'pending')
        self.assertNotIn('ai_drafts',result)
        self.assertNotIn('proposal', self.store.get_digest(result['intent_id'])['snapshot']['items'][0])
        with self.store._connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM proposal_revisions').fetchone()['n'], 0)
