from unittest import TestCase
from unittest.mock import Mock
from freelance.modules.collection.community_jobs import hn_job, v2ex_jobs, sync


class CommunityJobsTests(TestCase):
    def comment(self, text):
        return dict(id=123,type='comment',parent=10,time=1789746632,text=text)

    def test_hn_only_explicit_flexible_hiring(self):
        j=hn_job(self.comment('Acme | Remote | part-time backend engineer | Build AI agents'),10)
        self.assertEqual(j['kind'],'contract');self.assertIsNone(j['weekly_hours'])
        self.assertIsNone(j['taiwan_eligible'])
        for text in ('Acme | full-time backend', 'SEEKING WORK | part-time backend',
                     'Acme | backend | no contractors', 'Acme | full-time only | part-time not available'):
            self.assertIsNone(hn_job(self.comment(text),10))

    def test_hn_wrong_parent_or_dead_not_imported(self):
        p=self.comment('Acme | contract backend API')
        self.assertIsNone(hn_job(p,11))
        self.assertIsNone(hn_job(p|{'dead':True},10))

    def feed(self,title,body='Build an API',link='https://www.v2ex.com/t/123#reply1'):
        return f'''<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>{title}</title>
        <link rel="alternate" href="{link}"/><published>2026-09-18T12:00:00Z</published>
        <content>{body}</content></entry></feed>'''.encode()

    def test_v2ex_demand_not_freelancer_ad(self):
        jobs=v2ex_jobs(self.feed('寻找后端 API 开发，有项目需求'))
        self.assertEqual(len(jobs),1);self.assertEqual(jobs[0]['url'],'https://www.v2ex.com/t/123')
        self.assertEqual(v2ex_jobs(self.feed('承接后端 API 开发，有需求联系')),[])

    def test_empty_body_is_incomplete_lead_not_full_description(self):
        j=v2ex_jobs(self.feed('招聘兼职 API 开发',body=''))[0]
        self.assertFalse(j['complete']);self.assertFalse(j['body_available'])

    def test_xml_entities_and_wrong_host_rejected(self):
        for raw in (b'<!DOCTYPE x [<!ENTITY e "bad">]><feed/>',self.feed('找 API 开发',link='https://evil.example/t/123')):
            with self.assertRaises(ValueError):v2ex_jobs(raw)

    def test_failed_fetch_does_not_report_empty_success(self):
        store=Mock();reader=Mock(side_effect=ValueError())
        self.assertEqual(sync('v2ex',store,reader=reader)['status'],'failed')
        store.ingest.assert_not_called()

    def test_simplified_chinese_skills_match_same_categories(self):
        from freelance.modules.discovery.domain import qualify
        for text,category in [('智能代理开发','AI agent'),('自动化系统','AI 整合／自動化'),('后端开发','後端／API'),('全栈网站','全端 MVP')]:
            self.assertEqual(qualify({'title':text})['category'],category)

    def test_real_feed_self_profile_and_country_limits(self):
        self.assertIsNone(hn_job(self.comment('Location: London Remote: Yes Willing to relocate: No | contract backend'),10))
        for text in ('Acme | contract backend | USA only', 'Acme | part-time API | REMOTE (EU)',
                     'Acme | contract API | Poland or Romanian residents only'):
            self.assertFalse(hn_job(self.comment(text),10)['taiwan_eligible'])
