import tempfile
from pathlib import Path
from datetime import datetime,timezone
from unittest import TestCase
from unittest.mock import Mock,patch
from freelance.bootstrap.daily import main
from freelance.modules.notifications.service import run
from freelance.bootstrap.store import SQLiteStore
from fixtures.resend_preview import mail,TARGET

class DailyTests(TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.store=SQLiteStore(self.root/'db');self.store.migrate()
        self.client=Mock();self.client.list_received.return_value={'data':[mail()],'has_more':False};self.client.get_received.return_value=mail()
        self.factory=Mock(return_value=self.client)
    def invoke(self,now):return run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,now=now)
    def test_due_once_no_send(self):
        now=datetime(2026,9,19,1,tzinfo=timezone.utc)
        result=self.invoke(now);self.assertEqual(result['status'],'digest_ready');self.assertEqual(result['delivery_status'],'pending')
        self.assertEqual(self.invoke(now)['status'],'already_run');self.factory.assert_called_once()
    def test_before_due_no_key(self):
        self.assertEqual(self.invoke(datetime(2026,9,19,0,tzinfo=timezone.utc))['status'],'not_due');self.factory.assert_not_called()
    def test_linkedin_disabled_by_default(self):
        with patch('freelance.modules.collection.resend_sync.sync_linkedin', side_effect=AssertionError('Unexpected read')):
            self.invoke(datetime(2026,9,19,1,tzinfo=timezone.utc))
    def test_cake_disabled_by_default(self):
        with patch('freelance.modules.collection.resend_sync.sync_cake', side_effect=AssertionError('Unexpected read')):
            self.invoke(datetime(2026,9,19,1,tzinfo=timezone.utc))
    def test_104_disabled_by_default(self):
        with patch('freelance.modules.collection.resend_sync.sync_104', side_effect=AssertionError('Unexpected read')):
            self.invoke(datetime(2026,9,19,1,tzinfo=timezone.utc))
    def test_talent_disabled_by_default(self):
        with patch('freelance.modules.collection.resend_sync.sync_talent', side_effect=AssertionError('Unexpected read')):
            self.invoke(datetime(2026,9,19,1,tzinfo=timezone.utc))
    def test_talent_failure_does_not_skip_tasker(self):
        with patch('freelance.modules.collection.resend_sync.sync_talent', return_value={'status':'failed'}) as sync:
            result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,
                       now=datetime(2026,9,19,1,tzinfo=timezone.utc),talent=True)
        self.assertEqual(result['status'],'source_failed')
        self.assertEqual(self.store.sources()['tasker'],'ok')
        sync.assert_called_once_with(self.client,self.store,TARGET,max_messages=20)
    def test_104_failure_does_not_skip_tasker(self):
        with patch('freelance.modules.collection.resend_sync.sync_104', return_value={'status':'failed'}) as sync:
            result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,
                       now=datetime(2026,9,19,1,tzinfo=timezone.utc),jobbank104=True)
        self.assertEqual(result['status'],'source_failed')
        self.assertEqual(self.store.sources()['tasker'],'ok')
        sync.assert_called_once_with(self.client,self.store,TARGET,max_messages=20)
    def test_cake_failure_does_not_skip_other_sources(self):
        with patch('freelance.modules.collection.resend_sync.sync_cake', return_value={'status':'failed'}) as cake_sync, \
             patch('freelance.modules.collection.resend_sync.sync_linkedin', return_value={'status':'ok'}) as linkedin_sync:
            result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,
                       now=datetime(2026,9,19,1,tzinfo=timezone.utc),linkedin=True,cake=True)
        self.assertEqual(result['status'],'source_failed')
        self.assertEqual(self.store.sources()['tasker'],'ok')
        cake_sync.assert_called_once_with(self.client,self.store,TARGET,max_messages=20)
        linkedin_sync.assert_called_once_with(self.client,self.store,TARGET,max_messages=20)
    def test_linkedin_enabled_failure_does_not_skip_tasker(self):
        with patch('freelance.modules.collection.resend_sync.sync_linkedin', return_value={'status':'failed'}) as sync:
            result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,
                       now=datetime(2026,9,19,1,tzinfo=timezone.utc),linkedin=True)
        self.assertEqual(result['status'],'source_failed')
        self.assertEqual(self.store.sources()['tasker'],'ok')
        sync.assert_called_once_with(self.client,self.store,TARGET,max_messages=20)
    def test_source_failure_visible(self):
        self.client.get_received.return_value=mail(html='PRIVATE')
        result=self.invoke(datetime(2026,9,19,1,tzinfo=timezone.utc));self.assertEqual(result['status'],'source_failed')
        self.assertEqual(self.store.list(),[])
    def test_cli_opt_in_before_key(self):
        with self.assertRaises(SystemExit):main(['--database','missing','--key-file','missing','--inbox',TARGET,'--recipient','self@example.com','--output-dir',str(self.root)])
    def test_opt_in_delivery_once(self):
        delivery=Mock(return_value={'status':'sent'})
        from freelance.modules.notifications.service import run
        result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,now=datetime(2026,9,19,1,tzinfo=timezone.utc),delivery=delivery)
        self.assertEqual(result['delivery_status'],'sent');delivery.assert_called_once()
        run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,now=datetime(2026,9,19,1,tzinfo=timezone.utc),delivery=delivery)
        delivery.assert_called_once()
    def test_old_unsent_snapshot_not_delivered(self):
        now=datetime(2026,9,19,1,tzinfo=timezone.utc)
        self.store.create_digest(now.date(),'self@example.com',now)
        delivery=Mock(return_value={'status':'sent'})
        result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,now=now,delivery=delivery)
        delivery.assert_not_called();self.assertEqual(result['delivery_error'],'existing_snapshot_requires_review')
    def test_freelancer_failure_is_visible_independent_of_tasker(self):
        with patch('freelance.modules.collection.freelancer.sync',return_value={'status':'failed','reason':'freelancer_source_failed'}) as sync:
            result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,now=datetime(2026,9,19,1,tzinfo=timezone.utc),freelancer=True)
        self.assertEqual(result['status'],'source_failed');sync.assert_called_once()
    def test_free_boards_includes_ptt_and_retains_source_failure(self):
        with patch('freelance.modules.collection.free_jobs.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.himalayas.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.community_jobs.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.ptt_soho.sync',return_value={'status':'failed'}) as ptt, \
             patch('freelance.modules.collection.ptt_codejob.sync',return_value={'status':'ok'}) as codejob, \
             patch('freelance.modules.collection.public_feeds.sync',return_value={'status':'partial'}) as feeds, \
             patch('freelance.modules.collection.taiwanjobs.sync',return_value={'status':'ok'}) as taiwan, \
             patch('freelance.modules.collection.arbeitnow.sync',return_value={'status':'ok'}) as arbeitnow, \
             patch('freelance.modules.collection.nodesk.sync',return_value={'status':'ok'}) as nodesk, \
             patch('freelance.modules.collection.getonboard.sync',return_value={'status':'ok'}) as getonboard, \
             patch('freelance.modules.collection.justremote.sync',return_value={'status':'ok'}) as justremote, \
             patch('freelance.modules.collection.cryptojobslist.sync',return_value={'status':'ok'}) as cryptojobslist, \
             patch('freelance.modules.collection.dynamitejobs.sync',return_value={'status':'ok'}) as dynamitejobs, \
             patch('freelance.modules.collection.jobbank518.sync',return_value={'status':'ok'}) as jobbank518, \
             patch('freelance.modules.collection.chickpt.sync',return_value={'status':'ok'}) as chickpt:
            result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,
                       now=datetime(2026,9,19,1,tzinfo=timezone.utc),free_boards=True)
        self.assertEqual(result['status'],'source_failed')
        ptt.assert_called_once_with(self.store)
        codejob.assert_called_once_with(self.store)
        taiwan.assert_called_once_with(self.store)
        arbeitnow.assert_called_once_with(self.store)
        nodesk.assert_called_once_with(self.store)
        getonboard.assert_called_once_with(self.store)
        justremote.assert_called_once_with(self.store)
        cryptojobslist.assert_called_once_with(self.store)
        dynamitejobs.assert_called_once_with(self.store)
        jobbank518.assert_called_once_with(self.store)
        chickpt.assert_called_once_with(self.store)
        self.assertEqual([call.args[0] for call in feeds.call_args_list],['remoteok','realworkfromanywhere','weworkremotely','workingnomads'])

    def test_partial_new_feed_is_visible_when_other_sources_succeed(self):
        with patch('freelance.modules.collection.free_jobs.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.himalayas.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.community_jobs.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.ptt_soho.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.ptt_codejob.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.public_feeds.sync',return_value={'status':'partial','rejected_count':1}), \
             patch('freelance.modules.collection.taiwanjobs.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.arbeitnow.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.nodesk.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.getonboard.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.justremote.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.cryptojobslist.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.dynamitejobs.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.jobbank518.sync',return_value={'status':'ok'}), \
             patch('freelance.modules.collection.chickpt.sync',return_value={'status':'ok'}):
            result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,
                       now=datetime(2026,9,19,1,tzinfo=timezone.utc),free_boards=True)
        self.assertEqual(result['status'],'source_failed')

    def test_removed_ai_flags_are_rejected_before_live_read(self):
        with self.assertRaises(SystemExit):
            main(['--database','missing','--key-file','missing','--inbox',TARGET,'--recipient','self@example.com',
                  '--output-dir',str(self.root),'--live-read','--ai-drafts'])

    def test_enabled_waiting_mail_sources_do_not_block_other_digest(self):
        result=run(self.store,self.factory,inbox=TARGET,recipient='self@example.com',output_dir=self.root,
                   now=datetime(2026,9,26,1,tzinfo=timezone.utc),linkedin=True,cake=True,jobbank104=True,talent=True)
        self.assertEqual(result['status'],'digest_ready')
        self.assertEqual(result['candidates'],1)
        for source in ('linkedin','cake','jobbank104','talent'):
            self.assertEqual(result['source_details'][source]['status'],'waiting')
            self.assertEqual(self.store.sources()[source],'waiting')
        self.assertIn('等待符合規則的職缺通知',Path(result['output']).read_text())
