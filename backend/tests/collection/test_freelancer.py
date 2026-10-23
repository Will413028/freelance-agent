import io,json
from unittest import TestCase
from unittest.mock import Mock
from freelance.modules.collection.freelancer import normalize, search, sync

def project(**extra):return dict(id=42,title='AI agent backend',description='Build an API',status='active',type='fixed',budget={'minimum':100,'maximum':500},currency={'code':'USD'},time_updated=1789742168,language='en',seo_url='python/AI-agent',deleted=False,nonpublic=False)|extra
class FreelancerTests(TestCase):
    def test_unknowns_and_currency_preserved(self):
        job=normalize(project());self.assertEqual(job['currency'],'USD');self.assertIsNone(job['taiwan_eligible']);self.assertIsNone(job['weekly_hours']);self.assertEqual(job['kind'],'fixed');self.assertEqual(job['url'],'https://www.freelancer.com/projects/python/AI-agent')
    def test_no_guess_description_or_timestamp(self):
        for patch in ({'description':None},{'time_updated':None},{'budget':{'maximum':float('nan')}},{'nonpublic':True},{'status':'closed'},{'seo_url':'//evil.com'}):
            with self.assertRaises(ValueError):normalize(project(**patch))
    def test_fixed_get_bounded_and_no_credentials(self):
        response=io.BytesIO(json.dumps({'status':'success','result':{'projects':[project()],'total_count':100}}).encode());response.status=200
        opener=Mock();opener.open.return_value=response
        result=search('AI agent',limit=5,opener=opener,max_pages=1)
        self.assertEqual(len(result['jobs']),1);self.assertTrue(result['limited'])
        request=opener.open.call_args.args[0];self.assertEqual(request.method,'GET');self.assertIsNone(request.get_header('Authorization'));self.assertIn('full_description=true',request.full_url)
    def test_partial_search_failure_no_ingest(self):
        client=Mock(side_effect=[{'jobs':[normalize(project())],'limited':False},ValueError()]);store=Mock()
        self.assertEqual(sync(store,searcher=client)['status'],'failed');store.ingest.assert_not_called()
    def test_duplicate_queries_ingest_once(self):
        client=Mock(return_value={'jobs':[normalize(project())],'limited':True});store=Mock()
        self.assertEqual(sync(store,searcher=client)['jobs'],1);store.ingest.assert_called_once()
    def test_irrelevant_project_is_not_ingested(self):
        irrelevant=normalize(project(id=43,title='Logo design',description='Draw a logo',seo_url='design/logo'))
        client=Mock(return_value={'jobs':[irrelevant],'limited':False});store=Mock()
        self.assertEqual(sync(store,searcher=client)['jobs'],0);store.ingest.assert_not_called()
    def test_description_keyword_does_not_make_copywriting_a_development_job(self):
        copywriting=normalize(project(id=44,title='Website Home Page Copywriting',
                                      description='Write copy for a website with API links',seo_url='copy/site'))
        client=Mock(return_value={'jobs':[copywriting],'limited':False});store=Mock()
        self.assertEqual(sync(store,searcher=client)['jobs'],0);store.ingest.assert_not_called()

class FreelancerPaginationTests(TestCase):
    def response(self,ids,total):
        response=io.BytesIO(json.dumps({'status':'success','result':{
            'projects':[project(id=i) for i in ids],'total_count':total}}).encode())
        response.status=200
        return response

    def test_follows_offset_until_all_query_results_are_read(self):
        from urllib.parse import urlparse,parse_qs
        opener=Mock();opener.open.side_effect=[self.response([1,2],3),self.response([3],3)]
        result=search('AI agent',limit=2,opener=opener,pause=lambda _:None)
        self.assertEqual([j['external_id'] for j in result['jobs']],['1','2','3'])
        self.assertFalse(result['limited']);self.assertEqual(result['pages'],2)
        self.assertEqual([parse_qs(urlparse(c.args[0].full_url).query)['offset']
                          for c in opener.open.call_args_list],[['0'],['2']])

    def test_short_intermediate_page_uses_requested_offset_and_continues(self):
        from urllib.parse import urlparse, parse_qs
        opener = Mock()
        opener.open.side_effect = [self.response([1, 2], 5), self.response([3, 4, 5], 5)]
        result = search('AI agent', limit=3, opener=opener, pause=lambda _: None)
        self.assertEqual([job['external_id'] for job in result['jobs']], ['1', '2', '3', '4', '5'])
        self.assertFalse(result['limited'])
        self.assertEqual([parse_qs(urlparse(call.args[0].full_url).query)['offset']
                          for call in opener.open.call_args_list], [['0'], ['3']])

    def test_daily_search_requests_verified_page_size(self):
        store = Mock()
        searcher = Mock(return_value={'jobs': [], 'limited': True})
        sync(store, searcher=searcher, pause=lambda _: None)
        self.assertEqual([call.kwargs['limit'] for call in searcher.call_args_list], [100] * 3)

    def test_overlap_deduplicates_but_does_not_claim_missing_coverage(self):
        opener=Mock();opener.open.side_effect=[self.response([1,2],4),self.response([2,3],4)]
        result=search('AI agent',limit=2,opener=opener,pause=lambda _:None)
        self.assertEqual(len(result['jobs']),3);self.assertTrue(result['limited'])

    def test_repeated_page_stops_without_exhausting_request_budget(self):
        opener=Mock();opener.open.side_effect=[self.response([1,2],100),self.response([1,2],100)]
        result=search('AI agent',limit=2,opener=opener,pause=lambda _:None)
        self.assertTrue(result['limited']);self.assertEqual(opener.open.call_count,2)

    def test_page_cap_and_short_page_are_not_success(self):
        for ids,limit in (([1,2],2),([1],2)):
            opener=Mock();opener.open.return_value=self.response(ids,100)
            result=search('AI agent',limit=limit,opener=opener,max_pages=1)
            self.assertTrue(result['limited']);self.assertEqual(opener.open.call_count,1)

    def test_deadline_stops_before_next_request(self):
        opener=Mock();opener.open.return_value=self.response([1,2],100)
        result=search('AI agent',limit=2,opener=opener,max_seconds=1,
                      monotonic=Mock(side_effect=[0,0,1]),pause=Mock())
        self.assertTrue(result['limited']);self.assertEqual(opener.open.call_count,1)
        self.assertEqual(opener.open.call_args.kwargs['timeout'],1)

    def test_later_http_failure_has_no_retry_or_partial_success(self):
        from urllib.error import HTTPError
        opener=Mock();opener.open.side_effect=[self.response([1,2],100),
            HTTPError('https://www.freelancer.com/',429,'rate limit',{},None)]
        with self.assertRaisesRegex(ValueError,'unavailable'):
            search('AI agent',limit=2,opener=opener,pause=lambda _:None)
        self.assertEqual(opener.open.call_count,2)

    def test_incomplete_scan_health_is_failed_even_with_useful_jobs(self):
        store=Mock();client=Mock(return_value={'jobs':[normalize(project())],'limited':True})
        result=sync(store,searcher=client,pause=lambda _:None)
        self.assertEqual(result['status'],'partial');store.ingest.assert_called_once()
        self.assertEqual(store.set_source_health.call_args.args,('freelancer','failed'))

    def test_invalid_row_is_counted_without_discarding_valid_projects(self):
        response=io.BytesIO(json.dumps({'status':'success','result':{
            'projects':[project(id=1),project(id=2,seo_url='malformed')],
            'total_count':2}}).encode());response.status=200
        opener=Mock();opener.open.return_value=response
        result=search('AI agent',limit=2,opener=opener)
        self.assertEqual([j['external_id'] for j in result['jobs']],['1'])
        self.assertEqual(result['rejected_count'],1);self.assertTrue(result['limited'])
        store=Mock()
        sync_result=sync(store,searcher=lambda *a,**k:result,pause=lambda _:None)
        self.assertEqual(sync_result['status'],'partial');store.ingest.assert_called_once()
