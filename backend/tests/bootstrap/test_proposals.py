"""Pure text templates and immutable user-authored draft versions."""
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
import sqlite3

from freelance.bootstrap.store import SQLiteStore
from freelance.platform.errors import Conflict, InvalidAction
from freelance.modules.proposals.public import render
from freelance.modules.discovery.public import group_items, is_candidate
from fixtures.domain import job


class ProposalTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=SQLiteStore(Path(self.tmp.name)/'app.sqlite',clock=lambda:datetime(2026,10,1,tzinfo=timezone.utc))
        self.store.migrate()

    def draft(self,**changes):
        command=dict(request_id='draft',title='合成提案',body='本人稿',template_id=None,template_revision=None,values={},versions={},party=None)
        command.update(changes)
        return self.store.create_proposal(command)

    def test_render_whitelist_missing_values_and_untrusted_literal(self):
        output=render('Hi {client_name}: {approach}; {quote}',dict(client_name='客戶',approach='$(fake-command)'))
        self.assertEqual(output['missing'],['quote'])
        self.assertIn('$(fake-command)',output['body'])
        self.assertIn('【待填：quote】',output['body'])
        for template in ('{client_name.__class__}','{quote!r}','{quote:10}','{__import__}', '{'):
            with self.subTest(template=template),self.assertRaises(InvalidAction):render(template,{})
        with self.assertRaises(InvalidAction):render('{quote}',dict(secret='ignored'))

    def test_template_revision_archive_and_history(self):
        templates=self.store.proposals
        first=templates.create_template(dict(request_id='template',name='合成',body='Hi {client_name}'))
        self.assertEqual(templates.create_template(dict(request_id='template',name='合成',body='Hi {client_name}'))['id'],first['id'])
        draft=self.draft(body=None,template_id=first['id'],template_revision=1,values={'client_name':'本人填寫'})
        templates.update_template(first['id'],dict(revision=1,name='新名',body='New {client_name}'))
        self.assertEqual(self.store.proposals.get(draft['id'])['versions'][0]['body'],'Hi 本人填寫')
        with self.assertRaises(Conflict):self.draft(request_id='stale',body=None,template_id=first['id'],template_revision=1)
        templates.archive_template(first['id'],2)
        self.assertEqual(templates.list_templates()['total'],0)
        self.assertEqual(templates.get_template(first['id'])['revision'],3)

    def test_draft_replay_append_versions_and_stale_edit(self):
        first=self.draft()
        self.assertEqual(self.draft()['id'],first['id'])
        with self.assertRaises(Conflict):self.draft(body='不同稿')
        command=dict(revision=1,request_id='edit',body='第二稿')
        updated=self.store.proposals.append(first['id'],command)
        self.assertEqual([r['body'] for r in updated['versions']],['本人稿','第二稿'])
        self.assertEqual(self.store.proposals.append(first['id'],command)['revision'],2)
        with self.assertRaises(Conflict):self.store.proposals.append(first['id'],dict(revision=1,request_id='stale',body='過期'))
        with self.assertRaises(Conflict):self.store.proposals.append(first['id'],dict(command,body='衝突'))
        self.assertEqual(updated['versions'][0]['version'],1)

    def test_source_snapshot_and_no_candidate_or_digest_change(self):
        self.store.ingest(job());group,=group_items(self.store.list())
        versions={m['id']:m['token'] for m in group['members']}
        before=self.store.create_digest('2026-10-01','owner@example.test',self.store.clock())
        draft=self.draft(versions=versions)
        self.assertEqual(draft['source_snapshot']['job']['title'],group['job']['title'])
        self.assertTrue(is_candidate(group_items(self.store.list())[0]))
        self.assertEqual(self.store.application_summary()['weekly_count'],0)
        self.assertEqual(self.store.get_digest(before['id'])['snapshot'],before['snapshot'])
        self.store.feedback(group['id'],versions,'interested')
        with self.assertRaises(Conflict):self.draft(request_id='stale',versions=versions)
        self.assertEqual(self.store.proposals.get(draft['id'])['versions'][0]['body'],'本人稿')

    def test_draft_party_snapshot_and_missing_template_values(self):
        client=self.store.relationships.create_client(dict(request_id='client',name='合成',note=''))
        template=self.store.proposals.create_template(dict(request_id='template',name='報價',body='{quote}'))
        draft=self.draft(body=None,template_id=template['id'],template_revision=1,party=dict(client_id=client['id'],client_revision=1,contact_id=None,contact_revision=None))
        self.assertEqual(draft['party']['client_name'],'合成')
        self.assertEqual(draft['versions'][0]['missing'],['quote'])
        self.store.relationships.archive_client(client['id'],1)
        self.assertEqual(self.store.proposals.get(draft['id'])['party']['client_name'],'合成')

    def test_version_insert_failure_rolls_back_metadata_and_edit(self):
        first=self.draft()
        with self.store.database.connect() as conn:
            conn.execute("CREATE TRIGGER fail_draft BEFORE INSERT ON proposal_draft_revisions BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.draft(request_id='failed')
        with self.assertRaises(sqlite3.IntegrityError):self.store.proposals.append(first['id'],dict(revision=1,request_id='edit',body='失敗'))
        self.assertEqual(self.store.proposals.list()['total'],1)
        self.assertEqual(self.store.proposals.get(first['id'])['revision'],1)

    def test_archive_keeps_history_prevents_edit_and_replay_resurrection(self):
        first=self.draft()
        self.store.proposals.archive(first['id'],1)
        self.assertEqual(self.store.proposals.list()['total'],0)
        self.assertIsNotNone(self.draft()['archived_at'])
        self.assertEqual(self.store.proposals.get(first['id'])['versions'][0]['body'],'本人稿')
        with self.assertRaises(Conflict):self.store.proposals.append(first['id'],dict(revision=2,request_id='edit',body='復活'))

    def test_direct_history_rewrite_and_delete_rejected(self):
        first=self.draft()
        for sql in ('UPDATE proposal_draft_revisions SET body=\'overwrite\' WHERE draft_id=?',
                    'DELETE FROM proposal_draft_revisions WHERE draft_id=?'):
            with self.subTest(sql=sql),self.assertRaises(sqlite3.IntegrityError),self.store.database.connect() as conn:
                conn.execute(sql,(first['id'],))

    def test_reapply_template_appends_and_records_exact_template_revision(self):
        first=self.draft()
        template=self.store.proposals.create_template(dict(request_id='template',name='本人模板',body='{quote}'))
        updated=self.store.proposals.apply_template(first['id'],dict(revision=1,request_id='apply',template_id=template['id'],template_revision=1,values={'quote':'TWD 5000'}))
        self.assertEqual([r['body'] for r in updated['versions']],['本人稿','TWD 5000'])
        self.assertEqual(updated['versions'][1]['template_snapshot']['revision'],1)
