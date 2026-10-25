from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from urllib.error import HTTPError

from freelance.modules.collection.jobbank518 import CATEGORIES, INDEX, canonical, parse_index, parse_article, fetch, sync
from freelance.bootstrap.store import SQLiteStore

URL = 'https://www.518.com.tw/job-Ab1234.html'


def index(*urls, empty=False):
    return ('<h1>' + '、'.join(CATEGORIES) + ' 的兼職工作職缺</h1>' +
            ''.join(f'<a href="{u}">job</a>' for u in urls) +
            ('<p>抱歉沒有搜到適合的職缺</p>' if empty else '')).encode()


def detail(**changes):
    data = {'@type': 'JobPosting', 'title': '兼職 AI agent API 工程師',
            'description': '<p>開發 AI agent API</p><br>職務類別<br>AI工程師<br>職缺條件<br>兼職',
            'url': URL, 'employmentType': ['PART_TIME'], 'datePosted': '2026-01-01',
            'jobLocation': {'address': {'addressCountry': 'TW'}},
            'baseSalary': {'currency': 'TWD', 'value': {'minValue': 500, 'unitText': 'HOUR'}}} | changes
    return ('<time>更新日期:2026-09-26</time><script type="application/ld+json">' +
            json.dumps([data, {'@type': 'BreadcrumbList'}]) + '</script>').encode()


class Jobbank518Tests(TestCase):
    def setUp(self):
        temp = TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.store = SQLiteStore(Path(temp.name) / 'test.sqlite3'); self.store.migrate()

    def test_explicit_empty_success_is_distinct_from_broken_or_wrong_filter(self):
        self.assertEqual(parse_index(index(empty=True)), [])
        for raw in (b'<h1>No data</h1>', index(), index(URL, empty=True), index(URL).replace('兼職'.encode(), '全職'.encode())):
            with self.assertRaises(ValueError): parse_index(raw)
        result = fetch(read=lambda _: index(empty=True), pause=lambda _: None)
        self.assertEqual(sync(self.store, reader=lambda: result)['status'], 'ok')
        self.assertEqual(self.store.sources()['jobbank518'], 'ok')
        self.assertEqual(self.store.list(), [])

    def test_malformed_index_metadata_is_ignored_but_fails_a_detail(self):
        # 518's live index carried an ld+json with a raw control character (2026-10-25).
        bad = '<script type="application/ld+json">{"@type": "ItemList", "name": "a\x01b"}</script>'.encode()
        self.assertEqual(parse_index(index(URL) + bad), [URL])
        with self.assertRaises(ValueError): parse_article(detail() + bad, URL)

    def test_strict_urls_dedupe_and_external_ads_excluded(self):
        self.assertEqual(canonical(URL+'?tracking=x#apply'), URL)
        self.assertEqual(parse_index(index(URL, URL, 'https://www.tasker.com.tw/job-Ab1234.html')), [URL])
        for value in ('http://www.518.com.tw/job-Ab1234.html', 'https://www.518.com.tw.evil/job-Ab1234.html', '/job-index.html'):
            with self.assertRaises(ValueError): canonical(value)

    def test_array_metadata_dates_and_unknowns_preserved(self):
        job = parse_article(detail(), URL)
        self.assertTrue(job['software_category']); self.assertTrue(job['body_available'])
        self.assertTrue(job['published_at'].startswith('2026-01-01'))
        self.assertTrue(job['updated_at'].startswith('2026-09-26'))
        self.assertIsNone(job['taiwan_eligible']); self.assertIsNone(job['weekly_hours'])
        self.assertIsNone(job['budget_max'])  # hourly metadata must not become fixed budget
        self.assertEqual(job['salary_evidence']['value']['unitText'], 'HOUR')
        self.assertEqual(self.run_sync([job])['jobs'], 1)  # active old listings aren't dropped by original date

    def run_sync(self, jobs, **changes):
        result = dict(jobs=jobs, seen=len(jobs), details_read=len(jobs), rejected_count=0, truncated=False) | changes
        return sync(self.store, reader=lambda: result)

    def test_replay_preserves_human_draft_and_updates_fulltime_exclusion(self):
        job = parse_article(detail(), URL)
        self.run_sync([job]); item = self.store.list()[0]
        self.store.review(item['id'], 'edit', item['version'], text='Human draft')
        self.run_sync([job]); self.assertEqual(self.store.list()[0]['proposal'], 'Human draft')
        self.assertEqual(len(self.store.list()), 1)
        self.run_sync([parse_article(detail(employmentType=['FULL_TIME', 'PART_TIME']), URL)])
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'excluded')

    def test_unrelated_category_not_ingested_and_invalid_detail_rejected(self):
        self.assertEqual(self.run_sync([parse_article(detail(description='網站文案<br>職務類別<br>網站行銷企劃<br>職缺條件<br>兼職'), URL)])['jobs'], 0)
        for changes in ({'url': URL.replace('Ab1234','Ab1235')}, {'description':''}, {'employmentType':None}, {'datePosted':'bad'}):
            with self.subTest(changes=changes), self.assertRaises((ValueError, TypeError)):
                parse_article(detail(**changes), URL)

    def test_access_block_stops_remaining_requests(self):
        for blocked in (b'<title>Just a moment...</title>', 401, 403, 429):
            calls = []
            def reader(url):
                calls.append(url)
                if url == INDEX: return index(URL, URL.replace('Ab1234','Ab1235'))
                if isinstance(blocked, int): raise HTTPError(url, blocked, 'Blocked', {}, BytesIO())
                return blocked
            with self.subTest(blocked=blocked), self.assertRaises((ValueError, HTTPError)) as caught:
                fetch(read=reader, pause=lambda _: None)
            if isinstance(caught.exception, HTTPError): caught.exception.close()
            self.assertEqual(calls, [INDEX, URL])

    def test_bad_details_make_partial_health_and_whole_failure_is_failed(self):
        result = fetch(read=lambda url: index(URL, URL.replace('Ab1234','Ab1235')) if url == INDEX else
                       detail() if url == URL else b'<h1>Removed</h1>', pause=lambda _: None)
        self.assertEqual(result['rejected_count'], 1)
        self.assertFalse(result['complete_scan'])
        self.assertEqual(sync(self.store, reader=lambda: result)['status'], 'partial')
        self.assertEqual(self.store.sources()['jobbank518'], 'failed')
        self.assertEqual(len(self.store.list()), 1)
        def broken(): raise ValueError('Bad listing')
        self.assertEqual(sync(self.store, reader=broken)['status'], 'failed')
