from unittest import TestCase
from unittest.mock import Mock
from freelance.modules.collection.free_jobs import normalize, sync

def rem(**changes):return dict(id=1,url='https://remotive.com/remote-jobs/software-dev/backend-1',title='Backend API engineer',description='<p>Build an API</p>',job_type='part_time',publication_date='2026-09-18T12:00:00',candidate_required_location='Worldwide')|changes
class FreeJobsTests(TestCase):
    def test_part_time_unknown_hours_and_geo_not_assumed(self):
        j=normalize('remotive',rem());self.assertEqual(j['kind'],'contract');self.assertIsNone(j['weekly_hours']);self.assertIsNone(j['taiwan_eligible']);self.assertEqual(j['description'],'Build an API')
    def test_fulltime_and_known_country_excluded(self):
        from freelance.modules.discovery.domain import qualify
        self.assertEqual(qualify(normalize('remotive',rem(job_type='full_time')))['status'],'excluded')
        self.assertFalse(normalize('remotive',rem(candidate_required_location='USA'))['taiwan_eligible'])
    def test_jobicy_salary_not_total_project_price(self):
        j=normalize('jobicy',dict(id=2,url='https://jobicy.com/jobs/2-python',jobTitle='Python API',jobDescription='<p>API</p>',jobType=['contract'],jobGeo='Anywhere',pubDate='2026-09-18T12:00:00+00:00',salaryMin=100000,salaryPeriod='yearly'))
        self.assertIsNone(j['budget_min']);self.assertEqual(j['kind'],'contract')
    def test_url_and_full_description_required(self):
        for c in ({'url':'https://evil.example/'},{'description':None}):
            with self.assertRaises(ValueError):normalize('remotive',rem(**c))
    def test_only_matching_non_fulltime_imported(self):
        store=Mock();reader=Mock(return_value={'jobs':[rem(),rem(id=2,job_type='full_time'),rem(id=3,title='Accountant',description='Bookkeeping')]})
        result=sync('remotive',store,reader=reader)
        self.assertEqual(result['jobs'],1);store.ingest.assert_called_once()
    def test_malformed_batch_not_empty_success(self):
        store=Mock();result=sync('remotive',store,reader=Mock(return_value={'jobs':[rem(description=None)]}))
        self.assertEqual(result['status'],'failed');store.ingest.assert_not_called()
