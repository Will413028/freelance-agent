"""Manual application behavior with real SQLite, without external delivery."""
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
import sqlite3
from freelance.bootstrap.store import SQLiteStore
from freelance.modules.discovery.public import group_items, is_candidate
from freelance.platform.errors import Conflict, InvalidAction
from fixtures.domain import job

NOW = datetime(2026, 9, 30, 1, tzinfo=timezone.utc)

class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = SQLiteStore(Path(self.tmp.name)/'app.db', clock=lambda: NOW)
        self.store.migrate()

    def command(self, **changes):
        return dict(request_id='test-request', title='Python API', contact='', url=None,
                    applied_on='2026-09-30', stage='applied', follow_up_on='2026-10-02',
                    note='本人填寫', versions={}, **changes)

    def create(self, command=None):
        return self.store.create_application(command or self.command())

    def test_manual_create_replay_and_changed_request_conflict(self):
        row = self.create()
        self.assertEqual(self.create()['id'], row['id'])
        changed = self.command(); changed['note'] = 'different'
        with self.assertRaises(Conflict): self.create(changed)
        self.assertEqual(self.store.list_applications()['total'], 1)
        self.assertEqual(len(self.store.list()), 0)

    def test_validation_dates_urls_and_revision(self):
        for key, value in [('applied_on','2026-10-01'), ('applied_on','2026-02-30'),
                           ('follow_up_on','2026-09-29'), ('stage','fake'), ('url','javascript:alert(1)'),
                           ('title',' '), ('note','x'*2001)]:
            command = self.command(); command[key] = value
            with self.subTest(key=key), self.assertRaises(InvalidAction): self.create(command)
        row = self.create()
        body = {key: row[key] for key in ('title','contact','url','applied_on','stage','follow_up_on','note','revision')}
        body['stage'] = 'negotiating'
        updated = self.store.update_application(row['id'], body)
        self.assertEqual(updated['revision'], 2)
        with self.assertRaises(Conflict): self.store.update_application(row['id'], body)
        body['revision'] = True
        with self.assertRaises(Conflict): self.store.update_application(row['id'], body)

    def test_group_link_exclusion_tokens_and_snapshot_immutability(self):
        first = self.store.ingest(job())
        self.store.ingest(job(source='tasker', external_id='copy', url=first['job']['url']))
        group, = group_items(self.store.list())
        tokens = {m['id']:m['token'] for m in group['members']}
        old = self.store.create_digest('2026-09-30','owner@example.test',NOW)
        command = self.command(); command['versions'] = tokens
        row = self.create(command)
        self.assertEqual(len(row['opportunity_ids']), 2)
        self.assertFalse(is_candidate(group_items(self.store.list())[0]))
        self.assertEqual(self.store.create_digest('2026-10-01','owner@example.test',NOW)['snapshot']['items'], [])
        self.assertEqual(self.store.get_digest(old['id'])['snapshot'], old['snapshot'])
        with self.assertRaises(Conflict): self.store.feedback(group['id'],tokens,'skipped')
        self.store.delete_application(row['id'], row['revision'])
        self.assertTrue(is_candidate(group_items(self.store.list())[0]))
        with self.assertRaises(Conflict): self.store.feedback(group['id'],tokens,'skipped')
        self.assertEqual(self.store.list_applications()['total'],0)

    def test_stale_members_and_duplicate_link_are_rejected(self):
        first = self.store.ingest(job())
        group, = group_items(self.store.list())
        command = self.command(); command['versions'] = {m['id']:m['token'] for m in group['members']}
        self.store.ingest(job(source='tasker',external_id='copy',url=first['job']['url']))
        with self.assertRaises(Conflict): self.create(command)
        group, = group_items(self.store.list())
        command['versions'] = {m['id']:m['token'] for m in group['members']}
        self.create(command)
        group, = group_items(self.store.list())
        command['request_id']='second'
        command['versions']={m['id']:m['token'] for m in group['members']}
        with self.assertRaises(Conflict): self.create(command)

    def test_event_failure_rolls_back_entire_create(self):
        self.store.ingest(job())
        group,=group_items(self.store.list())
        command=self.command();command['versions']={m['id']:m['token'] for m in group['members']}
        with self.store.database.connect() as conn:
            conn.execute("CREATE TRIGGER fail_event BEFORE INSERT ON manual_application_events BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError): self.create(command)
        self.assertEqual(self.store.list_applications()['total'],0)
        with self.store.database.connect(write=False) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM manual_application_opportunities').fetchone()['n'],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM manual_application_events').fetchone()['n'],0)

    def test_week_counts_due_closed_and_deleted(self):
        row = self.create()
        self.assertEqual(self.store.application_summary()['weekly_count'],1)
        second = self.command(); second.update(request_id='last-week',applied_on='2026-09-27',follow_up_on='2026-09-28')
        old = self.create(second)
        summary = self.store.application_summary()
        self.assertEqual((summary['weekly_count'],summary['due_count'],summary['overdue_count']),(1,1,1))
        body={k:old[k] for k in ('title','contact','url','applied_on','stage','follow_up_on','note','revision')}
        body['stage']='closed'
        self.store.update_application(old['id'],body)
        self.assertEqual(self.store.application_summary()['due_count'],0)
        self.store.delete_application(row['id'],row['revision'])
        self.assertEqual(self.store.application_summary()['weekly_count'],0)

    def test_migration_idempotent_preserves_rows_and_events(self):
        row=self.create()
        self.store.migrate(); self.store.migrate()
        self.assertEqual(self.store.list_applications()['items'][0]['id'],row['id'])
        with self.store.database.connect(write=False) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM manual_application_events').fetchone()['n'],1)
            self.assertEqual(list(conn.execute('PRAGMA foreign_key_check')),[])

    def test_timezone_week_boundary_and_due_closed_counts(self):
        current=[datetime(2026,10,4,16,1,tzinfo=timezone.utc)]
        self.store.database.clock=lambda:current[0]
        monday=self.command(); monday.update(applied_on='2026-10-05',follow_up_on='2026-10-05')
        self.create(monday)
        sunday=self.command(); sunday.update(request_id='sunday',applied_on='2026-10-04',follow_up_on='2026-10-04')
        self.create(sunday)
        summary=self.store.application_summary()
        self.assertEqual((summary['week_start'],summary['today'],summary['weekly_count']),('2026-10-05','2026-10-05',1))
        self.assertEqual((summary['due_count'],summary['overdue_count']),(2,1))
        self.assertEqual(self.store.list_applications(due=True)['total'],2)
        self.assertEqual(len(self.store.list_applications(limit=1,offset=1)['items']),1)

    def test_versions_later_duplicates_and_legacy_skip_remain_suppressed(self):
        item=self.store.ingest(job())
        group,=group_items(self.store.list())
        command=self.command(); command['versions']={m['id']:m['token'] for m in group['members']}
        row=self.create(command)
        self.store.ingest_resend_batch([job()|dict(receipt_id='new-content',description='Different Python API scope')])
        self.store.ingest(job(source='tasker',external_id='later',url=item['job']['url']))
        self.assertFalse(is_candidate(group_items(self.store.list())[0]))
        current=next(g for g in group_items(self.store.list()) if item['id'] in g['member_ids'])
        self.store.feedback(current['id'],{m['id']:m['token'] for m in current['members']},'skipped')
        self.store.delete_application(row['id'],row['revision'])
        self.assertFalse(is_candidate(group_items(self.store.list())[0]))
        self.assertTrue(self.store.get_digest(self.store.create_digest('2026-10-02','owner@example.test',NOW)['id'])['snapshot']['items']==[])

    def test_delete_keeps_request_id_and_does_not_resurrect(self):
        row=self.create()
        self.store.delete_application(row['id'],row['revision'])
        replay=self.create()
        self.assertIsNotNone(replay['deleted_at'])
        self.assertEqual(self.store.list_applications()['total'],0)
        with self.assertRaises(KeyError):self.store.get_application(row['id'])

    def test_due_list_orders_oldest_follow_up_first(self):
        recent=self.command();recent.update(request_id='recent',applied_on='2026-09-29',follow_up_on='2026-09-30')
        old=self.command();old.update(request_id='old',applied_on='2026-09-28',follow_up_on='2026-09-29')
        first=self.create(recent);second=self.create(old)
        self.assertEqual([r['id'] for r in self.store.list_applications(due=True)['items']],[second['id'],first['id']])
