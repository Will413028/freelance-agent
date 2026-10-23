from dataclasses import replace
import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock

from freelance.modules.collection.glassdoor_mail import SENDER, canonical, inspect_glassdoor
from freelance.modules.collection.mail import MailMessage, MailParseError

URL = 'https://www.glassdoor.com/partner/jobListing.htm?jobListingId=1010273135749'
CARD = '<a href="' + URL + '&tracking=private"><table><tr><td><span><span>Example Co</span></span></td></tr><tr><td><p>AI Agent Engineer</p></td><td><p>2d</p></td></tr></table></a>'


class GlassdoorInspectionTests(unittest.TestCase):
    def setUp(self):
        self.mail = MailMessage('synthetic', SENDER,
            'All the top jobs for Software Engineer in Taiwan. Ready to apply?',
            CARD, True, '2026-09-26T13:12:00+00:00')

    def test_real_shape_keeps_identity_without_claiming_eligibility(self):
        result = inspect_glassdoor(self.mail)
        self.assertFalse(result['ingestible'])
        self.assertFalse(result['complete_scan'])
        card = result['cards'][0]
        self.assertEqual(card['source_url'], URL)
        self.assertEqual(card['company'], 'Example Co')
        self.assertEqual(card['title'], 'AI Agent Engineer')
        self.assertEqual(card['relative_date'], '2d')
        self.assertIsNone(card['taiwan_eligible'])
        self.assertIsNone(card['kind'])
        self.assertFalse(card['body_available'])
        self.assertNotIn('private', str(result))
        self.assertNotIn('published_at', card)

    def test_easy_apply_is_not_a_contract_signal(self):
        result = inspect_glassdoor(replace(self.mail, body=CARD.replace('<p>2d', '<p>Easy Apply</p><p>2d')))
        self.assertTrue(result['cards'][0]['easy_apply'])
        self.assertIsNone(result['cards'][0]['kind'])

    def test_observed_hour_and_just_posted_are_not_dates(self):
        from freelance.modules.collection.glassdoor_mail import parse_glassdoor
        for age in ('7h', 'Just posted'):
            with self.subTest(age=age):
                self.assertEqual(inspect_glassdoor(replace(self.mail, body=CARD.replace('2d', age)))['cards'][0]['relative_date'], age)
                self.assertIsNone(parse_glassdoor(replace(self.mail, body=CARD.replace('2d', age)))[0]['published_at'])

    def test_link_boundaries(self):
        for url in (URL.replace('https:', 'http:'), URL.replace('.com/', '.com.evil/'),
                    URL + '&jobListingId=1010273135827', URL + '#tracking',
                    URL.replace('1010273135749', 'not-an-id'),
                    URL.replace('www.glassdoor.com', 'user@www.glassdoor.com')):
            with self.subTest(url=url), self.assertRaises(MailParseError):
                canonical(url)

    def test_duplicate_truncated_and_changed_templates_fail_closed(self):
        for body in (CARD * 2, CARD[:-4], 'No jobs', CARD.replace('<p>AI Agent Engineer</p>', ''),
                     CARD.replace('2d', 'yesterday'), CARD.replace('</span></span>', '</span>'),
                     CARD.replace('Example Co', '<script>bad</script>'),
                     CARD.replace('<p>2d', '<p>Unexpected field</p><p>2d')):
            with self.subTest(body=body[:30]), self.assertRaises(MailParseError):
                inspect_glassdoor(replace(self.mail, body=body))

    def test_non_job_notifications_and_invalid_metadata_rejected(self):
        for changes in (dict(sender='other@example.com'), dict(subject='Welcome to Glassdoor'),
                        dict(is_html=False), dict(received_at='2026-09-26'),
                        dict(body='x' * 1_000_001)):
            with self.subTest(changes=list(changes)), self.assertRaises(MailParseError):
                inspect_glassdoor(replace(self.mail, **changes))

    def test_unrelated_footer_is_not_a_job(self):
        result = inspect_glassdoor(replace(self.mail, body=CARD + '<a href="https://example.com/private">Unsubscribe</a>'))
        self.assertEqual(result['count'], 1)
        self.assertNotIn('Unsubscribe', str(result))

    def test_observed_new_subject_and_summary_only_intake(self):
        from freelance.modules.collection.glassdoor_mail import parse_glassdoor
        mail = replace(self.mail, subject='Software Engineer at Example and 6 more jobs in Taiwan for you. Apply Now.')
        jobs = parse_glassdoor(mail)
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(job['external_id'], '1010273135749')
        self.assertEqual(job['canonical_url'], URL)
        self.assertEqual(job['title'], 'AI Agent Engineer')
        self.assertFalse(job['complete'])
        self.assertFalse(job['body_available'])
        for field in ('location', 'published_at', 'weekly_hours', 'taiwan_eligible', 'kind'):
            self.assertIsNone(job[field])
        self.assertNotIn('private', str(job))
        self.assertEqual(parse_glassdoor(replace(mail, message_id='other', received_at='2026-09-30T00:00:00+00:00'))[0]['receipt_id'], job['receipt_id'])

    def test_opt_in_sync_replay_quarantine_and_recipient_boundary(self):
        from freelance.bootstrap.store import SQLiteStore
        from freelance.modules.collection.resend_sync import sync_glassdoor
        from freelance.modules.collection.resend_preview import preview
        from freelance.modules.collection.source_catalog import enabled_sources
        self.assertEqual(enabled_sources(sources=('glassdoor',)), ('glassdoor',))
        self.assertNotIn('glassdoor', enabled_sources(free_boards=True, talent=True))
        target = 'test@example.resend.app'
        row = dict(id='11111111-1111-4111-8111-111111111111',
                   **{'from': SENDER}, subject=self.mail.subject, html=CARD,
                   created_at=self.mail.received_at, to=[target])
        client = Mock()
        client.list_received.return_value = dict(data=[row], has_more=False)
        client.get_received.return_value = row
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteStore(Path(directory) / 'db')
            store.migrate()
            first = sync_glassdoor(client, store, target)
            self.assertEqual(first['status'], 'ok')
            self.assertEqual(len(store.existing_source_ids('glassdoor')), 1)
            client.reset_mock()
            self.assertEqual(sync_glassdoor(client, store, target)['status'], 'ok')
            client.get_received.assert_not_called()
            bad = row | dict(id='22222222-2222-4222-8222-222222222222', html=CARD[:-4])
            client.list_received.return_value = dict(data=[bad, row], has_more=False)
            client.get_received.return_value = bad
            self.assertEqual(sync_glassdoor(client, store, target)['status'], 'failed')
            self.assertEqual(len(store.existing_source_ids('glassdoor')), 1)
            self.assertEqual(store.mail_records('glassdoor', target)[bad['id']]['status'], 'rejected')
        client.list_received.return_value = dict(data=[row], has_more=False)
        client.get_received.return_value = row | dict(to=['other@example.resend.app'])
        self.assertEqual(preview(client, target, source='glassdoor')['items'], [])
        client.reset_mock()
        client.list_received.return_value = dict(data=[row | dict(subject='Verify account')], has_more=False)
        preview(client, target, source='glassdoor')
        client.get_received.assert_not_called()
