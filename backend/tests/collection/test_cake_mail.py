import base64
from dataclasses import replace
from urllib.parse import urlencode
import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock
import zlib

from freelance.modules.collection.cake_mail import SENDER, canonical, parse_cake
from freelance.modules.collection.mail import MailMessage, MailParseError
from freelance.modules.collection.resend_preview import preview
from freelance.modules.collection.resend_sync import sync_cake
from freelance.bootstrap.store import SQLiteStore
import freelance.legacy.ai_drafts as ai_drafts

URL = 'https://www.cake.me/companies/example/jobs/backend-api'


def tracked(value):
    raw = urlencode({'d': 'example', 'l': value, 't': 'synthetic-private-token'})
    return 'https://email.no-reply.cake.me/c/' + base64.urlsafe_b64encode(zlib.compress(raw.encode())).decode().rstrip('=')


def message():
    body = '<p>Personal greeting</p><a href="' + tracked(URL + '?tracking=private') + '"><span>了解詳情</span></a>'
    return MailMessage('test', SENDER, '您追蹤的 Example 刊登了一筆新職缺 - 兼職 Backend API 工程師',
                       body, True, '2026-09-26T03:00:00+00:00')


class CakeMailTests(unittest.TestCase):
    def test_sqlite_replay_manual_draft_ai_gate_and_partial_failure(self):
        item = message()
        target = 'test@example.resend.app'
        received = {'id': '11111111-1111-4111-8111-111111111111', 'from': SENDER,
                    'to': [target], 'created_at': item.received_at,
                    'subject': item.subject, 'html': item.body}
        client = Mock()
        client.list_received.return_value = {'data': [received], 'has_more': False}
        client.get_received.return_value = received
        with tempfile.TemporaryDirectory() as folder:
            store = SQLiteStore(Path(folder) / 'db'); store.migrate()
            self.assertEqual(sync_cake(client, store, target)['jobs'], 1)
            saved = store.list()[0]
            store.track(saved['id'], 0, feedback='interested')
            self.assertIsNone(ai_drafts._priority(store.list()[0]))
            store.review(saved['id'], 'edit', saved['version'], 'My reviewed notes')
            client.get_received.return_value = received | {'created_at': '2026-09-27T00:00:00Z'}
            self.assertEqual(sync_cake(client, store, target)['status'], 'ok')
            self.assertEqual(len(store.list()), 1)
            self.assertEqual(store.list()[0]['proposal'], 'My reviewed notes')
            # New malformed mail is quarantined; an already processed ID is not reread.
            bad = client.get_received.return_value | {'id': '22222222-2222-4222-8222-222222222222', 'html': '<p>unsupported</p>'}
            client.list_received.return_value = {'data': [bad], 'has_more': False}
            client.get_received.return_value = bad
            self.assertEqual(sync_cake(client, store, target)['status'], 'failed')
            self.assertEqual(store.sources()['cake'], 'failed')
            self.assertEqual(store.list()[0]['proposal'], 'My reviewed notes')

    def test_decode_original_url_offline_and_keep_only_card_evidence(self):
        job, = parse_cake(message())
        self.assertEqual(job['url'], URL)
        self.assertEqual(job['kind'], 'contract')
        self.assertFalse(job['body_available'])
        self.assertIsNone(job['taiwan_eligible'])
        self.assertNotIn('private', str(job))
        self.assertNotIn('Personal greeting', str(job))
        self.assertEqual(canonical(URL + '#fragment'), URL)

    def test_resend_and_new_tracker_do_not_change_receipt(self):
        a = parse_cake(message())[0]
        b = parse_cake(replace(message(), message_id='another', received_at='2026-09-27T00:00:00+00:00',
                               body='<a href="' + URL + '">了解詳情</a>'))[0]
        self.assertEqual(a['receipt_id'], b['receipt_id'])

    def test_no_arbitrary_redirect_or_auth_links(self):
        for url in ('https://evil.test/companies/example/jobs/test', 'http://www.cake.me/companies/example/jobs/test',
                    'https://www.cake.me@evil.test/companies/example/jobs/test',
                    'https://www.cake.me/settings/account', URL + '/../../settings',
                    'https://www.cake.me/companies/example/jobs/%2fsettings'):
            with self.subTest(url=url), self.assertRaises(MailParseError):
                canonical(tracked(url))

    def test_decompression_limit_and_malformed_payload(self):
        bomb = base64.urlsafe_b64encode(zlib.compress(b'l=' + b'A' * 100000)).decode().rstrip('=')
        for url in ('https://email.no-reply.cake.me/c/' + bomb,
                    'https://email.no-reply.cake.me/c/invalid',
                    tracked(URL) + '?redirect=other'):
            with self.assertRaises(MailParseError): canonical(url)

    def test_sender_template_and_ambiguous_job_rejected(self):
        for mail in (replace(message(), sender='attacker@cake.me'), replace(message(), subject='New message'),
                     replace(message(), body='<a href="' + URL + '">取消訂閱</a>'),
                     replace(message(), body=message().body + '<a href="' + URL + '-other">了解詳情</a>')):
            with self.assertRaises(MailParseError): parse_cake(mail)

    def test_receiving_explicit_source_and_job_subject_only(self):
        item = message()
        target = 'test@example.resend.app'
        received = {'id': '11111111-1111-4111-8111-111111111111', 'from': SENDER,
                    'to': [target], 'created_at': item.received_at,
                    'subject': item.subject, 'html': item.body}
        client = Mock()
        client.list_received.return_value = {'data': [received], 'has_more': False}
        client.get_received.return_value = received
        self.assertEqual(preview(client, target)['body_reads'], 0)
        result = preview(client, target, source='cake')
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['items'][0]['job']['url'], URL)
        self.assertFalse(result['items'][0]['job']['body_available'])
        client.reset_mock()
        client.list_received.return_value = {'data': [received | {'subject': '您有一則新訊息'}], 'has_more': False}
        self.assertEqual(preview(client, target, source='cake')['body_reads'], 0)
        client.get_received.assert_not_called()

    def test_receiving_revalidates_envelope_sender_and_html(self):
        item = message()
        target = 'test@example.resend.app'
        received = {'id': '11111111-1111-4111-8111-111111111111', 'from': SENDER,
                    'to': [target], 'created_at': item.received_at,
                    'subject': item.subject, 'html': item.body}
        client = Mock()
        client.list_received.return_value = {'data': [received], 'has_more': False}
        for changes in ({'from': 'imposter@cake.me'}, {'to': ['other@example.test']},
                        {'html': None, 'text': 'Unsupported private message'}):
            client.get_received.return_value = received | changes
            result = preview(client, target, source='cake')
            self.assertEqual(result['items'], [])
            self.assertEqual(len(result['errors']), 1)
            self.assertNotIn('private', str(result))
