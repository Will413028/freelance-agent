from dataclasses import replace
import json
import sqlite3
import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock

from freelance.modules.collection.mail import MailMessage, MailParseError
from freelance.modules.collection.talent_mail import canonical, parse_talent, SENDER
from freelance.modules.collection.resend_preview import matches, preview
from freelance.modules.collection.resend_sync import sync_talent
from freelance.bootstrap.store import SQLiteStore

CARD = '''<a href="https://tw.talent.com/redirect?id=abcdef123456">
<!-- Title --><a class="job__link" href="https://tw.talent.com/redirect?id=abcdef123456&amp;user_id=private">Backend API Engineer</a>
<!-- Location --><td>Taiwan</td><!-- Company --><td>Example</td>
<!-- Salary --><td></td><!-- Description --><td>Contractor building APIs...</td></a>'''

ENGLISH_CARD = '''<!-- Job cards -->
<tr><td><a href="https://tw.talent.com/redirect?id=feedface1234&amp;user_id=private">
  <table>
    <tr><td><a href="https://tw.talent.com/redirect?id=feedface1234&amp;click_type=title">Backend API Engineer</a></td></tr>
    <tr><td>Taipei, TW</td></tr>
    <tr><td>Example Company</td></tr>
    <tr><td></td></tr>
  </table>
</a></td></tr>
<!-- View more jobs button -->'''


class TalentMailTests(unittest.TestCase):
    def test_sync_replay_preserves_manual_draft_and_failure_is_atomic(self):
        row = {'id': '11111111-1111-4111-8111-111111111111', 'from': SENDER,
               'subject': '更多职位，例如Engineer', 'html': CARD, 'created_at': '2026-09-26T10:17:15Z',
               'to': ['test@example.resend.app']}
        client = Mock()
        client.list_received.return_value = {'data': [row], 'has_more': False}
        client.get_received.return_value = row
        with tempfile.TemporaryDirectory() as folder:
            store = SQLiteStore(Path(folder)/'db'); store.migrate()
            self.assertEqual(sync_talent(client, store, row['to'][0])['jobs'], 1)
            item = store.list()[0]
            store.review(item['id'], 'edit', item['version'], 'My manual draft')
            client.get_received.return_value = row | {'created_at': '2026-09-27T00:00:00Z'}
            self.assertEqual(sync_talent(client, store, row['to'][0])['status'], 'ok')
            self.assertEqual(len(store.list()), 1)
            self.assertEqual(store.list()[0]['proposal'], 'My manual draft')
            # New malformed mail is quarantined; an already processed ID is not reread.
            bad = client.get_received.return_value | {'id': '22222222-2222-4222-8222-222222222222', 'html': '<p>unsupported</p>'}
            client.list_received.return_value = {'data': [bad], 'has_more': False}
            client.get_received.return_value = bad
            self.assertEqual(sync_talent(client, store, row['to'][0])['status'], 'failed')
            self.assertEqual(store.sources()['talent'], 'failed')
            self.assertEqual(store.list()[0]['proposal'], 'My manual draft')
    def setUp(self):
        self.mail = MailMessage('test', SENDER, '更多职位，例如Software Engineer', CARD,
                                True, '2026-09-26T10:17:15+00:00')

    def test_summary_and_private_tracking_removed(self):
        job, = parse_talent(self.mail)
        self.assertEqual(job['canonical_url'], 'https://tw.talent.com/view?id=abcdef123456')
        self.assertEqual(job['kind'], 'contract')
        self.assertFalse(job['body_available'])
        self.assertIsNone(job['taiwan_eligible'])
        self.assertIsNone(job['budget_min'])
        self.assertNotIn('private', str(job))

    def test_replay_preserves_identity_and_receipt(self):
        first, = parse_talent(self.mail)
        other, = parse_talent(replace(self.mail, message_id='later',
            received_at='2026-09-27T00:00:00Z', body=CARD.replace('private', 'new-tracker')))
        self.assertEqual(first['receipt_id'], other['receipt_id'])
        self.assertEqual(first['external_id'], other['external_id'])

    def test_english_card_only_notification_preserves_unknown_details(self):
        mail = replace(self.mail, subject="Software Engineer jobs you don't want to miss",
                       body=ENGLISH_CARD)
        job, = parse_talent(mail)
        self.assertEqual(job['external_id'], 'feedface1234')
        self.assertEqual(job['canonical_url'], 'https://tw.talent.com/view?id=feedface1234')
        self.assertEqual((job['title'], job['company'], job['location']),
                         ('Backend API Engineer', 'Example Company', 'Taipei, TW'))
        self.assertIn('notification card only', job['description'])
        self.assertFalse(job['complete'])
        self.assertFalse(job['body_available'])
        self.assertIsNone(job['kind'])
        self.assertIsNone(job['taiwan_eligible'])
        self.assertIsNone(job['weekly_hours'])
        self.assertNotIn('private', str(job))
        other, = parse_talent(replace(mail, body=ENGLISH_CARD.replace('private', 'new-tracker')))
        self.assertEqual(job['receipt_id'], other['receipt_id'])

    def test_english_card_without_company_syncs_once(self):
        row = {'id': '33333333-3333-4333-8333-333333333333', 'from': SENDER,
               'subject': "Software Engineer jobs you don't want to miss",
               'html': ENGLISH_CARD.replace('Example Company', ''),
               'created_at': '2026-09-28T08:00:53Z', 'to': ['test@example.resend.app']}
        client = Mock()
        client.list_received.return_value = {'data': [row], 'has_more': False}
        client.get_received.return_value = row
        with tempfile.TemporaryDirectory() as folder:
            store = SQLiteStore(Path(folder)/'db'); store.migrate()
            self.assertEqual(sync_talent(client, store, row['to'][0])['jobs'], 1)
            with sqlite3.connect(Path(folder)/'db') as conn:
                saved, = conn.execute('SELECT item FROM opportunities').fetchone()
            self.assertIsNone(json.loads(saved)['job']['company'])
            self.assertEqual(sync_talent(client, store, row['to'][0])['jobs'], 0)

    def test_english_subject_is_scoped_at_metadata_and_body(self):
        valid = ("Software Engineer jobs you don't want to miss",
                 "Software Engineer - Open Source Contributions - Remote jobs you don't want to miss",
                 "software engineer jobs you don't want to miss")
        for subject in valid:
            with self.subTest(subject=subject):
                self.assertTrue(matches({'from': SENDER, 'subject': subject}, 'talent'))
                self.assertEqual(len(parse_talent(replace(self.mail, subject=subject,
                                                       body=ENGLISH_CARD))), 1)
        for subject in ('Verify your account', "Marketing jobs you don't want to miss",
                        "Software Engineer jobs you don't want to miss\nPrivate"):
            with self.subTest(subject=subject):
                self.assertFalse(matches({'from': SENDER, 'subject': subject}, 'talent'))
                with self.assertRaises(MailParseError):
                    parse_talent(replace(self.mail, subject=subject, body=ENGLISH_CARD))

    def test_english_card_boundaries_and_identity_must_be_complete(self):
        mail = replace(self.mail, subject="Software Engineer jobs you don't want to miss")
        missing_company, = parse_talent(replace(mail, body=ENGLISH_CARD.replace('Example Company', '')))
        self.assertIsNone(missing_company['company'])
        for body in (ENGLISH_CARD.replace('<!-- Job cards -->', ''),
                     ENGLISH_CARD.replace('<!-- View more jobs button -->', ''),
                     ENGLISH_CARD.replace('Backend API Engineer', ''),
                     ENGLISH_CARD.replace('click_type=title', 'id=bad'),
                     ENGLISH_CARD.replace('feedface1234&amp;click_type=title', 'abcdef123456'),
                     ENGLISH_CARD + ENGLISH_CARD):
            with self.subTest(body=body[:60]):
                with self.assertRaises(MailParseError):
                    parse_talent(replace(mail, body=body))

    def test_wrong_sender_subject_and_truncated_card_rejected(self):
        for mail in (replace(self.mail, sender='other@talent.com'),
                     replace(self.mail, subject='驗證信'), replace(self.mail, is_html=False),
                     replace(self.mail, body=CARD[:-4]), replace(self.mail, body=CARD*2),
                     replace(self.mail, body=CARD.replace('<!-- Company -->', '')),
                     replace(self.mail, received_at='2026-09-26')):
            with self.assertRaises(MailParseError): parse_talent(mail)

    def test_url_validation(self):
        for url in ('https://evil.test/redirect?id=abcdef123456',
                    'https://tw.talent.com/redirect?id=abcdef123456&id=123456abcdef',
                    'https://tw.talent.com/unsubscribe?id=abcdef123456',
                    'https://tw.talent.com/redirect?id=1',
                    'http://tw.talent.com/redirect?id=abcdef123456'):
            with self.assertRaises(MailParseError): canonical(url)

    def test_preview_opt_in_and_subject_scope(self):
        row = {'id': '11111111-1111-4111-8111-111111111111', 'from': SENDER,
               'subject': self.mail.subject, 'html': CARD, 'created_at': self.mail.received_at,
               'to': ['test@example.resend.app']}
        client = Mock()
        client.list_received.return_value = {'data': [row], 'has_more': False}
        client.get_received.return_value = row
        self.assertEqual(preview(client, 'test@example.resend.app')['body_reads'], 0)
        result = preview(client, 'test@example.resend.app', source='talent')
        self.assertEqual(result['errors'], [])
        self.assertEqual(len(result['items']), 1)
        client.list_received.return_value['data'] = [row | {'subject': 'Verify account'}]
        client.reset_mock()
        self.assertEqual(preview(client, 'test@example.resend.app', source='talent')['body_reads'], 0)
        client.get_received.assert_not_called()

    def test_preview_rechecks_recipient_and_body_subject(self):
        row = {'id': '11111111-1111-4111-8111-111111111111', 'from': SENDER,
               'subject': self.mail.subject, 'html': CARD, 'created_at': self.mail.received_at,
               'to': ['test@example.resend.app']}
        client = Mock()
        client.list_received.return_value = {'data': [row], 'has_more': False}
        for change in ({'to': ['other@example.test']}, {'subject': 'Private account notice'},
                       {'from': 'imposter@talent.com'}, {'html': None, 'text': 'private'}):
            client.get_received.return_value = row | change
            result = preview(client, 'test@example.resend.app', source='talent')
            self.assertEqual(result['items'], [])
            self.assertEqual(len(result['errors']), 1)
