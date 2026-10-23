import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from freelance.modules.collection.justremote import parse_index, parse_article, sync, canonical
from freelance.bootstrap.store import SQLiteStore


def entry(**changes):
    return dict(id=42, title='AI agent API engineer', job_type='contract', category='developer',
                is_active=True, location_restrictions=[], href='remote-developer-jobs/ai-agent-acme',
                url='https://justremote.co/remote-developer-jobs/ai-agent-acme') | changes


def detail(**changes):
    data = {'@type': 'JobPosting', 'title': 'AI agent API engineer', 'description': '<p>Build an AI agent API</p>',
            'employmentType': 'CONTRACTOR', 'datePosted': datetime.now(timezone.utc).isoformat(),
            'jobLocationType': 'TELECOMMUTE'} | changes
    return ('<script type="application/ld+json">' + json.dumps(data) + '</script>').encode()


class JustRemoteTests(TestCase):
    def setUp(self):
        temp = TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.store = SQLiteStore(Path(temp.name)/'test.sqlite3'); self.store.migrate()

    def test_public_state_is_json_not_executable_and_bad_entry_isolated(self):
        data = {'jobsState': {'entity': {'all': [entry(), entry(id=43, href='https://evil.example/x')]}, 'meta': {'status': 'success'}}}
        raw = ('<script>window.__PRELOADED_STATE__ = ' + json.dumps(data) + ';</script>').encode()
        entries, rejected = parse_index(raw)
        self.assertEqual(len(entries), 1); self.assertEqual(rejected, 1)
        with self.assertRaises(ValueError): parse_index(raw.replace(b';</script>', b';alert(1)</script>'))
        with self.assertRaises(ValueError): parse_index(b'<h1>No jobs</h1>')
        with self.assertRaises(ValueError): canonical('https://justremote.co.evil.example/remote-developer-jobs/a-b')

    def test_region_unknowns_and_fulltime_detail_take_precedence(self):
        job = parse_article(detail(), entry(location_restrictions=['United States']))
        self.assertFalse(job['taiwan_eligible'])
        unknown = parse_article(detail(), entry())
        self.assertIsNone(unknown['taiwan_eligible']); self.assertIsNone(unknown['weekly_hours'])
        self.assertIsNone(unknown['budget_min'])
        self.assertEqual(parse_article(detail(employmentType='FULL_TIME'), entry())['kind'], 'full_time')
        with self.assertRaises(ValueError): parse_article(detail(title='Different job'), entry())

    def test_replay_preserves_draft_and_partial_health(self):
        job = parse_article(detail(), entry())
        result = dict(jobs=[job], seen=1, rejected_count=0, complete_scan=False, listing_metadata=[entry()])
        self.assertEqual(sync(self.store, reader=lambda: result)['jobs'], 1)
        item=self.store.list()[0];self.store.review(item['id'],'edit',item['version'],text='Human draft')
        result['rejected_count']=1
        self.assertEqual(sync(self.store,reader=lambda:result)['status'],'partial')
        self.assertEqual(len(self.store.list()),1);self.assertEqual(self.store.list()[0]['proposal'],'Human draft')
        self.assertEqual(self.store.sources()['justremote'],'failed')

    def test_us_only_fulltime_and_inactive_do_not_become_candidates(self):
        for data, e in ((detail(), entry(location_restrictions=['United States'])),
                        (detail(employmentType='FULL_TIME'), entry()),
                        (detail(), entry(is_active=False))):
            job=parse_article(data,e)
            self.assertEqual(sync(self.store,reader=lambda:dict(jobs=[job],seen=1,rejected_count=0))['jobs'],0)
