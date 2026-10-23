"""Discovery behavior against temporary SQLite, including existing historical data."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import tempfile
import unittest

from freelance.modules.discovery.rules import DEFAULTS, group_items, public_item
from freelance.legacy.review import Conflict, InvalidAction
from freelance.bootstrap.store import SQLiteStore
from fixtures.domain import job, legacy_proposal

NOW = datetime(2026, 9, 28, 1, tzinfo=timezone.utc)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'discovery.db'
        self.store = SQLiteStore(self.path, clock=lambda: NOW)
        self.store.migrate()

    def groups(self):
        return group_items(self.store.list())

    def versions(self, group):
        return {member['id']: member['token'] for member in group['members']}

    def digest(self, day):
        now = NOW + timedelta(days=day)
        return self.store.create_digest(now.date(), 'owner@example.test', now)

    def sent(self, intent):
        self.store.claim_digest(intent['id'])
        self.store.finish_digest(intent['id'], 'sent', receipt='synthetic')

    def test_preferences_persist_and_requalify_without_reingestion(self):
        self.store.ingest(job(weekly_hours=25))
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'qualified')
        self.store.set_preferences(0, DEFAULTS | {'max_weekly_hours': 20})
        self.assertEqual(SQLiteStore(self.path).preferences()['settings']['max_weekly_hours'], 20)
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'excluded')
        self.store.set_preferences(1, DEFAULTS | {'max_weekly_hours': None})
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'qualified')
        with self.assertRaises(Conflict):
            self.store.set_preferences(1, DEFAULTS)

    def test_track_returns_item_with_tracking_and_recommendation(self):
        self.assertEqual(self.store.preferences(), dict(revision=0, settings=DEFAULTS))
        key = self.store.ingest(job())['id']
        item = self.store.track(key, 0, feedback='interested', note='Keep')
        listed = next(row for row in self.store.list() if row['id'] == key)
        self.assertEqual((item['tracking']['feedback'], item['tracking']['note']), ('interested', 'Keep'))
        self.assertIn('你已標記想接', item['recommendation']['reasons'])
        self.assertEqual(item['recommendation'], listed['recommendation'])

    def test_preferences_validate_inputs_and_preserve_unknown_eligibility(self):
        for change in ({'max_weekly_hours': True}, {'min_fixed_twd': -1},
                       {'categories': [[]]}, {'categories': []}, {'categories': ['unknown']}):
            with self.assertRaises(ValueError):
                self.store.set_preferences(0, DEFAULTS | change)
        self.store.ingest(job(taiwan_eligible=None, weekly_hours=None))
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'needs_info')
        self.store.set_preferences(0, DEFAULTS | {'categories': ['後端／API']})
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'excluded')

    def test_exact_url_groups_sources_without_changing_rows_or_historical_proposal(self):
        first = legacy_proposal(self.store, self.store.ingest(job()))
        self.store.ingest(job(source='tasker', external_id='cross', url=first['job']['url'] + '#details'))
        group, = self.groups()
        self.assertEqual(len(group['members']), 2)
        self.assertEqual(len(self.store.list()), 2)
        self.assertNotIn('proposal', public_item(group))
        self.assertTrue(next(x for x in self.store.list() if x['id'] == first['id'])['proposal'])

    def test_only_same_company_title_full_body_groups_and_conflicts_stay_separate(self):
        body = 'Build an agent integration with API, database, tests and deployment. ' * 3
        self.store.ingest(job(company='Example', description=body))
        self.store.ingest(job(source='tasker', external_id='copy', company='Example', description=body))
        self.assertEqual(len(self.groups()), 1)
        self.store.ingest(job(source='tasker', external_id='different', company='Another', description=body))
        self.store.ingest(job(source='tasker', external_id='conflict', company='Example', description=body, taiwan_eligible=False))
        self.store.ingest(job(source='tasker', external_id='card', company='Example', description=body, body_available=False))
        self.assertEqual(len(self.groups()), 4)

    def test_group_feedback_is_atomic_and_new_members_or_changed_jobs_conflict(self):
        original = self.store.ingest(job())
        first, = self.groups()
        self.store.ingest(job(source='tasker', external_id='cross', url=original['job']['url']))
        with self.assertRaises(Conflict):
            self.store.feedback(first['id'], self.versions(first), 'skipped')
        group, = self.groups()
        self.store.feedback(group['id'], self.versions(group), 'interested')
        self.assertTrue(all(item['tracking']['feedback'] == 'interested' for item in self.store.list()))
        with self.assertRaises(Conflict):
            self.store.feedback(group['id'], self.versions(group), 'neutral')
        group, = self.groups()
        self.store.ingest(job(description='Updated API scope'))
        with self.assertRaises(Conflict):
            self.store.feedback(group['id'], self.versions(group), 'skipped')
        self.assertTrue(all(item['tracking']['feedback'] == 'interested' for item in self.store.list()))

    def test_skip_restore_and_restart_use_same_groups_in_digest(self):
        self.store.ingest(job())
        group, = self.groups()
        self.store.feedback(group['id'], self.versions(group), 'skipped')
        self.assertEqual(self.digest(0)['snapshot']['items'], [])
        self.store = SQLiteStore(self.path, clock=lambda: NOW)
        group, = self.groups()
        self.assertEqual(group['tracking']['feedback'], 'skipped')
        self.store.feedback(group['id'], self.versions(group), 'neutral')
        self.assertEqual(len(self.digest(1)['snapshot']['items']), 1)

    def test_duplicate_source_and_interest_do_not_reannounce_but_changed_listing_does(self):
        first = self.store.ingest(job())
        sent = self.digest(0)
        self.assertNotIn('proposal', sent['snapshot']['items'][0])
        self.sent(sent)
        self.store.ingest(job(source='tasker', external_id='copy', url=first['job']['url']))
        group, = self.groups()
        self.store.feedback(group['id'], self.versions(group), 'interested')
        self.assertEqual(self.digest(1)['snapshot']['items'], [])
        self.store.ingest(job(description='Build an agent with updated scope and API integration'))
        changed = self.digest(2)
        self.assertEqual(len(changed['snapshot']['items']), 1)
        self.sent(changed)
        self.assertEqual(self.digest(3)['snapshot']['items'], [])

    def test_new_intake_creates_no_proposal_and_cannot_approve_empty_text(self):
        item = self.store.ingest(job())
        with self.assertRaises(InvalidAction):
            self.store.review(item['id'], 'approve', item['version'])
        with self.store._connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) n FROM proposal_revisions').fetchone()['n'], 0)
            self.assertEqual(conn.execute('SELECT count(*) n FROM ai_draft_attempts').fetchone()['n'], 0)

    def test_migration_preserves_old_rows_and_old_sent_snapshot_suppresses_duplicates(self):
        original = legacy_proposal(self.store, self.store.ingest(job()))
        self.store.track(original['id'], 0, feedback='interested', note='Historical note')
        old_snapshot = dict(items=self.store.list(), sources={}, generated_at=NOW.isoformat())
        with self.store._connect() as conn:
            conn.execute('INSERT INTO digest_outbox(id,local_date,recipient,snapshot) VALUES (?,?,?,?)',
                         ('old-intent', str(NOW.date()), 'owner@example.test', json.dumps(old_snapshot)))
        self.store.claim_digest('old-intent')
        self.store.finish_digest('old-intent', 'sent', receipt='historical-receipt')
        with self.store._connect() as conn:
            for name in ('discovery_settings', 'mail_sync_state', 'mail_ingestion', 'mail_content_versions'):
                conn.execute('DROP TABLE ' + name)
            tables = ('opportunities', 'proposal_revisions', 'opportunity_tracking', 'tracking_events', 'digest_outbox')
            before = {table: conn.execute('SELECT * FROM ' + table).fetchall() for table in tables}
        self.store.migrate()
        with self.store._connect() as conn:
            after = {table: conn.execute('SELECT * FROM ' + table).fetchall() for table in tables}
        self.assertEqual(after, before)
        self.assertEqual(self.digest(1)['snapshot']['items'], [])

    def test_discovery_read_uses_current_preferences_without_writing_legacy_data(self):
        item = legacy_proposal(self.store, self.store.ingest(job(weekly_hours=25)))
        self.store.review(item['id'], 'approve', item['version'])
        self.store.set_preferences(0, DEFAULTS | {'max_weekly_hours': 20})
        with self.store._connect() as conn:
            tables = ('opportunities', 'proposal_revisions', 'opportunity_tracking', 'tracking_events')
            before = {name: conn.execute('SELECT * FROM ' + name).fetchall() for name in tables}
            # BEGIN IMMEDIATE is already held: discovery must still be able to read.
            projected = self.store.list()[0]
            self.assertEqual(projected['evaluation']['status'], 'excluded')
            self.assertIsNone(projected['approved_hash'])
            self.assertEqual(self.store.preferences()['settings']['max_weekly_hours'], 20)
            self.store.sources()
            after = {name: conn.execute('SELECT * FROM ' + name).fetchall() for name in tables}
        self.assertEqual(after, before)
        with self.assertRaises(InvalidAction):
            self.store.review(item['id'], 'approve', item['version'])

    def test_changed_mail_version_can_be_found_without_choosing_latest(self):
        original = job(weekly_hours=25) | {'receipt_id': 'resend:one', 'evidence_ref': 'private-mail-reference'}
        self.store.ingest_resend_batch([original])
        sent = self.digest(0)
        self.sent(sent)
        prior, = self.groups()
        self.store.set_preferences(0, DEFAULTS | {'max_weekly_hours': 20})
        self.assertEqual(self.groups()[0]['evaluation']['status'], 'excluded')
        changed = original | {'weekly_hours': 15, 'description': 'Different scope for the same listing',
                              'receipt_id': 'resend:two', 'received_at': (NOW + timedelta(days=2)).isoformat()}
        self.assertEqual(self.store.ingest_resend_batch([changed]), {'content_versions': 1})
        group, = self.groups()
        self.assertEqual(self.store.list()[0]['job']['weekly_hours'], 25)
        self.assertEqual(group['job']['weekly_hours'], 15)
        self.assertEqual(group['display_basis']['label'], '另一份通知內容')
        self.assertEqual(group['recommendation']['basis_fingerprint'],
                         next(version['fingerprint'] for version in group['content_conflicts'][0]['versions']
                              if version['job']['weekly_hours'] == 15))
        exposed = public_item(group)
        self.assertNotIn('receipt_id', exposed['job'])
        self.assertNotIn('evidence_ref', exposed['job'])
        for version in exposed['content_conflicts'][0]['versions']:
            self.assertNotIn('receipt_id', version['job'])
            self.assertNotIn('evidence_ref', version['job'])
        self.assertEqual(len(group['content_conflicts'][0]['versions']), 2)
        self.assertEqual(group['content_conflicts'][0]['changed_fields'], ['description', 'weekly_hours'])
        self.assertEqual({version['evaluation']['status'] for version in group['content_conflicts'][0]['versions']},
                         {'excluded', 'qualified'})
        self.assertNotEqual(self.versions(group), self.versions(prior))
        with self.assertRaises(Conflict):
            self.store.feedback(prior['id'], self.versions(prior), 'skipped')
        self.assertEqual(len(self.digest(2)['snapshot']['items']), 1)
        from freelance.modules.notifications.digest import render
        html = render([group], {}, mode='sqlite')
        self.assertIn('同職缺通知內容有差異', html)
        self.assertIn('另一份通知內容', html)
        self.assertIn('每週工時', html)
        self.assertIn('15', html)
        self.assertGreaterEqual(html.count(group['display_basis']['fingerprint'][:12]), 2)
        self.assertNotIn('private-mail-reference', html)
        self.sent(self.digest(2))
        self.assertEqual(self.digest(3)['snapshot']['items'], [])
        self.assertEqual(self.store.ingest_resend_batch([changed]), {'content_versions': 0})
        with self.store._connect(write=False) as conn:
            self.assertEqual(conn.execute('SELECT count(*) n FROM mail_content_versions').fetchone()['n'], 2)

    def test_mail_received_time_alone_does_not_create_another_version(self):
        original = job() | {'receipt_id': 'resend:one'}
        self.store.ingest_resend_batch([original])
        replay = original | {'receipt_id': 'resend:two', 'received_at': (NOW + timedelta(days=2)).isoformat()}
        self.assertEqual(self.store.ingest_resend_batch([replay]), {'content_versions': 0})
        with self.store._connect(write=False) as conn:
            self.assertEqual(conn.execute('SELECT count(*) n FROM mail_content_versions').fetchone()['n'], 0)

    def test_three_versions_keep_distinct_provenance_in_digest(self):
        original = job(weekly_hours=25) | {'receipt_id': 'resend:one'}
        self.store.ingest_resend_batch([original])
        for hours, receipt in ((15, 'resend:two'), (10, 'resend:three')):
            self.store.ingest_resend_batch([original | dict(weekly_hours=hours,
                description=f'Different scope requiring {hours} weekly hours', receipt_id=receipt)])
        self.store.set_preferences(0, DEFAULTS | {'max_weekly_hours': 20})
        group, = self.groups()
        conflict, = group['content_conflicts']
        self.assertEqual(len(conflict['versions']), 3)
        self.assertEqual(len({version['fingerprint'] for version in conflict['versions']}), 3)
        from freelance.modules.notifications.digest import render
        html = render([group], {}, mode='sqlite')
        for version in conflict['versions']:
            self.assertIn(version['fingerprint'][:12], html)
        self.assertGreaterEqual(html.count(group['display_basis']['fingerprint'][:12]), 2)
        self.assertEqual(self.store.list()[0]['job']['weekly_hours'], 25)
