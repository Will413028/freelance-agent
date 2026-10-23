from dataclasses import replace
import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock
from freelance.modules.collection.jobbank104_mail import SENDER, parse_104
from freelance.modules.collection.mail import MailMessage, MailParseError
from freelance.modules.collection.resend_preview import preview
from freelance.modules.collection.resend_sync import sync_104
from freelance.bootstrap.store import SQLiteStore
import freelance.legacy.ai_drafts as ai_drafts


def card(ident='abc123'):
    return ('<a href="https://www.104.com.tw/job/' + ident + '?tracking=private">兼職 Backend API 工程師</a>'
            '<a href="https://www.104.com.tw/company/company1">Example</a>'
            '<p>台北市 | 經歷不拘</p><p>API 開發需求摘要...</p><p>時薪300元以上</p>'
            '<a href="https://104app.onelink.me/zB8j/apply?private=token">我要應徵</a>')


def message():
    return MailMessage('test', SENDER, '測試09/26的配對日報，符合職缺1筆',
                       '<p>私人稱呼</p>' + card() + '<h2>適合你大展身手的工作</h2>' + card('recommend'),
                       True, '2026-09-26T03:00:00+00:00')


class Jobbank104Tests(unittest.TestCase):
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
            self.assertEqual(sync_104(client, store, target)['jobs'], 1)
            saved = store.list()[0]
            store.track(saved['id'], 0, feedback='interested')
            self.assertIsNone(ai_drafts._priority(store.list()[0]))
            store.review(saved['id'], 'edit', saved['version'], 'My reviewed notes')
            client.get_received.return_value = received | {'created_at': '2026-09-27T00:00:00Z'}
            self.assertEqual(sync_104(client, store, target)['status'], 'ok')
            self.assertEqual(len(store.list()), 1)
            self.assertEqual(store.list()[0]['proposal'], 'My reviewed notes')
            # New malformed mail is quarantined; an already processed ID is not reread.
            bad = client.get_received.return_value | {'id': '22222222-2222-4222-8222-222222222222', 'html': '<p>unsupported</p>'}
            client.list_received.return_value = {'data': [bad], 'has_more': False}
            client.get_received.return_value = bad
            self.assertEqual(sync_104(client, store, target)['status'], 'failed')
            self.assertEqual(store.sources()['jobbank104'], 'failed')
            self.assertEqual(store.list()[0]['proposal'], 'My reviewed notes')

    def test_only_matching_cards_and_no_trackers_or_complete_body(self):
        job, = parse_104(message())
        self.assertEqual(job['url'], 'https://www.104.com.tw/job/abc123')
        self.assertEqual(job['company'], 'Example')
        self.assertFalse(job['body_available'])
        self.assertFalse(job['complete'])
        self.assertIsNone(job['budget_min'])
        self.assertIsNone(job['taiwan_eligible'])
        self.assertNotIn('private', str(job))
        self.assertNotIn('私人稱呼', str(job))
        self.assertNotIn('recommend', str(job))

    def test_invalid_template_card_count_links_and_duplicates_fail(self):
        m = message()
        for bad in (replace(m, sender='imposter@104.com.tw'), replace(m, is_html=False),
                    replace(m, subject='驗證通知'), replace(m, received_at='2026-09-26'),
                    replace(m, subject=m.subject.replace('1筆', '2筆')),
                    replace(m, body=m.body.replace('適合你大展身手的工作', '新版格式')),
                    replace(m, body=m.body.replace('https://www.104.com.tw/job/', 'https://evil.test/job/')),
                    replace(m, body=m.body.replace('https://www.104.com.tw/company/', 'http://www.104.com.tw/company/')),
                    replace(m, body=m.body.replace('我要應徵', '未完整')),
                    replace(m, subject=m.subject.replace('1筆', '2筆'), body=card()+m.body)):
            with self.subTest(subject=bad.subject), self.assertRaises(MailParseError):
                parse_104(bad)

    def test_receipt_stable_across_forward_and_tracking(self):
        m = message()
        changed = replace(m, message_id='next', received_at='2026-09-27T00:00:00Z',
                          body=m.body.replace('tracking=private', 'tracking=other'))
        self.assertEqual(parse_104(m)[0]['receipt_id'], parse_104(changed)[0]['receipt_id'])

    def test_preview_skips_non_job_subject_and_rechecks_envelope(self):
        m = message(); target = 'test@example.resend.app'
        mail = dict(id='11111111-1111-4111-8111-111111111111', subject=m.subject,
                    created_at=m.received_at, to=[target], html=m.body)
        mail['from'] = SENDER
        client = Mock(); client.list_received.return_value = dict(data=[mail], has_more=False)
        client.get_received.return_value = mail
        self.assertEqual(preview(client, target)['body_reads'], 0)
        self.assertEqual(len(preview(client, target, source='jobbank104')['items']), 1)
        client.get_received.return_value = mail | {'to':['other@example.test']}
        self.assertEqual(len(preview(client, target, source='jobbank104')['errors']), 1)
        client.reset_mock()
        client.list_received.return_value = dict(data=[mail | {'subject':'其他通知'}], has_more=False)
        self.assertEqual(preview(client, target, source='jobbank104')['body_reads'], 0)
        client.get_received.assert_not_called()
