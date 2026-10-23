import freelance.bootstrap.gmail_send_cli as gmail_send_command
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import freelance.modules.notifications.gmail_send as gmail_send; import freelance.legacy.review as review
from freelance.bootstrap.store import SQLiteStore
from fixtures.domain import job

MAIL = 'self@example.com'
NOW = datetime(2026, 9, 17, 1, tzinfo=timezone.utc)

class SendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = SQLiteStore(str(Path(self.temp.name) / 'test.db'))
        self.store.migrate()
        self.intent = self.store.create_digest(NOW.date(), MAIL, NOW)
        self.raw = gmail_send.build_message(self.intent['snapshot'], self.intent['id'], MAIL)
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.session = Mock()
        self.session.get.return_value = Mock(status_code=200, content=b'{}')
        self.session.get.return_value.json.return_value = {'emailAddress': MAIL}
        self.session.post.return_value = Mock(status_code=200, content=b'{}')
        self.session.post.return_value.json.return_value = {'id': 'abc123'}
        self.factory = Mock(return_value=self.session)

    def send(self, sha=None):
        return gmail_send.send_intent(self.store, self.intent['id'], MAIL,
                                     sha or self.digest, self.factory)

    def test_deterministic_self_only_multipart(self):
        self.assertEqual(self.raw, gmail_send.build_message(self.intent['snapshot'], self.intent['id'], MAIL))
        msg = BytesParser(policy=policy.default).parsebytes(self.raw)
        self.assertEqual(msg['To'], MAIL)
        self.assertEqual(msg['From'], MAIL)
        self.assertIsNone(msg['Cc'])
        self.assertIsNone(msg['Bcc'])
        self.assertIn('來源狀態', msg.get_body(preferencelist=('html',)).get_content())
        self.assertNotIn('尚未寄出', msg.get_body(preferencelist=('html',)).get_content())
        self.assertIsNotNone(msg.get_body(preferencelist=('plain',)))

    def test_plain_and_html_include_every_matching_item(self):
        cases = review.ReviewStore(clock=lambda: NOW)
        for index in range(8):
            cases.ingest(job(external_id=str(index), title=f'AI agent project {index}'))
        snapshot = self.intent['snapshot'] | {'items': cases.list(), 'unseen_count': 8}
        message = BytesParser(policy=policy.default).parsebytes(
            gmail_send.build_message(snapshot, self.intent['id'], MAIL))
        for index in range(8):
            title = f'AI agent project {index}'
            self.assertIn(title, message.get_body(preferencelist=('plain',)).get_content())
            self.assertIn(title, message.get_body(preferencelist=('html',)).get_content())

    def test_bad_recipient_or_header_is_rejected(self):
        for mail in ('other@example.com', 'self@example.com\r\nBcc: evil@example.com', 'self@example.com,evil@example.com'):
            with self.subTest(mail=mail), self.assertRaises(ValueError):
                gmail_send.build_message(self.intent['snapshot'], self.intent['id'], mail)

    def test_preview_private_exclusive_and_no_network(self):
        path = Path(self.temp.name) / 'preview.eml'
        self.assertEqual(gmail_send.write_preview(self.raw, path), self.digest)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            gmail_send.write_preview(self.raw, path)
        self.factory.assert_not_called()

    def test_hash_mismatch_before_token_and_claim(self):
        with self.assertRaises(ValueError): self.send('0' * 64)
        self.factory.assert_not_called()
        self.assertEqual(self.store.get_digest(self.intent['id'])['status'], 'pending')

    def test_wrong_account_stays_pending(self):
        self.session.get.return_value.json.return_value = {'emailAddress': 'other@example.com'}
        with self.assertRaises(gmail_send.SendError): self.send()
        self.session.post.assert_not_called()
        self.session.close.assert_called_once()
        self.assertEqual(self.store.get_digest(self.intent['id'])['status'], 'pending')

    def test_claim_committed_before_post_and_no_retry(self):
        def post(url, **kwargs):
            self.assertEqual(self.store.get_digest(self.intent['id'])['status'], 'attempted')
            self.assertEqual(url, gmail_send.SEND_URL)
            self.assertEqual(kwargs['timeout'], 20)
            self.assertFalse(kwargs['allow_redirects'])
            self.assertEqual(base64.urlsafe_b64decode(kwargs['json']['raw']), self.raw)
            return Mock(status_code=200, content=b'{}', json=lambda: {'id': 'abc123'})
        self.session.post.side_effect = post
        self.assertEqual(self.send()['status'], 'sent')
        self.assertEqual(self.send()['status'], 'sent')
        self.session.post.assert_called_once()
        self.factory.assert_called_once()

    def test_uncertainty_never_retries(self):
        for result in ('timeout', 'redirect', 'noid', 'oversize'):
            with self.subTest(result=result):
                intent = self.store.create_digest('2026-09-' + str(18 + ['timeout','redirect','noid','oversize'].index(result)), MAIL, NOW)
                raw = gmail_send.build_message(intent['snapshot'], intent['id'], MAIL)
                session = Mock()
                session.get.return_value = self.session.get.return_value
                if result == 'timeout': session.post.side_effect = TimeoutError('private data')
                else:
                    session.post.return_value = Mock(status_code=302 if result == 'redirect' else 200, content=b'x' * (70000 if result == 'oversize' else 2))
                    session.post.return_value.json.return_value = {} if result == 'noid' else {'id':'abc'}
                factory = Mock(return_value=session)
                for _ in range(2):
                    outcome = gmail_send.send_intent(self.store, intent['id'], MAIL, hashlib.sha256(raw).hexdigest(), factory)
                    self.assertEqual(outcome['status'], 'unknown')
                session.post.assert_called_once()
                factory.assert_called_once()

    def test_concurrent_senders_only_one_post(self):
        with ThreadPoolExecutor(2) as pool:
            list(pool.map(lambda _: self.send(), range(2)))
        self.session.post.assert_called_once()
        self.assertEqual(self.store.get_digest(self.intent['id'])['status'], 'sent')

    def test_cli_requires_live_send_before_token(self):
        with self.assertRaises(SystemExit):
            gmail_send_command.main(['--database', 'missing', '--intent-id', 'id', '--expected-email', MAIL,
                             '--send', '--token', 'missing', '--expected-sha256', '0'*64])
