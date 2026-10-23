import contextlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from fixtures.gmail import Client, mail
import freelance.bootstrap.mail_sync as gmail_sync


class GmailSyncTests(unittest.TestCase):
    def test_preview_cap_reports_incomplete_without_fetching_extra_mail(self):
        client = Client({None: {'messages': [{'id':'a'}, {'id':'b'}], 'nextPageToken':'p'}},
                        {'a':mail('a')})
        result = gmail_sync.preview_tasker(client, max_messages=1)
        self.assertEqual(result['status'], 'preview_limited')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['items']), 1)
        self.assertNotIn('proposal', result['items'][0])
        self.assertEqual(result['items'][0]['evaluation']['status'], 'needs_info')

    def test_preview_pages_deduplicate_and_do_not_claim_delivery(self):
        client = Client({None: {'messages':[{'id':'a'}], 'nextPageToken':'p'},
                         'p': {'messages':[{'id':'a'},{'id':'b'}]}},
                        {'a':mail('a'), 'b':mail('b')})
        result = gmail_sync.preview_tasker(client)
        self.assertEqual(result['status'], 'preview_complete')
        self.assertEqual(result['messages'], 2)
        self.assertFalse(result['truncated'])
        self.assertTrue(all(set(x) == {'job', 'evaluation'} for x in result['items']))

    def test_preview_rejects_mismatched_message(self):
        for response in [mail('wrong')]:
            with self.subTest(response_id=response['id']):
                client = Client({None:{'messages':[{'id':'a'}]}}, {'a':response})
                with self.assertRaises(gmail_sync.SyncError) as error:
                    gmail_sync.preview_tasker(client)
                self.assertNotIn('PRIVATE',str(error.exception))

    def test_bad_template_preserves_other_drafts_and_reports_partial(self):
        client = Client({None: {'messages': [{'id':'a'}, {'id':'bad'}, {'id':'b'}],
                                'nextPageToken':'more'}},
                        {'a':mail('a'), 'bad':mail('bad',body='PRIVATE BODY'), 'b':mail('b')})
        result = gmail_sync.preview_tasker(client, max_messages=3)
        self.assertEqual(result['status'], 'preview_partial')
        self.assertTrue(result['truncated'])
        self.assertEqual(result['messages'], 3)
        self.assertEqual([x['job']['receipt_id'] for x in result['items']], ['a:Ab123','b:Ab123'])
        self.assertEqual(result['unsupported_messages'], [{'message_id':'bad','reason':'unsupported_notification'}])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_all_unsupported_is_not_an_empty_success(self):
        client=Client({None:{'messages':[{'id':'bad'}]}}, {'bad':mail('bad',body='PRIVATE BODY')})
        result=gmail_sync.preview_tasker(client)
        self.assertEqual(result['status'],'preview_partial')
        self.assertEqual(result['items'],[])
        self.assertFalse(result['truncated'])
        self.assertEqual(len(result['unsupported_messages']),1)

    def test_network_failure_still_aborts_instead_of_becoming_unsupported(self):
        class BrokenClient(Client):
            def get_message(self, mid):
                raise RuntimeError('PRIVATE response')
        with self.assertRaises(gmail_sync.SyncError) as error:
            gmail_sync.preview_tasker(BrokenClient({None:{'messages':[{'id':'a'}]}},{}))
        self.assertNotIn('PRIVATE',str(error.exception))

    def test_preview_empty_and_cycles_are_distinct(self):
        self.assertEqual(gmail_sync.preview_tasker(Client({None:{}},{}))['status'],'preview_complete')
        cycle=Client({None:{'nextPageToken':'p'},'p':{'nextPageToken':'p'}},{})
        with self.assertRaises(gmail_sync.SyncError):
            gmail_sync.preview_tasker(cycle)

    def test_live_optin_required_before_token_access(self):
        with patch.object(gmail_sync,'open_session') as loader, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                gmail_sync.main(['--preview','--token','never-read','--expected-email','test@example.com','--output','unused'])
        loader.assert_not_called()

    def test_preview_cli_saves_private_sanitized_file_and_closes_session(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'preview.json'
            class Session:
                closed=False
                def close(self): self.closed=True
            session=Session()
            client=Client({None:{'messages':[{'id':'a'}]}},{'a':mail('a')})
            output=io.StringIO()
            with patch.object(gmail_sync,'open_session',return_value=session), patch.object(gmail_sync,'GmailTransport',return_value=client), contextlib.redirect_stdout(output):
                code=gmail_sync.main(['--preview','--live-read','--token','synthetic','--expected-email','test@example.com','--output',str(target)])
            self.assertEqual(code,0)
            self.assertTrue(session.closed)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o600)
            saved=json.loads(target.read_text())
            self.assertEqual(saved['items'][0]['job']['description'],'串接 API 與建立網站。')
            self.assertNotIn('private=fake',target.read_text())
            self.assertNotIn('串接 API',output.getvalue())

    def test_cli_partial_preview_saves_valid_drafts_without_logging_message_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'partial.json'
            class Session:
                def close(self): pass
            client=Client({None:{'messages':[{'id':'good'},{'id':'private-id'}]}},
                          {'good':mail('good'),'private-id':mail('private-id',body='PRIVATE BODY')})
            output=io.StringIO()
            with patch.object(gmail_sync,'open_session',return_value=Session()), patch.object(gmail_sync,'GmailTransport',return_value=client), contextlib.redirect_stdout(output):
                code=gmail_sync.main(['--preview','--live-read','--token','synthetic','--expected-email','test@example.com','--output',str(target)])
            self.assertEqual(code,0)
            saved=json.loads(target.read_text())
            self.assertEqual(saved['status'],'preview_partial')
            self.assertEqual(len(saved['items']),1)
            self.assertEqual(len(saved['unsupported_messages']),1)
            self.assertEqual(json.loads(output.getvalue())['unsupported_messages'],1)
            self.assertNotIn('private-id',output.getvalue())
            self.assertNotIn('PRIVATE BODY',target.read_text())

    def test_existing_preview_is_not_overwritten_or_mail_read(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'preview.json';target.write_text('keep')
            with patch.object(gmail_sync,'open_session') as loader, contextlib.redirect_stderr(io.StringIO()):
                result=gmail_sync.main(['--preview','--live-read','--token','unused','--expected-email','test@example.com','--output',str(target)])
            self.assertEqual(result,1)
            loader.assert_not_called()
            self.assertEqual(target.read_text(),'keep')

    def test_apply_requires_explicit_database_before_token_access(self):
        with patch.dict('os.environ',{},clear=True), patch.object(gmail_sync,'open_session') as loader, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                gmail_sync.main(['--apply','--live-read','--token','unused','--expected-email','test@example.com'])
        loader.assert_not_called()


    def test_sqlite_apply_requires_explicit_path_before_token_access(self):
        with patch.object(gmail_sync,'open_session',side_effect=AssertionError('token touched')), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                gmail_sync.main(['--apply','--backend','sqlite','--live-read','--token','unused','--expected-email','test@example.com'])

    def test_sqlite_apply_persists_with_receipt_deduplication(self):
        from freelance.bootstrap.store import SQLiteStore
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'jobs.sqlite3'
            store=SQLiteStore(path);store.migrate()
            class Session:
                def close(self): pass
            client=Client({None:{'messages':[{'id':'a'}]}},{'a':mail('a')})
            for _ in range(2):
                with patch.object(gmail_sync,'open_session',return_value=Session()), patch.object(gmail_sync,'GmailTransport',return_value=client), contextlib.redirect_stdout(io.StringIO()):
                    code=gmail_sync.main(['--apply','--backend','sqlite','--database',str(path),'--live-read','--token','synthetic','--expected-email','test@example.com'])
                self.assertEqual(code,0)
            self.assertEqual(len(store.list()),1)
            self.assertEqual(store.sources()['tasker'],'ok')

if __name__=='__main__':
    unittest.main()
