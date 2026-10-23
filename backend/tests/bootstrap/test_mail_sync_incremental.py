"""Synthetic receiving pages and a real temporary SQLite database."""
from pathlib import Path
import tempfile
import unittest

from freelance.modules.collection.resend_sync import sync_tasker
from freelance.bootstrap.store import SQLiteStore
from fixtures.resend_preview import mail, TARGET
from fixtures.tasker import listing


def notification(n, **changes):
    return mail(id=f'{n:08x}-02e9-4d39-ad75-9611e0fcc33c',
                html=listing().replace('Ab123', f'Case{n}')) | changes


class Client:
    def __init__(self, messages, page_size=2):
        self.messages, self.page_size = messages, page_size
        self.reads, self.pages, self.unavailable = [], [], set()

    def list_received(self, *, after=None):
        self.pages.append(after)
        start = 0 if after is None else next(i + 1 for i, x in enumerate(self.messages) if x['id'] == after)
        data = self.messages[start:start + self.page_size]
        return {'data': data, 'has_more': start + len(data) < len(self.messages)}

    def get_received(self, message_id, *, retry_source=None):
        self.reads.append(message_id)
        if message_id in self.unavailable:
            raise TimeoutError('synthetic read failure')
        return next(x for x in self.messages if x['id'] == message_id)


class IncrementalMailTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = SQLiteStore(Path(self.directory.name) / 'mail.db')
        self.store.migrate()

    def test_walks_pages_and_second_run_reads_only_new_messages(self):
        client = Client([notification(n) for n in range(5, 0, -1)])
        result = sync_tasker(client, self.store, TARGET)
        self.assertEqual((result['status'], result['jobs']), ('ok', 5))
        client.messages.insert(0, notification(6))
        client.reads.clear()
        self.assertEqual(sync_tasker(client, self.store, TARGET)['jobs'], 1)
        self.assertEqual(client.reads, [notification(6)['id']])
        self.assertEqual(len(self.store.list()), 6)

    def test_body_limit_resumes_mid_page_without_losing_new_arrivals(self):
        client = Client([notification(n) for n in range(5, 0, -1)], page_size=5)
        self.assertTrue(sync_tasker(client, self.store, TARGET, max_messages=2)['truncated'])
        client.messages.insert(0, notification(6))
        self.assertTrue(sync_tasker(client, self.store, TARGET, max_messages=2)['truncated'])
        self.assertTrue(sync_tasker(client, self.store, TARGET, max_messages=2)['complete_scan'])
        self.assertEqual(sync_tasker(client, self.store, TARGET)['jobs'], 1)
        self.assertEqual(len(self.store.list()), 6)
        self.assertEqual(len(client.reads), 6)

    def test_page_limit_has_durable_progress(self):
        client = Client([notification(n) for n in range(5, 0, -1)])
        for expected in (2, 4, 5):
            result = sync_tasker(client, self.store, TARGET, max_pages=1)
            self.assertEqual(len(self.store.list()), expected)
        self.assertTrue(result['complete_scan'])

    def test_bad_message_quarantined_while_other_messages_are_imported(self):
        client = Client([notification(3), notification(2, html='unsupported'), notification(1)])
        result = sync_tasker(client, self.store, TARGET)
        self.assertEqual((result['status'], result['quarantined']), ('failed', 1))
        self.assertTrue(result['complete_scan'])
        self.assertEqual(len(self.store.list()), 2)
        client.reads.clear()
        self.assertEqual(sync_tasker(client, self.store, TARGET)['quarantined'], 1)
        self.assertEqual(client.reads, [])

    def test_transient_fetch_failure_does_not_advance_over_unread_message(self):
        client = Client([notification(3), notification(2), notification(1)])
        client.unavailable.add(notification(2)['id'])
        self.assertTrue(sync_tasker(client, self.store, TARGET)['truncated'])
        self.assertEqual(len(self.store.list()), 1)
        client.unavailable.clear()
        self.assertEqual(sync_tasker(client, self.store, TARGET)['status'], 'ok')
        self.assertEqual(len(self.store.list()), 3)
        self.assertEqual(client.reads.count(notification(3)['id']), 1)

    def test_recipient_change_does_not_reuse_another_inbox_cursor(self):
        client = Client([notification(1)])
        sync_tasker(client, self.store, TARGET)
        result = sync_tasker(client, self.store, 'other@inbox.resend.app')
        self.assertEqual(result['error_stages'], {'metadata': 1})
        self.assertEqual(len(client.reads), 2)

    def test_quarantine_can_be_explicitly_requeued_without_reimporting_good_mail(self):
        client = Client([notification(2, html='unsupported'), notification(1)])
        sync_tasker(client, self.store, TARGET)
        prior_cursor = self.store.mail_state('tasker', TARGET)
        self.store.retry_mail('tasker', TARGET, notification(2)['id'])
        self.assertEqual(self.store.mail_state('tasker', TARGET), prior_cursor)
        self.assertEqual(self.store.mail_records('tasker', TARGET)[notification(2)['id']]['reason'], 'template')
        client.messages[0] = notification(2)
        client.reads.clear()
        self.assertEqual(sync_tasker(client, self.store, TARGET)['status'], 'ok')
        self.assertEqual(client.reads, [notification(2)['id']])
        self.assertEqual(len(self.store.list()), 2)
        with self.assertRaises(ValueError):
            self.store.retry_mail('tasker', TARGET, notification(1)['id'])

    def test_invalid_recipient_is_rejected_before_any_read(self):
        client = Client([])
        with self.assertRaises(ValueError):
            sync_tasker(client, self.store, 'other@example.test')
        self.assertEqual(client.pages, [])

    def test_retry_fetch_failure_preserves_request_and_normal_cursor(self):
        bad = notification(2, html='unsupported')
        client = Client([bad, notification(1)])
        sync_tasker(client, self.store, TARGET)
        prior_cursor = self.store.mail_state('tasker', TARGET)
        self.store.retry_mail('tasker', TARGET, bad['id'])
        client.unavailable.add(bad['id'])
        result = sync_tasker(client, self.store, TARGET)
        self.assertEqual((result['status'], result['complete_scan'], result['retry_pending']), ('failed', True, 1))
        record = self.store.mail_records('tasker', TARGET)[bad['id']]
        self.assertEqual((record['status'], record['reason'], record['retry_pending']), ('rejected', 'template', 1))
        self.assertEqual(self.store.mail_state('tasker', TARGET), prior_cursor)
        client.unavailable.clear()
        client.messages[0] = notification(2)
        self.assertEqual(sync_tasker(client, self.store, TARGET)['status'], 'ok')
        self.assertEqual(self.store.mail_records('tasker', TARGET)[bad['id']]['retry_pending'], 0)

    def test_unavailable_old_retry_does_not_block_new_mail(self):
        bad = notification(1, html='unsupported')
        client = Client([bad])
        sync_tasker(client, self.store, TARGET)
        self.store.retry_mail('tasker', TARGET, bad['id'])
        client.unavailable.add(bad['id'])
        for number in (2, 3):
            client.messages.insert(0, notification(number))
            client.reads.clear()
            result = sync_tasker(client, self.store, TARGET, max_messages=2)
            self.assertEqual((result['jobs'], result['complete_scan'], result['retry_pending']), (1, True, 1))
            self.assertEqual(client.reads, [notification(number)['id'], bad['id']])
            self.assertEqual(self.store.mail_state('tasker', TARGET)['cursor'], notification(number)['id'])
        self.assertEqual(len(self.store.list()), 2)

    def test_retry_revalidates_sender_and_recipient(self):
        bad = notification(2, html='unsupported')
        client = Client([bad])
        sync_tasker(client, self.store, TARGET)
        for change in ({'from': 'attacker@example.test'}, {'received_for': ['other@inbox.resend.app']}):
            with self.subTest(change=change):
                self.store.retry_mail('tasker', TARGET, bad['id'])
                client.messages[0] = notification(2, **change)
                result = sync_tasker(client, self.store, TARGET)
                self.assertEqual(result['error_stages'], {'metadata': 1})
                self.assertEqual(len(self.store.list()), 0)
                self.assertEqual(self.store.mail_records('tasker', TARGET)[bad['id']]['retry_pending'], 0)

    def test_content_conflict_is_not_a_parser_retry(self):
        self.store.record_mail('tasker', TARGET, notification(1)['id'], 'conflict', 'content_changed')
        with self.assertRaises(ValueError):
            self.store.retry_mail('tasker', TARGET, notification(1)['id'])

    def test_changed_content_and_unrelated_new_mail_are_processed_together(self):
        client = Client([notification(1)])
        self.assertEqual(sync_tasker(client, self.store, TARGET)['jobs'], 1)
        changed = notification(2, html=listing(description='需要不同的 API 整合工作。').replace('Ab123', 'Case1'))
        client.messages[:0] = [notification(3), changed]
        result = sync_tasker(client, self.store, TARGET)
        self.assertEqual((result['status'], result['jobs'], result['content_versions']), ('ok', 2, 1))
        self.assertEqual(len(self.store.list()), 2)
        first = next(item for item in self.store.list() if item['job']['external_id'] == 'Case1')
        self.assertEqual(len(first['content_conflicts'][0]['versions']), 2)
        self.assertEqual({row['status'] for row in self.store.mail_records('tasker', TARGET).values()}, {'processed'})
        self.assertEqual(self.store.mail_state('tasker', TARGET)['cursor'], notification(3)['id'])
