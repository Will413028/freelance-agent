"""Precise consent, durable attempts and uncertain effects never retried."""
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
import sqlite3
from freelance.bootstrap.store import SQLiteStore
from freelance.platform.errors import Conflict, InvalidAction
from freelance.bootstrap.submissions import execute
from freelance.modules.discovery.public import group_items
from fixtures.domain import job


class SubmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=SQLiteStore(Path(self.tmp.name)/'app.sqlite',clock=lambda:datetime(2026,10,1,tzinfo=timezone.utc))
        self.store.migrate()
        self.draft=self.store.create_proposal(dict(request_id='draft',title='合成稿',body='本人確認的合成內容',template_id=None,template_revision=None,values={},versions={},party=None))
        self.calls=[]

    def prepare(self,**changes):
        command=dict(request_id='intent',draft_id=self.draft['id'],draft_version=1,provider='email',environment='live',account='sender@example.test',
            fields={'from':'sender@example.test','to':'recipient@example.test','subject':'合成主旨'})
        command.update(changes)
        return self.store.prepare_submission(command)

    def approve(self,intent=None):
        intent=intent or self.prepare()
        return self.store.submissions.approve(intent['id'],dict(revision=intent['revision'],snapshot_hash=intent['snapshot_hash']))

    def send(self,snapshot):
        self.calls.append(snapshot)
        return dict(status='accepted',receipt=dict(kind='smtp_accepted',message_id=snapshot['message_id']))

    def dispatch(self,key,sender=None,**changes):
        options=dict(provider='email',environment='live',account='sender@example.test',send=sender or self.send)
        options.update(changes)
        return execute(self.store,key,**options)

    def test_unapproved_changed_hash_or_account_never_calls_provider(self):
        intent=self.prepare()
        with self.assertRaises(Conflict):self.dispatch(intent['id'])
        with self.assertRaises(Conflict):self.store.submissions.approve(intent['id'],dict(revision=1,snapshot_hash='0'*64))
        self.approve(intent)
        for change in (dict(account='other@example.test'),dict(environment='sandbox'),dict(provider='freelancer')):
            with self.subTest(change=change),self.assertRaises(Conflict):self.dispatch(intent['id'],**change)
        self.assertEqual(self.calls,[])

    def test_replay_snapshot_immutable_and_selected_body(self):
        intent=self.prepare()
        self.assertEqual(self.prepare()['id'],intent['id'])
        with self.assertRaises(Conflict):self.prepare(fields={'from':'sender@example.test','to':'other@example.test','subject':'改'})
        self.assertEqual(intent['snapshot']['body'],'本人確認的合成內容')
        with self.assertRaises(sqlite3.IntegrityError),self.store.database.connect() as conn:
            conn.execute('UPDATE submission_intents SET snapshot=? WHERE id=?',('{}',intent['id']))

    def test_duplicate_consumers_only_one_attempt_and_later_draft_does_not_change_selected_version(self):
        intent=self.approve()
        self.store.proposals.append(self.draft['id'],dict(revision=1,request_id='edit',body='第二稿'))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.dispatch(intent['id']),range(2)))
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0]['body'],'本人確認的合成內容')
        self.assertTrue(all(r['status'] in ('attempted','accepted') for r in results))
        self.dispatch(intent['id'])
        self.assertEqual(len(self.calls),1)

    def test_timeout_unknown_no_retry_and_no_private_exception(self):
        intent=self.approve()
        def fail(snapshot):self.calls.append(snapshot);raise TimeoutError('secret-token-and-mail-body')
        result=self.dispatch(intent['id'],fail)
        self.assertEqual(result['status'],'unknown')
        self.dispatch(intent['id'])
        self.assertEqual(len(self.calls),1)
        self.assertNotIn('secret-token',str(result))

    def test_post_effect_database_failure_leaves_attempt_and_never_retries(self):
        intent=self.approve()
        with self.store.database.connect() as conn:
            conn.execute("CREATE TRIGGER fail_result BEFORE UPDATE ON submission_intents WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.dispatch(intent['id'])
        self.assertEqual(self.store.submissions.get(intent['id'])['status'],'attempted')
        self.dispatch(intent['id'])
        self.assertEqual(len(self.calls),1)

    def test_invalid_receipt_unknown_explicit_rejection_and_cancellation(self):
        intent=self.approve()
        self.assertEqual(self.dispatch(intent['id'],lambda snapshot:{'status':'accepted','receipt':None})['status'],'unknown')
        other=self.prepare(request_id='reject');self.approve(other)
        self.assertEqual(self.dispatch(other['id'],lambda snapshot:{'status':'rejected','receipt':{'kind':'smtp_refused'}})['status'],'rejected')
        pending=self.prepare(request_id='cancel')
        self.store.submissions.cancel(pending['id'],1)
        self.assertEqual(self.dispatch(pending['id'])['status'],'cancelled')
        with self.assertRaises(Conflict):self.store.submissions.cancel(intent['id'],3)

    def test_archived_draft_and_missing_placeholders_block_prepare_or_attempt(self):
        intent=self.approve()
        self.store.proposals.archive(self.draft['id'],1)
        with self.assertRaises(Conflict):self.dispatch(intent['id'])
        with self.assertRaises(Conflict):self.prepare(request_id='new')
        self.assertEqual(self.calls,[])

    def test_user_reported_reconciliation_retains_unknown_and_never_resends(self):
        intent=self.approve()
        result=self.dispatch(intent['id'],lambda snapshot:(_ for _ in ()).throw(TimeoutError()))
        resolved=self.store.submissions.reconcile(intent['id'],dict(revision=result['revision'],outcome='user_reported',note='本人在寄件匣看到',reference='message-copy'))
        self.assertEqual(resolved['status'],'unknown')
        self.assertEqual(resolved['reconciliation']['outcome'],'user_reported')
        self.dispatch(intent['id'])
        self.assertEqual(self.calls,[])
        with self.assertRaises(Conflict):self.store.submissions.reconcile(intent['id'],dict(revision=result['revision'],outcome='user_reported',note='過期核對',reference='another'))
        with self.assertRaises(InvalidAction):self.store.submissions.reconcile(intent['id'],dict(revision=resolved['revision'],outcome='provider_verified_accepted',note='',reference='fake-bid'))

    def test_rollback_cancels_only_unattempted_approvals(self):
        first=self.approve();other=self.prepare(request_id='other');self.approve(other)
        self.dispatch(first['id'],lambda snapshot:(_ for _ in ()).throw(TimeoutError()))
        self.store.submissions.cancel_pending_for_rollback()
        self.assertEqual(self.store.submissions.get(other['id'])['status'],'cancelled')
        self.assertEqual(self.store.submissions.get(first['id'])['status'],'unknown')
        self.dispatch(other['id']);self.assertEqual(self.calls,[])

    def test_accepted_application_creation_is_atomic_and_never_resends(self):
        intent=self.approve();result=self.dispatch(intent['id'])
        command=dict(request_id='application',title='合成投案',contact='',url=None,applied_on='2026-10-01',stage='applied',follow_up_on=None,note='',versions={},submission_id=intent['id'])
        with self.store.database.connect() as conn:
            conn.execute("CREATE TRIGGER fail_application BEFORE INSERT ON manual_application_events BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.store.create_application(command)
        self.assertEqual(self.store.submissions.get(intent['id'])['status'],'accepted')
        with self.store.database.connect() as conn:conn.execute('DROP TRIGGER fail_application')
        application=self.store.create_application(command)
        self.assertEqual(application['proposal']['submission_id'],intent['id'])
        self.assertEqual(application['proposal']['draft_id'],self.draft['id'])
        self.assertEqual(self.store.create_application(command)['id'],application['id'])
        with self.assertRaises(Conflict):self.store.create_application(dict(command,request_id='other'))
        self.dispatch(intent['id']);self.assertEqual(len(self.calls),1)

    def test_unknown_without_reconciliation_cannot_claim_success_application_link(self):
        intent=self.approve();self.dispatch(intent['id'],lambda snapshot:None)
        command=dict(request_id='application',title='合成投案',contact='',url=None,applied_on='2026-10-01',stage='applied',follow_up_on=None,note='',versions={},submission_id=intent['id'])
        with self.assertRaises(Conflict):self.store.create_application(command)
        row=self.store.submissions.get(intent['id'])
        self.store.submissions.reconcile(intent['id'],dict(revision=row['revision'],outcome='user_reported',note='本人查證',reference='合成證據'))
        self.assertEqual(self.store.create_application(command)['proposal']['evidence']['kind'],'user_reported')

    def test_verified_bid_reconciliation_preserves_transport_and_stale_guard(self):
        intent=self.prepare(provider='freelancer',environment='sandbox',account='2',fields=dict(project_id=1,bidder_id=2,currency_id=3,currency_code='USD',amount=100,period=5,milestone_percentage=100,fees='合成sandbox 無真實費用',eligibility_confirmed=True))
        self.approve(intent)
        result=self.dispatch(intent['id'],lambda envelope:None,provider='freelancer',environment='sandbox',account='2')
        receipt=dict(kind='freelancer_bid',bid_id=9,project_id=1,bidder_id=2)
        verified=self.store.submissions.reconcile_verified(intent['id'],result['revision'],receipt)
        self.assertEqual((verified['status'],verified['reconciliation']['outcome']),('unknown','provider_verified_accepted'))
        with self.assertRaises(Conflict):self.store.submissions.reconcile_verified(intent['id'],result['revision'],receipt)
        self.dispatch(intent['id'],provider='freelancer',environment='sandbox',account='2');self.assertEqual(self.calls,[])

    def test_changed_source_after_approval_blocks_attempt_before_provider(self):
        self.store.ingest(job());group,=group_items(self.store.list())
        draft=self.store.create_proposal(dict(request_id='source-draft',title='合成來源稿',body='本人稿',template_id=None,template_revision=None,values={},versions={m['id']:m['token'] for m in group['members']},party=None))
        self.draft=draft;intent=self.approve()
        self.store.ingest(job(source='freelancer',external_id='copy',url=group['job']['url']))
        with self.assertRaises(Conflict):self.dispatch(intent['id'])
        self.assertEqual(self.calls,[])
        self.assertEqual(self.store.submissions.get(intent['id'])['status'],'approved')

    def test_wrong_receipt_channel_cannot_mark_rejected(self):
        intent=self.approve()
        result=self.dispatch(intent['id'],lambda snapshot:dict(status='rejected',receipt={'kind':'freelancer_refused'}))
        self.assertEqual(result['status'],'unknown')
