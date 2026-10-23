from dataclasses import replace
import unittest

from freelance.modules.collection.indeed_mail import inspect_indeed, SENDER
from freelance.modules.collection.mail import MailMessage, MailParseError

LIST = 'jobalert.' + 'a' * 24 + '.indeed.com'
CARD = '''<a href="https://engage.indeed.com/f/a/outer"><table>
<tr><td class="r-e"><a href="https://engage.indeed.com/f/a/opaque">AI Agent Engineer</a></td></tr>
<tr><td><span class="r-g">Example Co</span><span class="r-h">- Taiwan</span></td></tr>
<tr><td class="r-k">月薪100,000元</td></tr>
<tr><td class="r-i">Build agent APIs...</td></tr>
<tr><td class="r-j">3天前</td></tr></table></a>'''


class IndeedInspectionTests(unittest.TestCase):
    def setUp(self):
        self.mail = MailMessage('test', SENDER, '職缺通知', CARD, True,
                                '2026-09-26T08:53:33+00:00')

    def inspect(self, mail=None, **kwargs):
        return inspect_indeed(mail or self.mail, list_id=kwargs.get('list_id', LIST),
                              expected_list_id=LIST)

    def test_summary_has_no_tracking_url_or_invented_identity(self):
        result = self.inspect()
        self.assertFalse(result['ingestible'])
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['cards'][0]['salary_text'], '月薪100,000元')
        for value in ('https://', 'external_id', 'budget_min', 'published_at'):
            self.assertNotIn(value, str(result))

    def test_repeated_cards_preserved_without_guessing_identity(self):
        self.assertEqual(len(self.inspect(replace(self.mail, body=CARD * 2))['cards']), 2)

    def test_wrong_route_rejected(self):
        for mail in (replace(self.mail, sender='other@example.com'),
                     replace(self.mail, is_html=False),
                     replace(self.mail, received_at='2026-09-26')):
            with self.assertRaises(MailParseError): self.inspect(mail)
        with self.assertRaises(MailParseError): self.inspect(list_id='other')

    def test_malformed_and_unexpected_templates_rejected(self):
        for body in ('no jobs', CARD.replace('r-g', 'unknown'),
                     CARD.replace('engage.indeed.com/f/a/opaque', 'evil.example/opaque'),
                     CARD[:CARD.index('<tr><td class="r-j"')], CARD * 101):
            with self.subTest(body=body[:30]), self.assertRaises(MailParseError):
                self.inspect(replace(self.mail, body=body))
