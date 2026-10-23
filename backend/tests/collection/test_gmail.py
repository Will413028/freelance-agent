from fixtures.gmail import mail, Client, Store
import unittest

from fixtures.mail import message
from fixtures.tasker import listing
from freelance.modules.collection.gmail import sync_tasker








class GmailTests(unittest.TestCase):
    def test_pages_deduplicate_and_persist_oldest_first(self):
        client = Client({None: {'messages': [{'id': 'new'}, {'id': 'old'}], 'nextPageToken': 'p2'},
                         'p2': {'messages': [{'id': 'old'}, {'id': 'middle'}]}},
                        {'new': mail('new', '1789603200002'), 'middle': mail('middle', '1789603200001'), 'old': mail('old', '1789603200000')})
        store = Store()
        result = sync_tasker(client, store)
        self.assertEqual(result, {'source': 'tasker', 'status': 'ok', 'pages': 2, 'messages': 3, 'jobs': 3})
        self.assertEqual([receipt for _, receipt in store.jobs], ['old:Ab123', 'middle:Ab123', 'new:Ab123'])
        self.assertEqual(store.health, [('tasker', 'failed'), ('tasker', 'ok')])
        self.assertEqual([call[1] for call in client.calls], [None, 'p2'])
        self.assertTrue(all(call[0] == 'from:deals@tasker.com.tw newer_than:90d' for call in client.calls))

    def test_empty_scan_is_success(self):
        store = Store()
        result = sync_tasker(Client({None: {}}, {}), store)
        self.assertEqual(result, {'source': 'tasker', 'status': 'ok', 'pages': 1, 'messages': 0, 'jobs': 0})
        self.assertEqual(store.health[-1], ('tasker', 'ok'))

    def test_bad_template_prevents_all_persistence(self):
        store = Store()
        client = Client({None: {'messages': [{'id': 'good'}, {'id': 'bad'}]}}, {'good': mail('good'), 'bad': mail('bad', body='PRIVATE BODY')})
        result = sync_tasker(client, store)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(store.jobs, [])
        self.assertEqual(store.health, [('tasker', 'failed')])
        self.assertNotIn('PRIVATE', str(result))

    def test_malformed_api_and_id_mismatch_fail(self):
        for pages, messages in [({None: {'messages': 'bad'}}, {}),
                                ({None: {'messages': [{'id': 'wanted'}]}}, {'wanted': mail('wrong')}),
                                ({None: {'messages': [{'id': 'a'}], 'nextPageToken': 'p'}, 'p': {'messages': [], 'nextPageToken': 'p'}}, {'a': mail('a')})]:
            with self.subTest(pages=pages):
                store = Store()
                result = sync_tasker(Client(pages, messages), store)
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(store.jobs, [])
                self.assertEqual(store.health, [('tasker', 'failed')])

    def test_caps_fail_before_persistence(self):
        client = Client({None: {'messages': [{'id': 'a'}], 'nextPageToken': 'p'}, 'p': {'messages': [{'id': 'b'}]}}, {'a': mail('a'), 'b': mail('b')})
        for limits in [{'max_pages': 1}, {'max_messages': 1}]:
            with self.subTest(limits=limits):
                store = Store()
                result = sync_tasker(client, store, **limits)
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(store.jobs, [])
        for bad in [0, -1, True, 1.5, '2']:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    sync_tasker(client, Store(), max_pages=bad)
                with self.assertRaises(ValueError):
                    sync_tasker(client, Store(), max_messages=bad)
        store = Store()
        capped = Client({None: {'messages': [{'id': 'a'}], 'nextPageToken': 'p'}}, {'a': mail('a')})
        self.assertEqual(sync_tasker(capped, store, max_messages=1)['status'], 'failed')
        self.assertEqual([call[1] for call in capped.calls], [None])
        self.assertEqual(store.jobs, [])

    def test_api_and_store_errors_are_content_free(self):
        class BrokenClient(Client):
            def get_message(self, mid):
                raise RuntimeError('PRIVATE token')
        store = Store()
        result = sync_tasker(BrokenClient({None: {'messages': [{'id': 'a'}]}}, {}), store)
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('PRIVATE', str(result))
        class BrokenStore(Store):
            def ingest(self, job, receipt_id=None):
                raise RuntimeError('PRIVATE DB')
        result = sync_tasker(Client({None: {'messages': [{'id': 'a'}]}}, {'a': mail('a')}), BrokenStore())
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('PRIVATE', str(result))


if __name__ == '__main__':
    unittest.main()
