"""Full parser -> pagination -> isolated PostgreSQL checks, no mailbox access."""
import unittest
import contextlib
import io
import json
from unittest.mock import patch

import fixtures.postgres_setup as pg
from fixtures.gmail import Client, mail
from fixtures.tasker import listing
from freelance.modules.collection.gmail import sync_tasker
import freelance.bootstrap.mail_sync as gmail_sync
from fixtures.gmail_transport import Response, Session


@unittest.skipUnless(pg.DSN, 'set FREELANCE_TEST_DSN to an isolated PostgreSQL database')
class GmailPostgresTests(unittest.TestCase):
    setUp = pg.PostgresTestsFixture.setUp
    tearDown = pg.PostgresTestsFixture.tearDown

    def test_repeated_pages_and_new_notification_preserve_manual_draft(self):
        client = Client({None: {'messages': [{'id': 'a'}], 'nextPageToken': 'p'},
                         'p': {'messages': [{'id': 'a'}, {'id': 'b'}]}},
                        {'a': mail('a'), 'b': mail('b', '1789603200001')})
        self.assertEqual(sync_tasker(client, self.store)['status'], 'ok')
        item, = self.store.list()
        self.assertEqual(item['version'], 1)
        self.store.review(item['id'], 'edit', 1, text='我的手動提案')
        restarted = pg.PostgresStore(self.dsn, clock=lambda: pg.NOW)
        self.assertEqual(sync_tasker(client, restarted)['status'], 'ok')
        new = Client({None: {'messages': [{'id': 'c'}]}}, {'c': mail('c', '1789603200002')})
        self.assertEqual(sync_tasker(new, restarted)['status'], 'ok')
        result, = restarted.list()
        self.assertEqual((result['proposal'], result['version']), ('我的手動提案', 2))
        self.assertEqual(result['evaluation']['status'], 'needs_info')
        with pg.psycopg.connect(self.dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM source_receipts').fetchone()[0], 3)
        self.assertEqual(restarted.sources()['tasker'], 'ok')
        self.assertEqual(restarted.sources()['freelancer'], 'not_connected')

    def test_late_older_mail_does_not_revert_new_requirements(self):
        newer = Client({None: {'messages': [{'id': 'new'}]}},
                       {'new': mail('new', '1789603200001', listing(description='目前需求 API'))})
        older = Client({None: {'messages': [{'id': 'old'}]}},
                       {'old': mail('old', '1789603200000', listing(description='過期需求網站'))})
        self.assertEqual(sync_tasker(newer, self.store)['status'], 'ok')
        self.assertEqual(sync_tasker(older, self.store)['status'], 'ok')
        item, = self.store.list()
        self.assertEqual(item['job']['description'], '目前需求 API')
        self.assertEqual(item['version'], 1)

    def test_failed_scan_does_not_report_zero_success_in_digest(self):
        good = Client({None: {'messages': [{'id': 'good'}]}}, {'good': mail('good')})
        self.assertEqual(sync_tasker(good, self.store)['status'], 'ok')
        bad = Client({None: {'messages': [{'id': 'bad'}]}}, {'bad': mail('bad', body='Unknown template')})
        self.assertEqual(sync_tasker(bad, self.store)['status'], 'failed')
        intent = pg.daily_tick(self.store, 'test@example.invalid', pg.NOW)
        self.assertEqual(intent['snapshot']['sources']['tasker'], 'failed')
        self.assertEqual(len(intent['snapshot']['items']), 1)

    def test_explicit_apply_cli_uses_transport_parser_and_database(self):
        class ClosableSession(Session):
            closed = False
            def close(self): self.closed = True
        for _ in range(2):
            session = ClosableSession([
                Response({'emailAddress':'test@example.invalid'}),
                Response({'messages':[{'id':'a'}]}), Response(mail('a'))])
            output = io.StringIO()
            with patch.dict('os.environ',{'FREELANCE_DATABASE_URL':self.dsn}), patch.object(gmail_sync,'open_session',return_value=session), contextlib.redirect_stdout(output):
                code = gmail_sync.main(['--apply','--live-read','--token','synthetic',
                                       '--expected-email','test@example.invalid'])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.getvalue())['status'], 'ok')
            self.assertTrue(session.closed)
        item, = self.store.list()
        self.assertEqual(item['version'], 1)
        self.assertEqual(item['evaluation']['status'], 'needs_info')
        with pg.psycopg.connect(self.dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM source_receipts').fetchone()[0], 1)
