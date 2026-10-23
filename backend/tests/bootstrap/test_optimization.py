"""Real SQLite acceptance: ranking, human tracking, digest novelty; no providers."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from freelance.bootstrap.store import SQLiteStore
from freelance.legacy.review import Conflict, InvalidAction
from freelance.modules.notifications.scheduler import dispatch
from fixtures.domain import job, legacy_proposal
NOW = datetime(2026, 9, 19, 1, tzinfo=timezone.utc)

class OptimizationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'cases.sqlite3'
        self.store = SQLiteStore(self.path, clock=lambda: NOW); self.store.migrate()
    def add(self, key='case', **fields):
        return self.store.ingest(job(external_id=key, **fields))

    def test_information_quality_breaks_technical_tie_without_claiming_eligibility(self):
        unknown = self.add('unknown', taiwan_eligible=None, weekly_hours=None, complete=False)
        self.add('known'); listed = self.store.list()
        self.assertEqual(listed[0]['job']['external_id'], 'known')
        missing = next(x for x in listed if x['id'] == unknown['id'])
        self.assertEqual(missing['evaluation']['status'], 'needs_info')
        self.assertLess(missing['recommendation']['completeness'], listed[0]['recommendation']['completeness'])
        self.assertTrue(missing['recommendation']['reasons'])

    def test_old_publication_not_refreshed_by_receipt_and_future_date_not_rewarded(self):
        self.add('old', published_at='2026-08-01T00:00:00Z', received_at=NOW.isoformat())
        self.add('new', published_at='2026-09-18T00:00:00Z')
        self.add('future', published_at='2099-01-01T00:00:00Z')
        listed = self.store.list(); self.assertEqual(listed[0]['job']['external_id'], 'new')
        self.assertEqual(next(x for x in listed if x['job']['external_id']=='old')['recommendation']['freshness'],'older')
        self.assertEqual(next(x for x in listed if x['job']['external_id']=='future')['recommendation']['freshness'],'unknown')

    def test_feedback_survives_update_restart_without_editing_proposal(self):
        item = self.add(); result = self.store.track(item['id'],0,feedback='interested')
        self.assertEqual((result['version'],result['proposal']),(1,item['proposal']))
        self.assertEqual(result['tracking']['revision'],1)
        self.store.ingest(job(external_id='case',budget_max=12000))
        restarted = SQLiteStore(self.path,clock=lambda:NOW).list()[0]
        self.assertEqual(restarted['tracking']['feedback'],'interested')
        self.assertGreater(restarted['recommendation']['score'],item['evaluation']['score']*.7)

    def test_concurrent_tracking_only_one_revision_wins(self):
        item=self.add()
        def update(_):
            try:return self.store.track(item['id'],0,feedback='interested')['tracking']['revision']
            except Conflict:return 'conflict'
        with ThreadPoolExecutor(2) as pool:self.assertCountEqual(list(pool.map(update,range(2))),[1,'conflict'])

    def test_invalid_feedback_transition_and_evidence_not_saved(self):
        item=self.add()
        for payload in ({'feedback':'bad'},{'feedback':'unsupported'},{'stage':'won'}, {'stage':'applied'},
                        {'stage':'applied','evidence':'x'*2001},{'feedback':'interested','note':[]},
                        {'feedback':'skipped','reason':'other'}):
            with self.subTest(payload=payload),self.assertRaises(InvalidAction):self.store.track(item['id'],0,**payload)
        self.assertEqual(self.store.list()[0]['tracking']['revision'],0)
        with self.assertRaises(Conflict):self.store.track(item['id'],True,feedback='interested')

    def test_application_history_distinct_counts_and_manual_correction(self):
        item=self.add()
        self.store.track(item['id'],0,stage='applied',evidence='Platform confirmation #123')
        self.store.track(item['id'],1,stage='replied',note='Client asked availability')
        self.store.track(item['id'],2,stage='negotiating'); self.store.track(item['id'],3,stage='won')
        stats=self.store.tracking_summary()['sources']['freelancer']
        self.assertEqual((stats['applied'],stats['replied'],stats['won']),(1,1,1))
        with self.assertRaises(InvalidAction):self.store.track(item['id'],4,stage='not_applied')
        self.store.track(item['id'],4,stage='not_applied',note='Correction: wrong opportunity')
        self.assertEqual(self.store.list()[0]['tracking']['stage'],'not_applied')
        self.assertEqual(self.store.tracking_summary()['sources']['freelancer']['applied'],1)

    def test_skips_applied_hidden_interest_cannot_override_exclusion(self):
        skipped=self.add('skip'); applied=self.add('applied'); excluded=self.add('excluded',weekly_hours=40); good=self.add('good')
        self.store.track(skipped['id'],0,feedback='skipped',reason='budget')
        self.store.track(applied['id'],0,stage='applied',evidence='Platform receipt 42')
        self.store.track(excluded['id'],0,feedback='interested')
        snapshot=self.store.create_digest('2026-09-19','test@example.invalid',NOW)['snapshot']
        self.assertEqual([x['id'] for x in snapshot['items']],[good['id']])
        self.assertEqual(next(x for x in self.store.list() if x['id']==excluded['id'])['evaluation']['status'],'excluded')
        self.assertEqual(self.store.tracking_summary()['skip_reasons']['budget'],1)

    def test_all_sent_suppressed_and_changed_source_reappears(self):
        for i in range(7):self.add(str(i))
        first=self.store.create_digest('2026-09-19','test@example.invalid',NOW)
        self.assertEqual(len(first['snapshot']['items']),7)
        dispatch(self.store,first['id'],lambda _:{'message_id':'synthetic'})
        first_ids={x['id'] for x in first['snapshot']['items']}; changed=first['snapshot']['items'][0]
        self.store.ingest(changed['job']|{'budget_max':15000})
        tomorrow=self.store.create_digest('2026-09-20','test@example.invalid',NOW+timedelta(days=1))
        ids={x['id'] for x in tomorrow['snapshot']['items']}
        self.assertEqual(ids,{changed['id']}); self.assertEqual(ids&first_ids,{changed['id']})
        self.assertEqual(self.store.get_digest(first['id'])['snapshot'],first['snapshot'])

    def test_uncertain_send_suppresses_pending_does_not_recipient_isolated(self):
        self.add(); first=self.store.create_digest('2026-09-19','test@example.invalid',NOW)
        self.store.claim_digest(first['id'])
        tomorrow=self.store.create_digest('2026-09-20','test@example.invalid',NOW+timedelta(days=1))
        self.assertEqual(tomorrow['snapshot']['items'],[])
        other=self.store.create_digest('2026-09-20','other@example.invalid',NOW+timedelta(days=1))
        self.assertEqual(len(other['snapshot']['items']),1)
        pending=self.store.create_digest('2026-09-21','other@example.invalid',NOW+timedelta(days=2))
        self.assertEqual(len(pending['snapshot']['items']),1)

    def test_cli_records_and_reports_without_outbox(self):
        item=self.add(); base=[sys.executable,'-m','freelance.bootstrap.cli','--database',str(self.path)]
        run=subprocess.run(base+['feedback',item['id'],'--versions',json.dumps({item['id']:item['fingerprint']+':0'}),'--state','interested'],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertEqual(self.store.list()[0]['tracking']['feedback'],'interested')
        stats=subprocess.run(base+['summary'],capture_output=True,text=True)
        self.assertEqual(stats.returncode,0,stats.stderr)
        self.assertEqual(json.loads(stats.stdout)['saved'],1)
        with self.store._connect() as conn:self.assertEqual(conn.execute('SELECT count(*) AS n FROM digest_outbox').fetchone()['n'],0)

    def test_migration_preserves_revisions_tracking(self):
        item=self.add(); self.store.review(item['id'],'edit',1,text='My actual draft')
        self.store.track(item['id'],0,feedback='skipped',reason='scope')
        self.store.migrate(); self.store.migrate(); result=self.store.list()[0]
        self.assertEqual(result['proposal'],'My actual draft'); self.assertEqual(result['tracking']['feedback'],'skipped')
        with self.store._connect() as conn:
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()['integrity_check'],'ok')
            self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_existing_connector_publication_evidence_is_used_without_rehashing_jobs(self):
        self.add('hima',source='himalayas',received_at='2026-09-18T00:00:00Z')
        self.add('mail',source='tasker',received_at='2026-09-18T00:00:00Z')
        self.add('feed',source='jobicy',publication_evidence='2026-09-18 00:00:00')
        items={x['job']['external_id']:x for x in self.store.list()}
        self.assertEqual(items['hima']['recommendation']['freshness'],'recent')
        self.assertEqual(items['feed']['recommendation']['freshness'],'recent')
        self.assertEqual(items['mail']['recommendation']['freshness'],'unknown')

    def test_interest_can_explicitly_reopen_legacy_skipped_review(self):
        item=self.add();self.store.review(item['id'],'skip',1,reason='legacy skip')
        self.store.track(item['id'],0,feedback='interested')
        result=self.store.list()[0]
        self.assertEqual(result['review_status'],'draft')
        self.assertEqual(result['skip_reason'],'')
        self.assertIsNone(result['approved_hash'])
        self.assertEqual(len(self.store.create_digest('2026-09-19','test@example.invalid',NOW)['snapshot']['items']),1)

    def test_skipping_revokes_existing_approval_and_blocks_new_approval_until_restored(self):
        item=legacy_proposal(self.store,self.add()); self.store.review(item['id'],'approve',1)
        self.store.track(item['id'],0,feedback='skipped',reason='budget')
        skipped=self.store.list()[0]
        self.assertIsNone(skipped['approved_hash'])
        with self.assertRaises(InvalidAction):self.store.review(item['id'],'approve',skipped['version'])
        self.store.track(item['id'],1,feedback='neutral')
        reopened=self.store.list()[0]
        self.assertEqual(self.store.review(item['id'],'approve',reopened['version'])['review_status'],'approved')

    def test_reset_discards_prefilled_evidence_and_requires_fresh_application_record(self):
        item=self.add()
        self.store.track(item['id'],0,stage='applied',evidence='wrong confirmation')
        reset=self.store.track(item['id'],1,stage='not_applied',note='Wrong case',evidence='wrong confirmation')
        self.assertEqual(reset['tracking']['evidence'],'')
        with self.assertRaises(InvalidAction):self.store.track(item['id'],2,stage='applied')
        with self.store._connect() as conn:
            historical=conn.execute('SELECT state FROM tracking_events WHERE revision=1').fetchone()['state']
        self.assertEqual(json.loads(historical)['evidence'],'wrong confirmation')
