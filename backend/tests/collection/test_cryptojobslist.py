from datetime import datetime, timezone, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from freelance.modules.collection.cryptojobslist import parse, sync
from freelance.bootstrap.store import SQLiteStore

URL='https://cryptojobslist.com/jobs/ai-agent-api-acme'

def item(tags=('freelance','remote'),location='Remote',url=URL):
    links=' '.join('<a href="https://cryptojobslist.com/'+t+'">'+t+'</a>' for t in tags)
    return ('<item><title>AI agent API developer</title><link>'+url+'</link><description><![CDATA[<p>Tags: '+links+'</p><p>Build an AI agent and API.</p>]]></description><media:location>'+location+'</media:location></item>')

def feed(items=None):
    return ('<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><lastBuildDate>Sat, 26 Sep 2026 01:00:00 GMT</lastBuildDate>'+ (items if items is not None else item())+'</channel></rss>').encode()

class CryptoJobsListTests(TestCase):
    def setUp(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.store=SQLiteStore(Path(tmp.name)/'jobs.sqlite3');self.store.migrate()
    def test_missing_job_date_is_not_filled_from_feed_build_or_observation(self):
        a=parse(feed(),now=datetime(2026,9,26,tzinfo=timezone.utc))['jobs'][0]
        b=parse(feed(),now=datetime(2026,9,27,tzinfo=timezone.utc))['jobs'][0]
        self.assertIsNone(a['published_at']);self.assertNotEqual(a['received_at'],b['received_at'])
        self.assertEqual(a['receipt_id'],b['receipt_id']);self.assertIsNone(a['weekly_hours']);self.assertIsNone(a['budget_max'])
    def test_smart_contract_tag_is_not_freelance_and_fulltime_wins(self):
        self.assertIsNone(parse(feed(item(tags=('contract','smart-contract','remote'))))['jobs'][0]['kind'])
        self.assertEqual(parse(feed(item(tags=('freelance','full-time','remote'))))['jobs'][0]['kind'],'full_time')
        self.assertFalse(parse(feed(item(location='Remote United States')))['jobs'][0]['taiwan_eligible'])
        unknown=parse(feed(item(location='')))['jobs'][0]
        self.assertIsNone(unknown['location_evidence']);self.assertIsNone(unknown['taiwan_eligible'])
        self.assertTrue(unknown['remote_evidence'])
        raw=feed().replace(b'Tags:',b'Our partners:')
        self.assertIsNone(parse(raw)['jobs'][0]['kind'])
    def test_bad_url_isolated_and_xml_declarations_rejected(self):
        r=parse(feed(item()+item(url='https://evil.example/jobs/ai-agent')))
        self.assertEqual(r['seen'],2);self.assertEqual(r['rejected_count'],1)
        with self.assertRaises(ValueError):parse(b'<!DOCTYPE rss>'+feed())
        with self.assertRaises(ValueError):parse(feed(''))
    def test_replay_after_new_observation_preserves_manual_draft_and_partial_health(self):
        now=datetime.now(timezone.utc);a=parse(feed(),now=now)
        self.assertEqual(sync(self.store,reader=lambda:a)['jobs'],1)
        obj=self.store.list()[0];self.store.review(obj['id'],'edit',obj['version'],text='Human proposal')
        b=parse(feed(),now=now+timedelta(days=1));b['rejected_count']=1
        self.assertEqual(sync(self.store,reader=lambda:b)['status'],'partial')
        self.assertEqual(len(self.store.list()),1);self.assertEqual(self.store.list()[0]['proposal'],'Human proposal')
        self.assertEqual(self.store.sources()['cryptojobslist'],'failed')
