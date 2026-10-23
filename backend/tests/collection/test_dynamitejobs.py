from datetime import datetime, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from urllib.error import HTTPError

from freelance.modules.collection.dynamitejobs import INDEX, canonical, parse_index, parse_article, fetch, sync
from freelance.bootstrap.store import SQLiteStore

URL = 'https://dynamitejobs.com/company/example/remote-job/ai-agent-engineer'


def detail(**changes):
    data = {'@type': 'JobPosting', 'title': 'AI agent API engineer', 'description': '<p>Build an AI agent API.</p>',
            'url': URL, 'employmentType': 'CONTRACTOR', 'jobLocationType': 'TELECOMMUTE',
            'applicantLocationRequirements': [{'@type': 'Country', 'name': 'Taiwan'}],
            'datePosted': datetime.now(timezone.utc).isoformat()} | changes
    return ('<script type="application/ld+json">' + json.dumps(data) + '</script>').encode()


class DynamiteJobsTests(TestCase):
    def setUp(self):
        temp = TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.store = SQLiteStore(Path(temp.name) / 'test.sqlite3'); self.store.migrate()

    def test_canonical_is_strict_and_index_deduplicates(self):
        self.assertEqual(canonical(URL+'?utm_source=test#apply'), URL)
        self.assertEqual(parse_index(f'<a href="{URL}">job</a><a href="{URL}">job</a>'.encode()), [URL])
        for value in ('https://dynamitejobs.com.evil.example/company/a/remote-job/b',
                      'https://dynamitejobs.com/api/jobs', 'http://dynamitejobs.com/company/a/remote-job/b'):
            with self.assertRaises(ValueError): canonical(value)
        with self.assertRaises(ValueError): parse_index(b'<h1>No recognized jobs</h1>')

    def test_unknowns_preserved_and_explicit_region_excluded(self):
        job = parse_article(detail(), URL)
        self.assertIsNone(job['taiwan_eligible']); self.assertIsNone(job['weekly_hours'])
        self.assertIsNone(job['budget_min']); self.assertTrue(job['body_available'])
        job = parse_article(detail(applicantLocationRequirements=[{'@type':'Country','name':'United States'}]), URL)
        self.assertFalse(job['taiwan_eligible'])

    def test_fulltime_metadata_wins_over_contract_title(self):
        job = parse_article(detail(title='Contract AI agent engineer', employmentType='FULL_TIME'), URL)
        self.assertEqual(job['kind'], 'full_time')
        self.assertEqual(self.run_sync([job])['jobs'], 0)

    def test_mismatched_url_missing_body_and_bad_location_rejected(self):
        for changes in ({'url': URL+'-other'}, {'description':''}, {'applicantLocationRequirements': 'Worldwide'},
                        {'datePosted':'yesterday'}, {'employmentType':None}):
            with self.subTest(changes=changes), self.assertRaises((ValueError, TypeError)):
                parse_article(detail(**changes), URL)

    def run_sync(self, jobs, **changes):
        result = dict(jobs=jobs, seen=len(jobs), details_read=len(jobs), rejected_count=0, truncated=False) | changes
        return sync(self.store, reader=lambda: result)

    def test_replay_preserves_human_draft_and_partial_is_visible(self):
        job = parse_article(detail(), URL)
        self.assertEqual(self.run_sync([job])['jobs'], 1)
        item = self.store.list()[0]
        self.store.review(item['id'], 'edit', item['version'], text='Human proposal')
        self.assertEqual(self.run_sync([job], truncated=True)['status'], 'partial')
        self.assertEqual(self.store.list()[0]['proposal'], 'Human proposal')
        self.assertEqual(self.store.sources()['dynamitejobs'], 'failed')
        self.assertEqual(len(self.store.list()), 1)

    def test_updated_fulltime_is_ingested_to_exclude_existing_candidate(self):
        self.run_sync([parse_article(detail(), URL)])
        self.run_sync([parse_article(detail(employmentType='FULL_TIME'), URL)])
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'excluded')

    def test_access_block_stops_subsequent_requests(self):
        for blocked in (b'<title>Just a moment...</title>', 403, 429):
            calls = []
            def reader(url):
                calls.append(url)
                if url == INDEX:
                    return f'<a href="{URL}">a</a><a href="{URL}-two">b</a>'.encode()
                if isinstance(blocked, int): raise HTTPError(url, blocked, 'Blocked', {}, None)
                return blocked
            with self.subTest(blocked=blocked), self.assertRaises((ValueError, HTTPError)):
                fetch(read=reader, pause=lambda _: None)
            self.assertEqual(calls, [INDEX, URL])

    def test_bad_detail_partial_and_good_detail_survives(self):
        def reader(url):
            if url == INDEX: return f'<a href="{URL}">a</a><a href="{URL}-two">b</a>'.encode()
            return detail() if url == URL else b'<h1>Missing metadata</h1>'
        result = fetch(read=reader, pause=lambda _:None)
        self.assertEqual(result['seen'], 2); self.assertEqual(result['rejected_count'], 1)
        self.assertEqual(len(result['jobs']), 1); self.assertFalse(result['complete_scan'])
