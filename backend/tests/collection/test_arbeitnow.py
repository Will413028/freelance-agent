import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from freelance.modules.collection.arbeitnow import parse_batch, sync, scan, normalize, PROMOTIONAL_FOOTERS, MAX_PAGE_ENTRIES
from freelance.bootstrap.store import SQLiteStore


def entry(**changes):
    return dict(slug='ai-agent-123', title='Part time AI agent developer',
                description='<p>Build an AI agent and API.</p>', remote=True,
                url='https://www.arbeitnow.com/jobs/companies/acme/ai-agent-123',
                tags=['AI'], job_types=['Part Time'], location='Remote',
                created_at=int(datetime.now(timezone.utc).timestamp())) | changes


def payload(*entries):
    return json.dumps(dict(data=list(entries), meta={'current_page': 1, 'per_page': 250,
                           'from': 1 if entries else None, 'to': len(entries) or None},
                           links={'next': None})).encode()


class ArbeitnowTests(TestCase):
    def test_official_api_swiss_links_preserve_unknown_eligibility(self):
        job = normalize(entry(url='https://www.arbeitnow.ch/jobs/companies/acme/ai-agent-123'))
        self.assertEqual(job['canonical_url'], 'https://www.arbeitnow.ch/jobs/companies/acme/ai-agent-123')
        self.assertIsNone(job['taiwan_eligible'])
        with self.assertRaises(ValueError):
            normalize(entry(url='https://www.arbeitnow.ch.evil.test/jobs/companies/acme/ai-agent-123'))

    def test_provider_page_size_can_increase_without_rejecting_valid_jobs(self):
        jobs = [entry(slug=f'job-{i}', url=f'https://www.arbeitnow.com/jobs/companies/acme/job-{i}')
                for i in range(325)]
        raw = json.loads(payload(*jobs))
        raw['meta']['per_page'] = 325
        result = sync(self.store, reader=lambda *a, **kw: json.dumps(raw).encode())
        self.assertEqual((result['status'], result['jobs']), ('ok', 325))
        self.assertTrue(result['complete_scan'])

    def test_page_resource_bound_is_still_enforced(self):
        raw = json.loads(payload())
        raw['data'] = [{}] * (MAX_PAGE_ENTRIES + 1)
        with self.assertRaises(ValueError):
            parse_batch(json.dumps(raw).encode())

    def setUp(self):
        sleeper = patch('freelance.modules.collection.arbeitnow.time.sleep')
        self.sleep = sleeper.start(); self.addCleanup(sleeper.stop)
        tmp = TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.store = SQLiteStore(Path(tmp.name) / 'jobs.sqlite3'); self.store.migrate()

    def test_imports_remote_contract_with_unknown_eligibility_and_replay(self):
        data = payload(entry())
        first = sync(self.store, reader=lambda *a, **kw: data)
        self.assertEqual((first['status'], first['jobs'], first['truncated']), ('ok', 1, False))
        job = self.store.list()[0]['job']
        self.assertEqual(job['attribution'], 'Arbeitnow')
        self.assertIsNone(job['taiwan_eligible'])
        self.assertIsNone(job['budget_max'])
        self.assertEqual(job['kind'], 'contract')
        self.assertEqual(sync(self.store, reader=lambda *a, **kw: data)['jobs'], 1)
        self.assertEqual(len(self.store.list()), 1)

    def test_excludes_local_fulltime_and_irrelevant_jobs(self):
        data = payload(entry(slug='one', url='https://www.arbeitnow.com/jobs/companies/acme/one', remote=False),
                       entry(slug='two', url='https://www.arbeitnow.com/jobs/companies/acme/two', job_types=['Fulltime']),
                       entry(slug='three', url='https://www.arbeitnow.com/jobs/companies/acme/three', title='Part time accountant', description='Bookkeeping'))
        self.assertEqual(sync(self.store, reader=lambda *a, **kw: data)['jobs'], 0)

    def test_bad_listing_is_partial_and_bad_envelope_fails(self):
        data = payload(entry(), entry(slug='bad', url='https://evil.example/jobs/bad'))
        result = sync(self.store, reader=lambda *a, **kw: data)
        self.assertEqual((result['status'], result['rejected_count'], result['jobs']), ('partial', 1, 1))
        self.assertEqual(self.store.sources()['arbeitnow'], 'failed')
        self.assertEqual(sync(self.store, reader=lambda *a, **kw: b'{}')['status'], 'failed')
        with self.assertRaises(ValueError):
            parse_batch(b'{}')

    def test_follows_pages_and_deduplicates_overlap(self):
        first = entry()
        second = entry(slug='second', url='https://www.arbeitnow.com/jobs/companies/acme/second')
        def reader(url, **kwargs):
            page = 2 if url.endswith('page=2') else 1
            raw = json.loads(payload(first, second) if page == 2 else payload(first))
            raw['meta']['current_page'] = page
            raw['links']['next'] = 'https://www.arbeitnow.com/api/job-board-api?page=2' if page == 1 else None
            return json.dumps(raw).encode()
        result = sync(self.store, reader=reader)
        self.assertEqual((result['pages'], result['seen'], result['jobs']), (2, 3, 2))
        self.assertFalse(result['complete_scan'])
        self.assertFalse(result['pagination_consistent'])
        self.assertEqual(len(self.store.list()), 2)

    def test_page_cap_is_partial_with_failed_health(self):
        raw = json.loads(payload(entry()))
        raw['links']['next'] = 'https://www.arbeitnow.com/api/job-board-api?page=2'
        result = sync(self.store, reader=lambda *a, **kw: json.dumps(raw).encode(), max_pages=1)
        self.assertEqual(result['status'], 'partial')
        self.assertFalse(result['complete_scan'])
        self.assertTrue(result['truncated'])
        self.assertEqual(self.store.sources()['arbeitnow'], 'failed')

    def test_observed_regional_pagination_is_pinned_to_primary_endpoint(self):
        calls = []
        def reader(url, **kwargs):
            calls.append(url)
            page = 2 if url.endswith('page=2') else 1
            raw = json.loads(payload(entry()))
            raw['meta']['current_page'] = page
            raw['links']['next'] = 'https://www.arbeitnow.nl/api/job-board-api?page=2' if page == 1 else None
            return json.dumps(raw).encode()
        result = sync(self.store, reader=reader)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(calls, ['https://www.arbeitnow.com/api/job-board-api',
                                 'https://www.arbeitnow.com/api/job-board-api?page=2'])
        self.assertEqual(len(self.store.list()), 1)

    def test_untrusted_and_looping_next_links_fail_before_request(self):
        for link in ('https://evil.test/api/job-board-api?page=2',
                     'https://www.arbeitnow.nl.evil.test/api/job-board-api?page=2',
                     'https://www.arbeitnow.nl/api/job-board-api?page=2&token=x',
                     'http://www.arbeitnow.com/api/job-board-api?page=2',
                     'https://www.arbeitnow.com/api/job-board-api?page=1',
                     'https://www.arbeitnow.com/api/job-board-api?page=2&token=x'):
            raw = json.loads(payload(entry())); raw['links']['next'] = link
            with self.subTest(link=link), self.assertRaises(ValueError):
                parse_batch(json.dumps(raw).encode())

    def test_later_page_failure_does_not_import_earlier_page(self):
        calls = []
        def reader(url, **kwargs):
            calls.append(url)
            if len(calls) == 2: raise OSError('unavailable')
            raw = json.loads(payload(entry()))
            raw['links']['next'] = 'https://www.arbeitnow.com/api/job-board-api?page=2'
            return json.dumps(raw).encode()
        self.assertEqual(sync(self.store, reader=reader)['status'], 'failed')
        self.assertEqual(self.store.list(), [])

    def test_deadline_prevents_next_request(self):
        raw = json.loads(payload(entry()))
        raw['links']['next'] = 'https://www.arbeitnow.com/api/job-board-api?page=2'
        ticks = iter([0, 1, 121]); calls = []
        def reader(url, **kwargs):
            calls.append(url); return json.dumps(raw).encode()
        jobs, coverage = scan(reader=reader, monotonic=lambda:next(ticks))
        self.assertEqual(len(calls), 1)
        self.assertTrue(coverage['truncated'])
        self.assertFalse(coverage['complete_scan'])

    def test_provider_footer_variants_have_same_receipt_but_keep_attribution(self):
        base = entry()
        jobs = [normalize(base | {'description': base['description'] + '\n' + footer})
                for footer in PROMOTIONAL_FOOTERS]
        self.assertEqual(jobs[0], jobs[1])
        self.assertEqual(jobs[0]['description'], 'Build an AI agent and API.')
        self.assertEqual(jobs[0]['attribution'], 'Arbeitnow')
        self.assertEqual(jobs[0]['canonical_url'], base['url'])
        # A similar sentence or non-terminal content is never discarded.
        for value in (base['description'] + PROMOTIONAL_FOOTERS[0] + '<p>Must live in Germany</p>',
                      base['description'] + '<p>Find Jobs in Germany on Arbeitnow</p>'):
            self.assertIn('Arbeitnow', normalize(base | {'description': value})['description'])

    def test_real_content_conflict_still_blocks_entire_import(self):
        base = entry()
        def reader(url, **kwargs):
            page = 2 if url.endswith('page=2') else 1
            raw = json.loads(payload(base | {'description': '<p>20 hours</p>' if page == 1 else '<p>40 hours</p>'}))
            raw['meta']['current_page'] = page
            raw['links']['next'] = 'https://www.arbeitnow.com/api/job-board-api?page=2' if page == 1 else None
            return json.dumps(raw).encode()
        self.assertEqual(sync(self.store, reader=reader)['status'], 'failed')
        self.assertEqual(self.store.list(), [])

    def test_inconsistent_page_metadata_is_partial_even_at_end(self):
        for changes in ({'per_page': 100, 'from': 101, 'to': 250},
                        {'per_page': True}, {'from': None}, {'to': 2}):
            raw = json.loads(payload(entry())); raw['meta'].update(changes)
            with self.subTest(changes=changes):
                result = sync(self.store, reader=lambda *a, **kw: json.dumps(raw).encode())
                self.assertEqual(result['status'], 'partial')
                self.assertFalse(result['complete_scan'])
                self.assertEqual(result['jobs'], 1)

    def test_consistent_pagination_can_complete(self):
        def reader(url, **kwargs):
            page = 2 if url.endswith('page=2') else 1
            job = entry(slug=f'job-{page}', url=f'https://www.arbeitnow.com/jobs/companies/acme/job-{page}')
            raw = json.loads(payload(job))
            raw['meta'] = {'current_page': page, 'per_page': 1, 'from': page, 'to': page}
            raw['links']['next'] = 'https://www.arbeitnow.com/api/job-board-api?page=2' if page == 1 else None
            return json.dumps(raw).encode()
        result = sync(self.store, reader=reader)
        self.assertTrue(result['complete_scan'])
        self.assertEqual((result['status'], result['jobs']), ('ok', 2))
        self.sleep.assert_called_once_with(3)

    def test_pacing_cannot_exceed_deadline(self):
        raw = json.loads(payload(entry()))
        raw['links']['next'] = 'https://www.arbeitnow.com/api/job-board-api?page=2'
        ticks = iter([0, 1, 119]); calls = []
        def reader(url, **kwargs):
            calls.append(url); return json.dumps(raw).encode()
        _, coverage = scan(reader=reader, monotonic=lambda:next(ticks))
        self.assertEqual(len(calls), 1)
        self.sleep.assert_not_called()
        self.assertTrue(coverage['truncated'])
