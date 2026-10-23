import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock
from freelance.modules.collection.resend_sync import sync_tasker
from freelance.modules.collection.resend_preview import preview
from freelance.bootstrap.store import SQLiteStore
from fixtures.resend_preview import mail,TARGET

class SyncTests(TestCase):
    def test_linkedin_disabled_alert_is_processed_without_claiming_job_intake(self):
        from freelance.modules.collection.resend_sync import sync_linkedin
        notice = mail(**{'from': 'jobalerts-noreply@linkedin.com',
            'subject': 'We‘ve turned off your job alert for software engineer in Asia',
            'text': 'Administrative notice only.'})
        self.client.list_received.return_value = {'data': [notice], 'has_more': False}
        self.client.get_received.return_value = notice
        for _ in range(2):
            result = sync_linkedin(self.client, self.store, TARGET)
            self.assertEqual((result['status'], result['jobs'], result['messages'], result['quarantined']),
                             ('waiting', 0, 0, 0))
        record, = self.store.mail_records('linkedin', TARGET).values()
        self.assertEqual((record['status'], record['reason']), ('processed', 'non_job_notification'))
        self.assertEqual(self.client.get_received.call_count, 1)
        self.assertEqual(self.store.list(), [])

    def test_linkedin_unknown_notification_remains_quarantined(self):
        from freelance.modules.collection.resend_sync import sync_linkedin
        notice = mail(**{'from': 'jobalerts-noreply@linkedin.com',
            'subject': 'New LinkedIn jobs', 'text': 'Unknown private template.'})
        self.client.list_received.return_value = {'data': [notice], 'has_more': False}
        self.client.get_received.return_value = notice
        result = sync_linkedin(self.client, self.store, TARGET)
        self.assertEqual((result['status'], result['quarantined']), ('failed', 1))

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=SQLiteStore(Path(self.tmp.name)/'db');self.store.migrate()
        self.client=Mock();self.client.list_received.return_value={'data':[mail()],'has_more':False};self.client.get_received.return_value=mail()
    def test_import_and_replay(self):
        self.assertEqual(sync_tasker(self.client,self.store,TARGET)['status'],'ok')
        self.assertEqual(sync_tasker(self.client,self.store,TARGET)['status'],'ok')
        self.assertEqual(len(self.store.list()),1)
        with self.store._connect() as c:self.assertEqual(c.execute('select count(*) as n from source_receipts').fetchone()['n'],1)
    def test_gmail_duplicate_preserves_old_timestamp_and_draft(self):
        job=preview(self.client,TARGET)['items'][0]['job'];job['received_at']='2026-09-17T00:00:00+00:00'
        item=self.store.ingest(job,'gmail-original');self.store.review(item['id'],'edit',item['version'],'User draft')
        self.assertEqual(sync_tasker(self.client,self.store,TARGET)['status'],'ok')
        kept=self.store.list()[0];self.assertEqual(kept['job']['received_at'],job['received_at']);self.assertEqual(kept['proposal'],'User draft')
    def test_changed_existing_keeps_both_versions_without_overwrite(self):
        job=preview(self.client,TARGET)['items'][0]['job'];job['description']='Existing newer description';self.store.ingest(job,'original')
        result=sync_tasker(self.client,self.store,TARGET)
        self.assertEqual((result['status'],result['content_versions']),('ok',1))
        item=self.store.list()[0]
        self.assertEqual(item['job']['description'],job['description'])
        conflict,=item['content_conflicts']
        self.assertEqual(len(conflict['versions']),2)
        self.assertIn('description',conflict['changed_fields'])
        self.assertEqual(self.store.sources()['tasker'],'ok')
        record,=self.store.mail_records('tasker',TARGET).values()
        self.assertEqual((record['status'],record['reason']),('processed','content_changed'))
    def test_truncation_preserves_valid_jobs_and_unknown_is_quarantined(self):
        self.client.list_received.return_value['has_more']=True
        self.assertEqual(sync_tasker(self.client,self.store,TARGET,max_pages=1)['status'],'failed')
        self.assertEqual(len(self.store.list()),1)
        unknown=mail(id='11111111-02e9-4d39-ad75-9611e0fcc33c',html='PRIVATE')
        self.client.list_received.return_value={'data':[unknown],'has_more':False}
        self.client.get_received.return_value=unknown
        self.assertEqual(sync_tasker(self.client,self.store,TARGET)['quarantined'],1)
        self.assertEqual(len(self.store.list()),1)
    def test_one_changed_job_preserves_other_job_in_same_notification(self):
        job=preview(self.client,TARGET)['items'][0]['job'];other=job|{'external_id':'other','receipt_id':'new'}
        changed=job|{'description':'conflicting'};self.store.ingest(job,'existing')
        self.assertEqual(self.store.ingest_resend_batch([other,changed])['content_versions'],1)
        self.assertEqual(len(self.store.list()),2)
        self.assertEqual(self.store.ingest_resend_batch([other,changed])['content_versions'],0)
        with self.store._connect(write=False) as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM mail_content_versions').fetchone()['n'],2)
            self.assertEqual(c.execute('SELECT count(*) n FROM source_receipts').fetchone()['n'],3)

    def test_receipt_collision_still_rolls_back_entire_batch(self):
        from freelance.legacy.review import Conflict
        job=preview(self.client,TARGET)['items'][0]['job']
        self.store.ingest(job,'existing')
        other=job|{'external_id':'other','receipt_id':'new'}
        collision=job|{'external_id':'third','receipt_id':'existing'}
        with self.assertRaises(Conflict):self.store.ingest_resend_batch([other,collision])
        self.assertEqual(len(self.store.list()),1)
        with self.store._connect(write=False) as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM source_receipts').fetchone()['n'],1)
    def test_failed_scan_reports_safe_stage_counts_without_email_content(self):
        self.client.get_received.side_effect=ValueError('SECRET BODY')
        result=sync_tasker(self.client,self.store,TARGET)
        self.assertEqual(result['error_stages'],{'fetch':1})
        self.assertEqual(result['body_reads'],1)
        self.assertNotIn('SECRET',str(result))
        self.client.get_received.side_effect=None
        self.client.get_received.return_value=mail(html='SECRET BODY')
        self.assertEqual(sync_tasker(self.client,self.store,TARGET)['error_stages'],{'template':1})
    def test_waiting_for_platform_mail_does_not_claim_connected(self):
        from freelance.modules.collection.resend_sync import sync_linkedin, sync_cake, sync_104
        self.client.list_received.return_value={'data':[],'has_more':False}
        for source,sync in (('linkedin',sync_linkedin),('cake',sync_cake),('jobbank104',sync_104)):
            result=sync(self.client,self.store,TARGET)
            self.assertEqual(result['status'],'waiting')
            self.assertEqual(self.store.sources()[source],'waiting')
        self.client.get_received.assert_not_called()
        self.assertEqual(self.store.list(),[])

    def test_empty_truncated_scan_is_failed_not_waiting(self):
        from freelance.modules.collection.resend_sync import sync_linkedin
        self.client.list_received.return_value={'data':[],'has_more':True}
        self.assertEqual(sync_linkedin(self.client,self.store,TARGET)['status'],'failed')
        self.assertEqual(self.store.sources()['linkedin'],'failed')

    def test_waiting_promotes_after_first_valid_notification_and_replays_safely(self):
        from unittest.mock import patch
        from freelance.modules.collection.resend_sync import sync_linkedin
        from freelance.modules.collection.linkedin_mail import parse_linkedin
        from freelance.modules.discovery.domain import qualify
        from fixtures.linkedin_mail import mail as linkedin_mail
        self.client.list_received.return_value={'data':[],'has_more':False}
        self.assertEqual(sync_linkedin(self.client,self.store,TARGET)['status'],'waiting')
        job=parse_linkedin(linkedin_mail())[0]
        self.client.list_received.return_value={'data':[mail(**{'from':'jobalerts-noreply@linkedin.com'})],'has_more':False}
        with patch('freelance.modules.collection.resend_sync.read_notification',return_value=[{'job':job,'evaluation':qualify(job)}]):
            self.assertEqual(sync_linkedin(self.client,self.store,TARGET)['status'],'ok')
            item=self.store.list()[0]
            self.store.review(item['id'],'edit',item['version'],'Human edited proposal')
            self.assertEqual(sync_linkedin(self.client,self.store,TARGET)['status'],'ok')
        self.assertEqual(self.store.sources()['linkedin'],'ok')
        self.assertEqual(len(self.store.list()),1)
        self.assertEqual(self.store.list()[0]['proposal'],'Human edited proposal')
