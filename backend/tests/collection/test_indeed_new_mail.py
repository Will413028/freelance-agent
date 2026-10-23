from dataclasses import replace
import unittest

from freelance.modules.collection.indeed_mail import parse_indeed, SENDER
from freelance.modules.collection.mail import MailMessage, MailParseError

LIST = 'jobalert.' + 'a' * 24 + '.indeed.com'
CARD = '''<table class="width-100" style="border:1px solid #e4e2e0;border-radius:20px">
<tr><td><table><tr><td><h2><a class="strong-text-link"
href="https://tw.indeed.com/rc/clk/dl?jk=0123456789abcdef&amp;tracking=discard">兼職 Python Backend 工程師</a></h2>
<p>Example Co</p><p>台北市</p><p>輕鬆申請</p><p>1天前</p>
</td></tr></table></td></tr></table>'''


class IndeedNewTemplateTests(unittest.TestCase):
    def setUp(self):
        self.mail = MailMessage('test', SENDER, 'Example 的 工程師。台灣 的另外 1 個 軟體 兼職 職缺',
                                CARD, True, '2026-09-30T08:00:00+00:00')

    def parse(self, mail=None, **kw):
        return parse_indeed(mail or self.mail)

    def test_stable_identity_unknowns_and_content_receipt(self):
        job = self.parse()[0]
        self.assertEqual(job['external_id'], '0123456789abcdef')
        self.assertEqual(job['canonical_url'], 'https://tw.indeed.com/rc/clk/dl?jk=0123456789abcdef')
        self.assertEqual(job['location'], '台北市')
        self.assertEqual(job['kind'], 'contract')
        for key in ('weekly_hours', 'taiwan_eligible', 'published_at', 'deadline', 'budget_min'):
            self.assertIsNone(job[key])
        self.assertFalse(job['complete'])
        self.assertFalse(job['body_available'])
        later = self.parse(replace(self.mail, received_at='2026-10-01T08:00:00+00:00'))[0]
        self.assertEqual(job['receipt_id'], later['receipt_id'])
        changed = self.parse(replace(self.mail, body=CARD.replace('Example Co', 'Other Co')))[0]
        self.assertNotEqual(job['receipt_id'], changed['receipt_id'])

    def test_bad_card_rejects_entire_message(self):
        for bad in (CARD.replace('/rc/clk/dl?jk=0123456789abcdef', '/pagead/clk/dl?ad=opaque'),
                    CARD.replace('tw.indeed.com', 'evil.example'),
                    CARD.replace('jk=0123456789abcdef', 'jk=0123456789abcdef&amp;jk=fedcba9876543210'),
                    CARD.replace('<p>Example Co</p>', ''), CARD[:-8], CARD,
                    CARD.replace('<p>輕鬆申請</p>', '<p>Unknown badge</p>')):
            with self.subTest(bad=bad[:50]), self.assertRaises(MailParseError):
                self.parse(replace(self.mail, body=CARD + bad))

    def test_route_and_template_validation(self):
        for mail in (replace(self.mail, sender='other@example.com'),
                     replace(self.mail, subject='帳戶驗證'), replace(self.mail, is_html=False),
                     replace(self.mail, received_at='2026-09-30'),
                     replace(self.mail, body=CARD.replace('strong-text-link', 'unknown'))):
            with self.assertRaises(MailParseError): self.parse(mail)

    def test_salary_and_full_time_are_not_inferred_from_alert(self):
        body = CARD.replace("兼職 Python Backend 工程師", "Full-time App Engineer").replace("<p>輕鬆申請</p>", "<p>月薪 NT$100,000 - NT$180,000</p>")
        job = self.parse(replace(self.mail, body=body))[0]
        self.assertEqual(job["kind"], "full_time")
        self.assertEqual(job["salary_text"], "月薪 NT$100,000 - NT$180,000")
        self.assertIsNone(job["budget_min"])
        self.assertIsNone(job["weekly_hours"])

    def test_opt_in_sync_replay_quarantine_and_recipient(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import Mock
        from freelance.bootstrap.store import SQLiteStore
        from freelance.modules.collection.resend_sync import sync_indeed
        from freelance.modules.collection.resend_preview import preview
        from freelance.modules.collection.source_catalog import enabled_sources
        self.assertEqual(enabled_sources(sources=("indeed",)), ("indeed",))
        self.assertNotIn("indeed", enabled_sources(free_boards=True, talent=True))
        target = "test@example.resend.app"
        row = dict(id="11111111-1111-4111-8111-111111111111", subject=self.mail.subject, html=CARD, created_at=self.mail.received_at, to=[target])
        row["from"] = SENDER
        client = Mock()
        client.list_received.return_value = dict(data=[row], has_more=False)
        client.get_received.return_value = row
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteStore(Path(directory) / "db")
            store.migrate()
            self.assertEqual(sync_indeed(client, store, target)["status"], "ok")
            self.assertEqual(len(store.existing_source_ids("indeed")), 1)
            client.reset_mock()
            self.assertEqual(sync_indeed(client, store, target)["status"], "ok")
            client.get_received.assert_not_called()
            bad = row | dict(id="22222222-2222-4222-8222-222222222222", html=CARD + CARD.replace("/rc/clk/dl?jk=0123456789abcdef", "/pagead/clk/dl?ad=opaque"))
            client.list_received.return_value = dict(data=[bad,row], has_more=False)
            client.get_received.return_value = bad
            self.assertEqual(sync_indeed(client, store, target)["status"], "failed")
            self.assertEqual(len(store.existing_source_ids("indeed")), 1)
            self.assertEqual(store.mail_records("indeed", target)[bad["id"]]["status"], "rejected")
        client.list_received.return_value = dict(data=[row], has_more=False)
        client.get_received.return_value = row | dict(to=["other@example.resend.app"])
        self.assertEqual(preview(client, target, source="indeed")["items"], [])
        client.reset_mock()
        client.list_received.return_value = dict(data=[row | dict(subject="帳戶驗證")], has_more=False)
        preview(client,target,source="indeed")
        client.get_received.assert_not_called()
