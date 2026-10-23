from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
import freelance.modules.collection.taiwanjobs as taiwanjobs
from freelance.bootstrap.store import SQLiteStore

NOW=datetime(2026,9,19,tzinfo=timezone.utc)
LABELS={'OCCU_DESC':'職務名稱','WK_TYPE':'職務性質','JOB_DETAIL':'工作內容','URL_QUERY':'職缺資料URL','TRANDATE':'職缺更新日期','STOP_DATE':'應徵截止日期','WKTIME':'工作時間','SALARYCD':'核薪方式','NT_L':'薪資範圍下限','NT_U':'薪資範圍上限'}
def row(**changes):
    return dict(OCCU_DESC='AI agent 後端 API 工程師',WK_TYPE='兼職',JOB_DETAIL='遠端開發 AI agent 與後端 API',URL_QUERY='https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=12&HIRE_ID=34',TRANDATE='20260918',STOP_DATE='20261231',WKTIME='日班',SALARYCD='時薪',NT_L='500',NT_U='1000')|changes

def xml(*rows):
    return ('<?xml version="1.0"?><DataList>'+''.join('<Data>'+''.join(f'<{k}（{LABELS[k]}）><![CDATA[{v}]]></{k}（{LABELS[k]}）>' for k,v in r.items())+'</Data>' for r in rows)+'</DataList>').encode()

class TaiwanTests(unittest.TestCase):
    def test_exact_label_repair_preserves_cdata_and_unknowns(self):
        j=taiwanjobs.parse(xml(row(JOB_DETAIL='開發 API <WKTIME（工作時間）>例子</WKTIME（工作時間）> & RAG')),now=NOW)[0]
        self.assertIn('<WKTIME（工作時間）>',j['description'])
        self.assertEqual(j['external_id'],'12:34');self.assertEqual(j['kind'],'contract')
        for k in ('taiwan_eligible','timezone_compatible','weekly_hours','budget_min','budget_max'):
            self.assertIsNone(j[k])
        self.assertNotIn('published_at',j)
        self.assertEqual(j['source_updated_at'],'2026-09-18T00:00:00+08:00')
        self.assertEqual(j['deadline'],'2026-12-31')
        self.assertEqual(j['salary_evidence']['period'],'時薪')
    def test_full_time_wins_and_unknown_type_not_guessed(self):
        jobs=taiwanjobs.parse(xml(row(WK_TYPE='全職'),row(WK_TYPE='未知',URL_QUERY=row()['URL_QUERY'].replace('34','35'))),now=NOW)
        self.assertEqual([j['kind'] for j in jobs],['full_time',None])
    def test_rejects_entity_invalid_schema_or_duplicate_fields(self):
        for raw in (b'<!DOCTYPE x [<!ENTITY p "bad">]><DataList/>',b'<html>challenge</html>',xml(row()).replace('（職務名稱）'.encode(),'（UNKNOWN）'.encode()),xml(row()).replace(b'</Data>',b'<WK_TYPE>x</WK_TYPE></Data>')):
            with self.assertRaises(ValueError):taiwanjobs.parse(raw,now=NOW)
    def test_invalid_origin_duplicate_identity_and_date_fail(self):
        for changed in (row(URL_QUERY=row()['URL_QUERY'].replace('job.taiwanjobs.gov.tw','evil.invalid')),row(TRANDATE='20269999'),row(URL_QUERY=row()['URL_QUERY']+'&HIRE_ID=56')):
            with self.assertRaises(ValueError):taiwanjobs.parse(xml(changed),now=NOW)
        with self.assertRaises(ValueError):taiwanjobs.parse(xml(row(),row()),now=NOW)
    def test_stale_update_never_becomes_fresh_publication(self):
        j=taiwanjobs.parse(xml(row(TRANDATE='20200101')),now=NOW)[0]
        self.assertNotIn('published_at',j)
        self.assertEqual(j['source_updated_at'],'2020-01-01T00:00:00+08:00')
    def test_replay_preserves_human_work_and_expired_update_removes_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            store=SQLiteStore(Path(d)/'db',clock=lambda:NOW);store.migrate()
            rows=taiwanjobs.parse(xml(row()),now=NOW)
            self.assertEqual(taiwanjobs.sync(store,reader=lambda:rows)['jobs'],1)
            item=store.list()[0];store.review(item['id'],'edit',1,text='Human draft');store.track(item['id'],0,feedback='interested')
            taiwanjobs.sync(store,reader=lambda:rows)
            self.assertEqual(store.list()[0]['proposal'],'Human draft')
            changed=taiwanjobs.parse(xml(row(STOP_DATE='20260901')),now=NOW)
            taiwanjobs.sync(store,reader=lambda:changed)
            latest=store.list()[0]
            self.assertEqual(latest['evaluation']['status'],'excluded')
            self.assertEqual(latest['tracking']['feedback'],'interested')
    def test_new_irrelevant_fulltime_old_and_unknown_type_not_imported(self):
        with tempfile.TemporaryDirectory() as d:
            store=SQLiteStore(Path(d)/'db',clock=lambda:NOW);store.migrate()
            for r in (row(WK_TYPE='全職'),row(WK_TYPE='未知'),row(TRANDATE='20200101'),row(OCCU_DESC='清潔',JOB_DETAIL='打掃')):
                taiwanjobs.sync(store,reader=lambda:taiwanjobs.parse(xml(r),now=NOW))
            self.assertEqual(store.list(),[])
    def test_sync_wrong_source_rolls_back_and_marks_failed(self):
        with tempfile.TemporaryDirectory() as d:
            store=SQLiteStore(Path(d)/'db',clock=lambda:NOW);store.migrate()
            rows=taiwanjobs.parse(xml(row()),now=NOW)
            result=taiwanjobs.sync(store,reader=lambda:rows+[dict(rows[0],source='evil')])
            self.assertEqual(result['status'],'failed');self.assertEqual(store.list(),[])
            self.assertEqual(store.sources()['taiwanjobs'],'failed')
    def test_empty_valid_feed_is_zero_and_bounded_large_feed_rejected(self):
        self.assertEqual(taiwanjobs.parse(xml(),now=NOW),[])
        with self.assertRaises(ValueError):taiwanjobs.parse(b'x'*8000001,now=NOW)

    def test_partial_batch_keeps_valid_rows_and_reports_missing_title(self):
        raw=xml(row(),row(OCCU_DESC='',URL_QUERY=row()['URL_QUERY'].replace('34','35')))
        batch=taiwanjobs.parse_batch(raw,now=NOW)
        self.assertEqual(batch['rejected_count'],1)
        with tempfile.TemporaryDirectory() as d:
            store=SQLiteStore(Path(d)/'db',clock=lambda:NOW);store.migrate()
            result=taiwanjobs.sync(store,reader=lambda:batch)
            self.assertEqual(result['status'],'partial');self.assertEqual(result['jobs'],1)
            self.assertEqual(store.sources()['taiwanjobs'],'failed')
            taiwanjobs.sync(store,reader=lambda:batch)
            self.assertEqual(len(store.list()),1)
    def test_empty_body_retains_missing_information(self):
        job=taiwanjobs.parse(xml(row(JOB_DETAIL='')),now=NOW)[0]
        self.assertFalse(job['complete']);self.assertFalse(job['body_available'])
