"""Configuration is opt-in; unverified settings cannot queue external effects."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch,Mock
from datetime import datetime,timezone
from freelance.bootstrap.store import SQLiteStore
from freelance.bootstrap.submission_runtime import SubmissionRuntime
from freelance.platform.errors import Conflict


class SubmissionRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.store=SQLiteStore(self.root/'app.sqlite',clock=lambda:datetime(2026,10,1,tzinfo=timezone.utc));self.store.migrate()
        draft=self.store.create_proposal(dict(request_id='draft',title='合成',body='合成內容',template_id=None,template_revision=None,values={},versions={},party=None))
        self.intent=self.store.prepare_submission(dict(request_id='intent',draft_id=draft['id'],draft_version=1,provider='email',environment='live',account='sender@gmail.com',fields={'from':'sender@gmail.com','to':'recipient@example.test','subject':'合成'}))
        self.intent=self.store.submissions.approve(self.intent['id'],dict(revision=1,snapshot_hash=self.intent['snapshot_hash']))

    def config(self,verified=False):
        setting=dict(enabled=True,account='sender@gmail.com',environment='live',credential_path=str(self.root/'credential.json'))
        if verified:setting['verification']=dict(status='live_ready',account='sender@gmail.com',environment='live',evidence='synthetic test attestation',checked_at='2026-10-01T00:00:00+00:00')
        path=self.root/'config.json';path.write_text(json.dumps({'email':setting}));os.chmod(path,0o600);return path

    def test_default_runtime_never_reads_configuration_or_credentials(self):
        with patch('freelance.bootstrap.submission_runtime.read_private_json',side_effect=AssertionError('must not read')):
            runtime=SubmissionRuntime(self.store)
            self.assertFalse(runtime.capabilities()['email']['can_dispatch'])
            self.assertEqual(runtime.dispatch(self.intent['id'])['status'],'not_configured')
            with self.assertRaises(Conflict):runtime.enqueue(self.intent['id'],self.intent['revision'])

    def test_unverified_config_never_queues_and_wrong_mode_private_file_rejected(self):
        path=self.config();queue=Mock();runtime=SubmissionRuntime(self.store,path,enqueue=queue)
        self.assertEqual(runtime.capabilities()['email']['status'],'configured_unverified')
        with self.assertRaises(Conflict):runtime.enqueue(self.intent['id'],self.intent['revision'])
        queue.assert_not_called()
        os.chmod(path,0o644)
        with self.assertRaises(ValueError):SubmissionRuntime(self.store,path)

    def test_queue_only_no_connection_and_duplicate_dispatch_protected(self):
        queue=Mock();runtime=SubmissionRuntime(self.store,self.config(True),enqueue=queue)
        with patch('freelance.bootstrap.submission_runtime.open_client',side_effect=AssertionError('API must not connect')):
            result=runtime.enqueue(self.intent['id'],self.intent['revision'])
            self.assertTrue(result['queued']);queue.assert_called_once_with({'schema_version':1,'intent_id':self.intent['id']})
        client=Mock();client.sendmail.return_value={}
        with patch('freelance.bootstrap.submission_runtime.open_client',return_value=client) as connect:
            self.assertEqual(runtime.dispatch(self.intent['id'])['status'],'accepted')
            runtime.dispatch(self.intent['id']);connect.assert_called_once()
        self.assertNotIn('credential',str(runtime.capabilities()))

    def test_account_attestation_change_invalidates_dispatch(self):
        runtime=SubmissionRuntime(self.store,self.config(True),enqueue=Mock())
        runtime.config['email']['account']='other@gmail.com'
        self.assertFalse(runtime.capabilities()['email']['can_dispatch'])
        with self.assertRaises(Conflict):runtime.enqueue(self.intent['id'],self.intent['revision'])
