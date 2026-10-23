from datetime import datetime, timezone, timedelta
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from urllib.error import HTTPError
from freelance.modules.collection.chickpt import INDEX, canonical, parse_index, parse_article, fetch, sync
from freelance.bootstrap.store import SQLiteStore

URL = 'https://www.chickpt.com.tw/job-Ab1234567890'


def index(*urls, total=None):
    return ('<h1><span>電腦</span>接案任務</h1><span id="job-count">'+str(len(urls) if total is None else total)+
            '</span><ul id="job-list">'+''.join(f'<li><a href="{u}">task</a></li>' for u in urls)+'</ul>').encode()


def detail(salary='單次$5000', body='Build an AI agent API', url=URL):
    return (f'<meta property="og:url" content="{url}"><h1 id="job-h1-title">AI agent 開發</h1>'
            f'<div class="job_salary_address-block"><h2>{salary}</h2><h2>在家兼職</h2></div>'
            f'<section class="job-content"><p>任務內容</p><ul><li>{body}</li></ul></section>'
            '<section class="job-work_time">工作日期：2026/09/20~2026/10/20</section>'
            '<section class="similar"><p>無薪 FULL_TIME unrelated advertisement</p></section>').encode()


class ChickptTests(TestCase):
    def setUp(self):
        temp=TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.store=SQLiteStore(Path(temp.name)/'test.sqlite3');self.store.migrate()

    def test_index_count_category_and_only_listing_links(self):
        self.assertEqual(parse_index(index()),([],0))
        self.assertEqual(parse_index(index(URL)+f'<a href="{URL}extra">similar</a>'.encode()),([URL],1))
        for raw in (index(total=1),index(URL,total=0),index(URL).replace('電腦'.encode(),'其他'.encode()),b'<h1>Unavailable</h1>'):
            with self.assertRaises(ValueError):parse_index(raw)
        for url in ('https://evil.example/job-Ab1234567890','/ajax/jobs','http://www.chickpt.com.tw/job-Ab1234567890'):
            with self.assertRaises(ValueError):canonical(url)

    def test_full_body_not_similar_tasks_and_unknown_dates_preserved(self):
        job=parse_article(detail(),URL)
        self.assertEqual(job['description'],'Build an AI agent API')
        self.assertEqual((job['budget_min'],job['budget_max']),(5000,5000))
        self.assertIsNone(job['published_at']);self.assertIsNone(job['deadline'])
        self.assertIsNone(job['weekly_hours']);self.assertIsNone(job['taiwan_eligible'])
        self.assertIn('2026/10/20',job['work_time_evidence'])

    def test_hourly_range_and_bad_budget(self):
        job=parse_article(detail(salary='時薪$500'),URL)
        self.assertEqual(job['kind'],'hourly');self.assertIsNone(job['budget_max'])
        job=parse_article(detail(salary='單次$3,000 ~ $5,000'),URL)
        self.assertEqual((job['budget_min'],job['budget_max']),(3000,5000))
        with self.assertRaises(ValueError):parse_article(detail(salary='單次$0'),URL)
        with self.assertRaises(ValueError):parse_article(detail(url=URL.replace('Ab','Ac')),URL)
        with self.assertRaises(ValueError):parse_article(detail(body=''),URL)

    def run_sync(self,jobs,**changes):
        return sync(self.store,reader=lambda:dict(jobs=jobs,seen=len(jobs),rejected_count=0,truncated=False)|changes)

    def test_replay_new_observation_preserves_human_draft_and_budget_update(self):
        now=datetime.now(timezone.utc)
        first=parse_article(detail(),URL,observed_at=now)
        again=parse_article(detail(),URL,observed_at=now+timedelta(days=1))
        self.assertEqual(first['receipt_id'],again['receipt_id'])
        self.run_sync([first]);item=self.store.list()[0]
        self.store.review(item['id'],'edit',item['version'],text='Human proposal')
        self.run_sync([again]);self.assertEqual(len(self.store.list()),1)
        self.assertEqual(self.store.list()[0]['proposal'],'Human proposal')
        self.run_sync([parse_article(detail(salary='單次$2000'),URL)])
        self.assertEqual(self.store.list()[0]['evaluation']['status'],'excluded')

    def test_below_personal_floor_retained_for_future_preference_changes(self):
        self.assertEqual(self.run_sync([parse_article(detail(salary='單次$2000'),URL)])['jobs'],1)
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'excluded')
        current = self.store.preferences()
        self.store.set_preferences(current['revision'], current['settings'] | {'min_fixed_twd': 0})
        self.assertNotEqual(self.store.list()[0]['evaluation']['status'], 'excluded')

    def test_access_block_stops_read_and_partial_is_visible(self):
        for blocked in (401,403,429,b'<title>Just a moment</title>'):
            calls=[]
            def read(url):
                calls.append(url)
                if url==INDEX:return index(URL,URL.replace('Ab','Ac'))
                if isinstance(blocked,int):raise HTTPError(url,blocked,'blocked',{},BytesIO())
                return blocked
            with self.assertRaises((ValueError,HTTPError)) as caught:fetch(read=read,pause=lambda _:None)
            if isinstance(caught.exception,HTTPError):caught.exception.close()
            self.assertEqual(calls,[INDEX,URL])
        result=fetch(read=lambda u:index(URL,total=2) if u==INDEX else detail(),pause=lambda _:None)
        self.assertTrue(result['truncated'])
        self.assertEqual(sync(self.store,reader=lambda:result)['status'],'partial')
        self.assertEqual(self.store.sources()['chickpt'],'failed')

    def test_broken_body_partial_and_empty_scan_ok(self):
        result=fetch(read=lambda u:index(URL) if u==INDEX else b'<h1>Missing</h1>',pause=lambda _:None)
        self.assertEqual(result['rejected_count'],1)
        self.assertEqual(sync(self.store,reader=lambda:result)['status'],'partial')
        result=fetch(read=lambda _:index(),pause=lambda _:None)
        self.assertEqual(sync(self.store,reader=lambda:result)['status'],'ok')
