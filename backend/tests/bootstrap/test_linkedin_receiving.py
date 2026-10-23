import json
from pathlib import Path
import tempfile
from unittest import TestCase
from unittest.mock import Mock

import freelance.legacy.ai_drafts as ai_drafts; import freelance.modules.collection.resend_preview as rp
from freelance.modules.collection.resend_sync import sync_linkedin
from freelance.bootstrap.store import SQLiteStore
from fixtures.linkedin_mail import mail as notification
from fixtures.resend_preview import MID, TARGET, mail


def received(**changes):
    return mail(**{'from': 'jobalerts-noreply@linkedin.com', 'text': notification().body,
                   'html': '<html>Not used or persisted</html>', 'subject': 'Example is hiring'}) | changes


class LinkedInReceivingTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store = SQLiteStore(Path(self.tmp.name) / 'db'); self.store.migrate()
        self.client = Mock()
        self.client.list_received.return_value = {'data': [received()], 'has_more': False}
        self.client.get_received.return_value = received()

    def test_default_tasker_does_not_read_linkedin_and_confirmation_is_ignored(self):
        self.assertEqual(rp.preview(self.client, TARGET)['body_reads'], 0)
        self.client.list_received.return_value['data'] = [received(subject='Your job alert has been created')]
        self.assertEqual(rp.preview(self.client, TARGET, source='linkedin')['body_reads'], 0)
        self.client.get_received.assert_not_called()

    def test_transport_requires_explicit_source_opt_in(self):
        response = Mock(); response.status = 200
        response.read.return_value = json.dumps({'data': [received()], 'has_more': False}).encode()
        response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        opener = Mock(); opener.open.return_value = response
        client = rp.ReceivingClient('re_synthetic', opener=opener, pause=lambda _: None)
        client.list_received()
        with self.assertRaises(rp.ResendError): client.get_received(MID)
        opted = rp.ReceivingClient('re_synthetic', opener=opener, pause=lambda _: None, sources=('linkedin',))
        opted.list_received(); opted.get_received(MID)

    def test_real_store_replay_preserves_manual_draft_and_blocks_ai_for_card(self):
        self.assertEqual(sync_linkedin(self.client, self.store, TARGET)['jobs'], 1)
        item = self.store.list()[0]
        self.store.track(item['id'], 0, feedback='interested')
        result = ai_drafts.run(self.store, 'owner@example.test', lambda _: self.fail('Card sent to AI'))
        self.assertEqual(result['attempted'], 0)
        self.store.review(item['id'], 'edit', item['version'], 'My manual notes')
        self.client.get_received.return_value = received(created_at='2026-09-27T00:00:00Z')
        self.assertEqual(sync_linkedin(self.client, self.store, TARGET)['status'], 'ok')
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(self.store.list()[0]['proposal'], 'My manual notes')
        self.assertNotIn('private', str(self.store.list()))

    def test_only_explicit_missing_body_blocks_interested_draft(self):
        sync_linkedin(self.client, self.store, TARGET)
        item = self.store.list()[0]
        self.store.track(item['id'], 0, feedback='interested')
        self.assertIsNone(ai_drafts._priority(self.store.list()[0]))
        enriched = self.store.list()[0]
        enriched['job']['body_available'] = True
        # Recreate the template for the richer evidence rather than a manual edit.
        from freelance.legacy.proposals import draft

        enriched['proposal'] = draft(enriched['job'], enriched['evaluation'])
        enriched['draft_method'] = '範本草稿（尚未連接 LLM）'
        self.assertEqual(ai_drafts._priority(enriched), 'interested')

    def test_unpaid_is_excluded_from_ingestion(self):
        self.client.get_received.return_value = received(text=notification().body.replace('Engineer (Remote)', 'Engineer (Remote, Equity only)'))
        self.assertEqual(sync_linkedin(self.client, self.store, TARGET)['jobs'], 0)
        self.assertEqual(self.store.list(), [])

    def test_wrong_envelope_missing_text_and_truncation_fail_closed(self):
        for changes in ({'received_for': ['other@example.test']}, {'text': None},
                        {'from': 'imposter@linkedin.com'}, {'text': 'PRIVATE unsupported body'}):
            with self.subTest(changes=list(changes)):
                self.client.get_received.return_value = received(**changes)
                result = sync_linkedin(self.client, self.store, TARGET)
                self.assertEqual(result['status'], 'failed')
                self.assertNotIn('PRIVATE', str(result))
                self.assertEqual(self.store.list(), [])
        self.client.get_received.return_value = received()
        self.client.list_received.return_value['has_more'] = True
        self.assertEqual(sync_linkedin(self.client, self.store, TARGET)['status'], 'failed')
        self.assertEqual(self.store.list(), [])
