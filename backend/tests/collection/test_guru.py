import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from freelance.modules.collection.guru import parse_index, parse_article, canonical, sync, ROOT, INDEX, SourceBlocked, fetch
from unittest.mock import Mock, patch
from freelance.bootstrap.store import SQLiteStore

URL=ROOT+'/jobs/ai-agent-api/42'

def detail(*,quote=True,budget='Fixed Price | Under $250',**changes):
    data={'@type':'JobPosting','Identifier':{'Value':'42'},'title':'AI agent API development',
          'description':'Build an AI agent backend API','datePosted':datetime.now(timezone.utc).isoformat(),
          'validThrough':(datetime.now(timezone.utc)+timedelta(days=10)).isoformat(),
          'employmentType':'CONTRACTOR','applicantLocationRequirements':{'name':['Not Available']},
          'jobLocationType':'TELECOMMUTE',
          'baseSalary':{'currency':'USD','Value':{'value':'250','unitText':'YEAR'}}}|changes
    html='<script type="application/ld+json">'+json.dumps(data)+'</script><div class="jobHeading__budget">'+budget+'</div>'
    if quote:html+='<a title="Send a Quote" href="/login.aspx?ReturnUrl=work/detail/42?apply=true">Quote</a>'
    return html.encode()

class GuruTests(TestCase):
    def setUp(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.store=SQLiteStore(Path(tmp.name)/'jobs.sqlite3');self.store.migrate()
    def test_pagination_deduplicates_links_and_strips_only_observed_tracking(self):
        raw=b'<a href="/jobs/ai-agent-api/42&SearchUrl=search.aspx?">Job</a><a href="/jobs/ai-agent-api/42">Job</a><a href="/d/jobs/c/programming-development/pg/3/">3</a><a href="/d/jobs/c/programming-development/pg/2/">Next</a>'
        entries,next_url,bad=parse_index(raw,1)
        self.assertEqual(entries,[{'url':URL}]);self.assertEqual(next_url,INDEX+'pg/2/');self.assertEqual(bad,0)
        with self.assertRaises(ValueError):canonical('https://evil.example/jobs/ai-agent-api/42')
        with self.assertRaises(ValueError):parse_index(b'<h1>Sign in</h1>',1)
    def test_annual_schema_is_not_used_as_fixed_budget(self):
        job=parse_article(detail(),{'url':URL})
        self.assertEqual(job['kind'],'fixed');self.assertEqual(job['budget_evidence'],'Fixed Price | Under $250')
        self.assertIsNone(job['budget_max']);self.assertIsNone(job['weekly_hours']);self.assertIsNone(job['taiwan_eligible'])
        self.assertEqual(parse_article(detail(budget='Hourly | $25-$50'),{'url':URL})['kind'],'hourly')
    def test_location_deadline_identity_and_quote_gate(self):
        job=parse_article(detail(applicantLocationRequirements={'name':['India','Pakistan']}),{'url':URL})
        self.assertFalse(job['taiwan_eligible'])
        with self.assertRaises(ValueError):parse_article(detail(Identifier={'Value':'99'}),{'url':URL})
        for raw in (detail(quote=False),detail(validThrough='2020-01-01T00:00:00Z'),detail(applicantLocationRequirements={'name':['India']})):
            job=parse_article(raw,{'url':URL})
            self.assertEqual(sync(self.store,reader=lambda:dict(jobs=[job],seen=1,rejected_count=0,truncated=False))['jobs'],0)
        self.assertIsNone(parse_article(detail(quote=False),{'url':URL})['listing_closed'])
    def test_replay_keeps_manual_work_and_truncation_is_partial(self):
        job=parse_article(detail(),{'url':URL});r=dict(jobs=[job],seen=1,rejected_count=0,truncated=False)
        self.assertEqual(sync(self.store,reader=lambda:r)['jobs'],1)
        item=self.store.list()[0];self.store.review(item['id'],'edit',item['version'],text='My draft')
        r['truncated']=True
        self.assertEqual(sync(self.store,reader=lambda:r)['status'],'partial')
        self.assertEqual(len(self.store.list()),1);self.assertEqual(self.store.list()[0]['proposal'],'My draft')
        self.assertEqual(self.store.sources()['guru'],'failed')

    def test_challenge_stops_detail_reads_without_bypass_or_retry(self):
        raw=b'<a href="/jobs/ai-agent-api/42">Job</a><a href="/jobs/ai-agent-api/43">Other</a>'
        challenge=b'<html><script src="/_Incapsula_Resource?x"></script></html>'
        with self.assertRaises(SourceBlocked):parse_article(challenge,{'url':URL})
        response=Mock(status=200);response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        opener=Mock();opener.open.return_value=response
        with patch('freelance.modules.collection.guru.build_opener',return_value=opener),patch('freelance.modules.collection.guru.read_body',side_effect=[raw,challenge]),patch('freelance.modules.collection.guru.time.sleep'):
            result=fetch()
        self.assertTrue(result['access_blocked']);self.assertEqual(result['unread_count'],2)
        self.assertEqual(opener.open.call_count,2)
        self.assertEqual(sync(self.store,reader=lambda:result)['status'],'partial')

    def test_http_access_denial_stops_without_fetching_the_next_job(self):
        from urllib.error import HTTPError
        raw=b'<a href="/jobs/ai-agent-api/42">Job</a><a href="/jobs/ai-agent-api/43">Other</a>'
        response=Mock(status=200);response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        opener=Mock();opener.open.side_effect=[response,HTTPError(URL,403,'Forbidden',{},None)]
        with patch('freelance.modules.collection.guru.build_opener',return_value=opener),patch('freelance.modules.collection.guru.read_body',return_value=raw),patch('freelance.modules.collection.guru.time.sleep'):
            result=fetch()
        self.assertTrue(result['access_blocked']);self.assertEqual(result['unread_count'],2)
        self.assertEqual(opener.open.call_count,2)
