"""Public-feed contracts; no live network or application database."""
from datetime import datetime, timezone, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import importlib.util
import json

from freelance.bootstrap.store import SQLiteStore


def remote(**changes):
    return dict(id='123', position='Contract Backend API engineer', description='<p>Build API integrations.</p>',
                url='https://remoteOK.com/remote-jobs/remote-api-123', tags=['contract','backend'],
                date=datetime.now(timezone.utc).isoformat(), location='', salary_min=0, salary_max=0) | changes


def rss(title='Part-time Backend API developer', description='Build API integrations.', extra='', date=None):
    date=date or datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')
    return f'''<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Jobs</title><item>
<title><![CDATA[{title}]]></title><description><![CDATA[<p>{description}</p>]]></description>
<link>https://www.realworkfromanywhere.com/jobs/backend-123</link><guid>https://www.realworkfromanywhere.com/jobs/backend-123</guid><pubDate>{date}</pubDate>{extra}</item></channel></rss>'''.encode()


class PublicFeedsTests(TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('freelance.modules.collection.public_feeds'), 'public feed connector missing')
        import freelance.modules.collection.public_feeds as public_feeds
        self.feeds=public_feeds
        self.tmp=TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=SQLiteStore(Path(self.tmp.name)/'test.sqlite3');self.store.migrate()
        self.sources=patch('freelance.bootstrap.store.SOURCES', ('remoteok','realworkfromanywhere','weworkremotely','workingnomads'));self.sources.start();self.addCleanup(self.sources.stop)

    def run_feed(self, data, source='remoteok'):
        return self.feeds.sync(source,self.store,reader=lambda _: data)

    def test_remote_metadata_preserves_description_attribution_unknowns_and_actual_date(self):
        item=remote(date='2026-09-18T12:00:00+00:00',salary_min=50000,salary_max=80000)
        result=self.run_feed(json.dumps([{'legal':'Link to Remote OK'},item]).encode())
        self.assertEqual(result['status'],'ok');j=self.store.list()[0]['job']
        self.assertEqual(j['description'],'Build API integrations.')
        self.assertEqual(j['published_at'],'2026-09-18T12:00:00+00:00')
        self.assertEqual(j['attribution'],'Remote OK');self.assertEqual(j['kind'],'contract')
        for key in ('weekly_hours','taiwan_eligible','timezone_compatible','budget_max','budget_min','free_apply'):
            self.assertIsNone(j[key])
        self.assertEqual(j['salary_evidence']['min'],50000)
        self.assertIsNone(j['salary_evidence']['period'])

    def test_rss_repairs_only_attribute_ampersands_and_keeps_full_text(self):
        result=self.run_feed(rss(description='R&D API &amp; automation',extra='<enclosure url="https://example.org/logo?s=200&v=4" />'),'realworkfromanywhere')
        self.assertEqual(result['status'],'ok');j=self.store.list()[0]['job']
        self.assertEqual(j['description'],'R&D API & automation');self.assertEqual(j['attribution'],'Real Work From Anywhere')

    def test_weworkremotely_official_rss_attribution_region_and_contract_filter(self):
        data=rss(title='Contract AI agent engineer',description='Build an AI agent and API.',
                 extra='<region>Anywhere in the World</region><category>Programming</category>')
        data=data.replace(b'https://www.realworkfromanywhere.com/jobs/backend-123',
                          b'https://weworkremotely.com/remote-jobs/company-ai-agent-123')
        result=self.run_feed(data,'weworkremotely')
        self.assertEqual(result['jobs'],1)
        job=self.store.list()[0]['job']
        self.assertEqual(job['attribution'],'We Work Remotely')
        self.assertEqual(job['location_evidence'],'Anywhere in the World')
        self.assertIsNone(job['free_apply'])
        self.assertEqual(job['kind'],'contract')

    def test_workingnomads_official_json_preserves_location_and_rejects_redirect_host(self):
        entry=dict(url='https://www.workingnomads.com/job/go/123/',title='Contract AI agent engineer',
                   description='<p>Build an AI agent and API.</p>',pub_date=datetime.now(timezone.utc).isoformat(),
                   tags='python,agent',location='Anywhere',category_name='Development')
        result=self.run_feed(json.dumps([entry]).encode(),'workingnomads')
        self.assertEqual(result['jobs'],1)
        job=self.store.list()[0]['job']
        self.assertEqual(job['attribution'],'Working Nomads')
        self.assertEqual(job['location_evidence'],'Anywhere')
        self.assertEqual(job['kind'],'contract')
        self.assertIsNone(job['taiwan_eligible'])
        invalid=entry | {'url':'https://evil.example/job/go/124/'}
        self.assertEqual(self.run_feed(json.dumps([invalid]).encode(),'workingnomads')['status'],'partial')

    def test_fulltime_wins_over_contract_and_unknown_work_type_not_imported(self):
        self.run_feed(json.dumps([remote(position='Full-time Contract API',id='1'),remote(position='API engineer',tags=['backend'],id='2')]).encode())
        self.assertEqual(self.store.list(),[])

    def test_existing_fulltime_and_closed_are_updated_out_of_candidates(self):
        original=remote();self.run_feed(json.dumps([original]).encode())
        for update in (dict(position='Full-time API engineer'),dict(closed=True)):
            self.run_feed(json.dumps([original|update]).encode())
            self.assertEqual(self.store.list()[0]['evaluation']['status'],'excluded')

    def test_replay_preserves_manual_proposal_tracking_and_revision(self):
        data=json.dumps([remote()]).encode();self.run_feed(data);item=self.store.list()[0]
        self.store.review(item['id'],'edit',item['version'],text='Human proposal')
        self.store.track(item['id'],0,feedback='interested',note='Keep this')
        self.run_feed(data);item=self.store.list()[0]
        self.assertEqual(item['proposal'],'Human proposal');self.assertEqual(item['version'],2)
        self.assertEqual(item['tracking']['note'],'Keep this')

    def test_malformed_and_empty_sources_fail_without_partial_writes(self):
        for data in (b'',b'{}',b'[]',b'[{"id": 1},'):
            self.assertEqual(self.run_feed(data)['status'],'failed');self.assertEqual(self.store.list(),[])
        self.assertEqual(self.store.sources()['remoteok'],'failed')

    def test_xml_rejects_dtd_entities_and_arbitrary_recovery(self):
        for data in (rss().replace(b'<rss',b'<!DOCTYPE rss [<!ENTITY x "boom">]><rss',1),rss().replace(b'</item>',b'</wrong>'),rss().replace(b'<pubDate>',b'<pubDate>&undefined;')):
            self.assertEqual(self.run_feed(data,'realworkfromanywhere')['status'],'failed')
        self.assertEqual(self.store.list(),[])

    def test_old_items_and_truncation_bounded(self):
        old=(datetime.now(timezone.utc)-timedelta(days=91)).isoformat()
        self.run_feed(json.dumps([remote(date=old)]).encode());self.assertEqual(self.store.list(),[])
        result=self.run_feed(json.dumps([remote(id=str(i)) for i in range(205)]).encode())
        self.assertEqual(result['seen'],200);self.assertEqual(len(self.store.list()),200);self.assertTrue(result['truncated'])

    def test_oversize_and_wrong_canonical_host_fail(self):
        self.assertEqual(self.run_feed(b' ' * 8000001)['status'],'failed')
        self.assertEqual(self.run_feed(json.dumps([remote(url='https://evil.example/jobs/123')]).encode())['status'],'partial')

    def test_ingest_failure_rolls_back_entire_batch(self):
        original=self.store.collection.ingest
        def fail_second(job,*args,**kwargs):
            if job['external_id']=='2':raise ValueError('synthetic failure')
            return original(job,*args,**kwargs)
        with patch.object(self.store.collection,'ingest',side_effect=fail_second):
            self.assertEqual(self.run_feed(json.dumps([remote(id='1'),remote(id='2')]).encode())['status'],'failed')
        self.assertEqual(self.store.list(),[])

    def test_explicit_body_contract_evidence_without_smart_contract_false_positive(self):
        data=rss(title='Backend API engineer',description='This position is offered on a contractor basis. Build API integrations.')
        self.assertEqual(self.run_feed(data,'realworkfromanywhere')['jobs'],1)
        self.assertEqual(self.store.list()[0]['job']['kind'],'contract')
        other=json.dumps([remote(position='Smart Contract API engineer',tags=['blockchain'],description='Build smart contracts and API integrations.')]).encode()
        self.assertEqual(self.run_feed(other)['jobs'],0)

    def test_fetch_enforces_size_and_total_deadline(self):
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read1(self,n):return b'x'*n
        from types import SimpleNamespace
        response=Response();response.fp=SimpleNamespace(raw=SimpleNamespace(_sock=SimpleNamespace(settimeout=lambda _:None)))
        opener=SimpleNamespace(open=lambda *a,**k:response)
        with patch.object(self.feeds,'build_opener',return_value=opener):
            with self.assertRaises(ValueError):self.feeds.fetch('remoteok')
            with patch.object(self.feeds.time,'monotonic',side_effect=[0,26]):
                with self.assertRaises(TimeoutError):self.feeds.fetch('remoteok')


    def test_partial_bad_canonical_is_visible_and_valid_replay_preserves_manual_work(self):
        data=json.dumps([remote(),remote(id='2',url='https://remoteok.com/remote-jobs/')]).encode()
        result=self.run_feed(data)
        self.assertEqual(result['status'],'partial');self.assertEqual(result['rejected_count'],1)
        self.assertEqual(result['seen'],2);self.assertEqual(result['jobs'],1)
        self.assertEqual(self.store.sources()['remoteok'],'failed')
        item=self.store.list()[0]
        self.store.review(item['id'],'edit',item['version'],text='Human partial proposal')
        self.run_feed(data)
        self.assertEqual(len(self.store.list()),1)
        self.assertEqual(self.store.list()[0]['proposal'],'Human partial proposal')
        self.assertEqual(self.store.list()[0]['version'],2)
        with self.assertRaises(ValueError):self.feeds.parse('remoteok',data)

    def test_partial_parser_keeps_envelope_errors_and_unexpected_errors_fatal(self):
        self.assertTrue(hasattr(self.feeds,'parse_batch'))
        for data in (b'{}',b'[]',b'[{}'):
            with self.assertRaises(ValueError):self.feeds.parse_batch('remoteok',data)
        with patch.object(self.feeds,'normalize',side_effect=RuntimeError('bug')):
            with self.assertRaises(RuntimeError):self.feeds.parse_batch('remoteok',json.dumps([remote()]).encode())

    def test_fetch_stops_after_response_closes_at_eof(self):
        from types import SimpleNamespace
        class Response:
            status=200
            def __init__(self):self.fp=SimpleNamespace(raw=SimpleNamespace(_sock=self))
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def settimeout(self,value):
                if self.fp is None:raise OSError('socket closed')
            def read1(self,n):
                if self.fp is None:raise OSError('read after EOF')
                self.fp=None
                return b'[]'
        with patch.object(self.feeds,'build_opener',return_value=SimpleNamespace(open=lambda *a,**k:Response())):
            self.assertEqual(self.feeds.fetch('remoteok'),b'[]')
