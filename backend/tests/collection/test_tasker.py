from fixtures.tasker import listing
import unittest
import freelance.modules.collection.tasker as tasker
from fixtures.mail import message




class TaskerTests(unittest.TestCase):
    def test_observed_single_listing_normalizes_unknowns(self):
        result, = tasker.parse_tasker(message(listing()))
        self.assertEqual(result['title'], '測試網站')
        self.assertEqual(result['description'], '串接 API 與建立網站。')
        self.assertEqual(result['canonical_url'], 'https://www.tasker.com.tw/cases/Ab123')
        self.assertEqual(result['external_id'], 'Ab123')
        self.assertEqual(result['receipt_id'], 'synthetic-message:Ab123')
        self.assertEqual(result['source'], 'tasker')
        self.assertEqual(result['observed_amount'], '$100,000')
        self.assertEqual(result['language'], 'zh-TW')
        self.assertFalse(result['complete'])
        for field in ['kind', 'currency', 'budget_min', 'budget_max', 'weekly_hours', 'taiwan_eligible', 'timezone_compatible', 'deadline']:
            self.assertIsNone(result[field], field)
        for unsafe in ['private', 'tracking', 'HIDDEN', 'FOOTER', 'login']:
            self.assertNotIn(unsafe, str(result))

    def test_removes_pasted_urls_and_link_attributes(self):
        result, = tasker.parse_tasker(message(listing(description='請串接 API https://x.example/?private=fake <a href="https://x.example/?secret=fake">需求</a>')))
        self.assertEqual(result['description'], '請串接 API 需求')

    def test_unverified_sender_rejected(self):
        for sender in ['deals@tasker.com.tw.evil.example', 'deals@tasker.com.tw <other@example.org>', 'other@tasker.com.tw']:
            data = message(listing())
            data['payload']['headers'][0]['value'] = sender
            with self.assertRaises(tasker.TaskerParseError):
                tasker.parse_tasker(data)

    def test_rejects_unsafe_and_multiple_distinct_case_urls(self):
        for url in ['http://www.tasker.com.tw/cases/Ab123', 'https://www.tasker.com.tw.evil.example/cases/Ab123', 'https://user@www.tasker.com.tw/cases/Ab123', 'https://www.tasker.com.tw/cases/Ab-123']:
            body = listing().replace('https://www.tasker.com.tw/cases/Ab123', url)
            with self.assertRaises(tasker.TaskerParseError):
                tasker.parse_tasker(message(body))
        with self.assertRaises(tasker.TaskerParseError):
            tasker.parse_tasker(message(listing(extra='<a href="https://www.tasker.com.tw/cases/Other123">Other</a>')))

    def test_unknown_template_or_title_mismatch_rejected_without_content(self):
        for body in ['PRIVATE BODY', listing().replace('需求說明', 'PRIVATE BODY'), listing().replace('測試網站', 'PRIVATE BODY')]:
            with self.assertRaises(tasker.TaskerParseError) as result:
                tasker.parse_tasker(message(body))
            self.assertNotIn('PRIVATE', str(result.exception))

    def test_plain_text_observed_template(self):
        body = '2026/09/17 最新案件，限時搶先提案！\n測試網站\n$100,000\n台北市\n需求說明\n串接 API\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123\n其它需求\nFOOTER'
        result, = tasker.parse_tasker(message(body, 'text/plain'))
        self.assertEqual(result['description'], '串接 API')

    def test_other_url_forms_removed_and_hidden_cases_ignored(self):
        result, = tasker.parse_tasker(message(listing(
            extra='<script><a href="https://www.tasker.com.tw/cases/Secret123">hidden</a></script>',
            description='API //tracking.example/?private=fake mailto:user@example.org?private=fake www.example.org/?private=fake')))
        self.assertEqual(result['description'], 'API')

    def test_job_url_compatible_with_domain_consumers(self):
        result, = tasker.parse_tasker(message(listing()))
        self.assertEqual(result['url'], result['canonical_url'])

    def test_cta_phrase_inside_description_preserves_later_constraints(self):
        description = '建立網站，按鈕文字為查看完整資訊，另外需要串接 API，僅限美國居民。'
        result, = tasker.parse_tasker(message(listing(description=description)))
        self.assertEqual(result['description'], description)
        plain = '2026/09/17 最新案件，限時搶先提案！\n測試網站\n$100,000\n台北市\n需求說明\n' + description + '\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123\n其它需求'
        result, = tasker.parse_tasker(message(plain, 'text/plain'))
        self.assertEqual(result['description'], description)

    def test_cta_must_be_case_anchor_and_plain_text_boundary_unambiguous(self):
        body = listing().replace('>查看完整資訊</a>', '>不同連結</a>').replace('串接 API 與建立網站。', '查看完整資訊')
        with self.assertRaises(tasker.TaskerParseError):
            tasker.parse_tasker(message(body))
        plain = '2026/09/17 最新案件，限時搶先提案！\n測試網站\n$100,000\n台北市\n需求說明\nAPI\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123'
        for ambiguous in [plain + '\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123', plain.replace('查看完整資訊 https:', '查看完整資訊 unrelated https:')]:
            with self.assertRaises(tasker.TaskerParseError):
                tasker.parse_tasker(message(ambiguous, 'text/plain'))

    def test_regular_listing_banner_preserves_requirements_in_html_and_plain_text(self):
        bodies=[(listing().replace('最新案件，限時搶先提案！','最新上架案件，歡迎提案'),'text/html'),
                ('2026/09/17 最新上架案件，歡迎提案\n測試網站\n$15,000\n台北市\n需求說明\n串接 API 與建立網站。\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123','text/plain')]
        for body,mime in bodies:
            with self.subTest(mime=mime):
                result,=tasker.parse_tasker(message(body,mime))
                self.assertEqual(result['description'],'串接 API 與建立網站。')
                self.assertIsNone(result['currency'])
                self.assertFalse(result['complete'])

    def test_unobserved_banner_is_not_accepted_as_a_listing(self):
        with self.assertRaises(tasker.TaskerParseError):
            tasker.parse_tasker(message(listing().replace('最新案件，限時搶先提案！','未知郵件格式')))

    def test_negotiable_budget_remains_unknown_in_valid_single_listing(self):
        result,=tasker.parse_tasker(message(listing().replace('$100,000','預算詳談')))
        self.assertIsNone(result['observed_amount'])
        self.assertIsNone(result['budget_max'])
        self.assertIsNone(result['currency'])
        self.assertEqual(result['description'],'串接 API 與建立網站。')
