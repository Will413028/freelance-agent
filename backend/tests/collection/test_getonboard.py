import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch

from freelance.modules.collection.getonboard import normalize, fetch, sync
from freelance.bootstrap.store import SQLiteStore


def listing(**changes):
    attrs = dict(title='Part time AI agent backend engineer', description='<p>Build an AI agent and API.</p>',
                 modality={'data': {'id': 42}}, remote=True, remote_modality='fully_remote',
                 countries=['Remote'], published_at=int(datetime.now(timezone.utc).timestamp()),
                 category_name='Programming', lang='en', min_salary=1000, max_salary=2000) | changes
    return dict(id='acme-ai-agent', attributes=attrs, links={'public_url': 'https://www.getonbrd.com/jobs/acme-ai-agent'})


class GetOnBoardTests(TestCase):
    def setUp(self):
        tmp = TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.store = SQLiteStore(Path(tmp.name) / 'jobs.sqlite3'); self.store.migrate()

    def test_taxonomy_controls_kind_without_assuming_numeric_id(self):
        job = normalize(listing(), {'42': 'part_time'})
        self.assertEqual(job['kind'], 'contract'); self.assertIsNone(job['taiwan_eligible'])
        self.assertIsNone(job['budget_max']); self.assertIsNone(job['currency'])
        self.assertEqual(job['salary_evidence']['max'], 2000)
        self.assertEqual(normalize(listing(), {'42': 'full_time'})['kind'], 'full_time')
        with self.assertRaises(ValueError): normalize(listing(), {'1': 'part_time'})

    def test_canonical_host_and_regional_restriction(self):
        item = listing(); item['links']['public_url'] = 'https://evil.example/jobs/acme-ai-agent'
        with self.assertRaises(ValueError): normalize(item, {'42': 'part_time'})
        self.assertFalse(normalize(listing(title='Backend API engineer LATAM'), {'42': 'part_time'})['taiwan_eligible'])

    def test_replay_and_partial_preserve_manual_work(self):
        job = normalize(listing(), {'42': 'part_time'})
        data = {'jobs': [job], 'seen': 1, 'rejected_count': 0, 'pages': 1, 'truncated': False}
        self.assertEqual(sync(self.store, reader=lambda: data)['jobs'], 1)
        item = self.store.list()[0]; self.store.review(item['id'], 'edit', item['version'], text='Human draft')
        data['rejected_count'] = 1
        self.assertEqual(sync(self.store, reader=lambda: data)['status'], 'partial')
        self.assertEqual(self.store.list()[0]['proposal'], 'Human draft')
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(self.store.sources()['getonboard'], 'failed')

    def test_fulltime_and_nontechnical_never_new_candidates(self):
        for changes, modality in (({}, 'full_time'), ({'category_name': 'Sales'}, 'part_time')):
            job = normalize(listing(**changes), {'42': modality})
            data = {'jobs': [job], 'seen': 1, 'rejected_count': 0, 'pages': 1, 'truncated': False}
            self.assertEqual(sync(self.store, reader=lambda: data)['jobs'], 0)

    def test_official_pagination_reads_both_pages_and_no_auth(self):
        taxonomy = {'data': [{'id': '42', 'attributes': {'locale_key': 'part_time'}}], 'meta': {'total_pages': 1}}
        pages = [taxonomy, {'data': [listing()], 'meta': {'page': 1, 'total_pages': 2}},
                 {'data': [], 'meta': {'page': 2, 'total_pages': 2}}]
        response = Mock(status=200); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        opener = Mock(); opener.open.return_value = response
        with patch('freelance.modules.collection.getonboard.build_opener', return_value=opener), \
             patch('freelance.modules.collection.getonboard.read_body', side_effect=[json.dumps(x).encode() for x in pages]), \
             patch('freelance.modules.collection.getonboard.time.sleep'):
            result = fetch()
        self.assertEqual(result['pages'], 2); self.assertFalse(result['truncated'])
        self.assertEqual(len(result['jobs']), 1)
        self.assertIn('page=2', opener.open.call_args.args[0].full_url)
        for call in opener.open.call_args_list:
            self.assertIsNone(call.args[0].get_header('Authorization'))
