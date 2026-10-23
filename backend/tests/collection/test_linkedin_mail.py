from fixtures.linkedin_mail import mail
import unittest
from dataclasses import replace

from freelance.modules.collection.linkedin_mail import parse_linkedin, canonical, SENDER
from freelance.modules.collection.mail import MailMessage, MailParseError
from freelance.modules.discovery.domain import qualify




class LinkedInMailTests(unittest.TestCase):
    def test_manage_alerts_link_is_not_a_job_field_or_receipt_input(self):
        original = mail()
        marker = 'New jobs match your preferences.\n'
        for query in ('trackingId=private', 'trackingId=changed'):
            managed = replace(original, body=original.body.replace(marker, marker +
                'Manage alerts: https://www.linkedin.com/comm/jobs/alerts?' + query + '\n'))
            self.assertEqual(parse_linkedin(managed), parse_linkedin(original))

    def test_manage_alerts_link_rejects_spoofing_and_wrong_position(self):
        original = mail()
        marker = 'New jobs match your preferences.\n'
        for url in ('https://www.linkedin.com.evil.test/comm/jobs/alerts',
                    'https://www.linkedin.com/comm/jobs/view/1234/',
                    'http://www.linkedin.com/comm/jobs/alerts'):
            with self.subTest(url=url), self.assertRaises(MailParseError):
                parse_linkedin(replace(original, body=original.body.replace(
                    marker, marker + 'Manage alerts: ' + url + '\n')))
        with self.assertRaises(MailParseError):
            parse_linkedin(replace(original, body=original.body.replace(
                'Example Co\n', 'Example Co\nManage alerts: https://www.linkedin.com/comm/jobs/alerts\n')))

    def test_observed_singular_alert_preserves_same_job_and_receipt(self):
        plural = mail()
        singular = replace(plural, body=plural.body.replace(
            'New jobs match your preferences.', 'A new job matches your preferences.'))
        self.assertEqual(parse_linkedin(singular), parse_linkedin(plural))
        unknown = replace(plural, body=plural.body.replace(
            'New jobs match your preferences.', 'Recommended content for you.'))
        with self.assertRaises(MailParseError):
            parse_linkedin(unknown)

    def test_observed_counted_alert_preserves_same_job_and_receipt(self):
        plural = mail()
        for header in ('14 new jobs match your preferences.', '2 new jobs match your preferences.'):
            with self.subTest(header=header):
                counted = replace(plural, body=plural.body.replace('New jobs match your preferences.', header))
                self.assertEqual(parse_linkedin(counted), parse_linkedin(plural))
        for header in ('0 new jobs match your preferences.', '14 new jobs match your preferences',
                       'Many new jobs match your preferences.'):
            with self.subTest(header=header), self.assertRaises(MailParseError):
                parse_linkedin(replace(plural, body=plural.body.replace('New jobs match your preferences.', header)))

    def test_notification_is_not_full_listing_or_taiwan_eligibility(self):
        job, = parse_linkedin(mail())
        self.assertEqual(job['canonical_url'], 'https://www.linkedin.com/jobs/view/1234/')
        self.assertNotIn('private', str(job))
        self.assertFalse(job['complete'])
        self.assertFalse(job['body_available'])
        self.assertIsNone(job['taiwan_eligible'])
        self.assertIsNone(job['published_at'])
        self.assertEqual(qualify(job)['status'], 'needs_info')

    def test_resending_does_not_change_receipt(self):
        one = parse_linkedin(mail())[0]
        two = parse_linkedin(replace(mail(), message_id='forwarded', received_at='2026-09-27T02:00:00+00:00'))[0]
        self.assertEqual(one['receipt_id'], two['receipt_id'])

    def test_sender_confirmation_html_and_incomplete_cards_rejected(self):
        for message in (replace(mail(), sender='attacker@linkedin.com'), replace(mail(), is_html=True),
                        replace(mail(), body='Your job alert has been created'),
                        mail('Backend API Engineer\nView job: https://www.linkedin.com/jobs/view/1234/')):
            with self.subTest(message=message.message_id), self.assertRaises(MailParseError):
                parse_linkedin(message)

    def test_urls_never_follow_redirects_or_accept_host_spoofing(self):
        for url in ('https://www.linkedin.com.evil.test/jobs/view/123/',
                    'https://www.linkedin.com@evil.test/jobs/view/123/',
                    'https://www.linkedin.com/jobs/search/?currentJobId=123',
                    'http://www.linkedin.com/jobs/view/123/'):
            with self.subTest(url=url), self.assertRaises(MailParseError):
                canonical(url)

    def test_multiple_cards_and_compensation_evidence(self):
        cards = ('Full-stack developer (Part-time, Equity only)\nExample Co\nIndia\nView job: https://www.linkedin.com/jobs/view/123/\n'
                 '---------------------------------------------------------\nFull-time Backend Engineer\nOther Co\nRemote\nView job: https://www.linkedin.com/jobs/view/456/')
        first, second = parse_linkedin(mail(cards))
        self.assertEqual(first['compensation_evidence'], 'unpaid_or_equity_only')
        self.assertEqual(second['kind'], 'full_time')
        self.assertEqual(qualify(second)['status'], 'excluded')

    def test_duplicate_cards_conflict_fails_whole_notification(self):
        card = 'Backend API Engineer\nExample Co\nRemote\nView job: https://www.linkedin.com/jobs/view/123/'
        self.assertEqual(len(parse_linkedin(mail(card + '\n' + card))), 1)
        with self.assertRaises(MailParseError):
            parse_linkedin(mail(card + '\n' + card.replace('Example Co', 'Different Co')))
