"""Client/contact identity, history and stale edits on real SQLite."""
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from uuid import UUID

from freelance.platform.sqlite import Database
from freelance.platform.errors import Conflict, InvalidAction
from freelance.modules.relationships.public import Relationships
from freelance.bootstrap.store import SQLiteStore
import sqlite3


class RelationshipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Database(Path(self.tmp.name) / 'test.sqlite', clock=lambda: datetime(2026,10,1,tzinfo=timezone.utc))
        self.db.migrate()
        self.service = Relationships(self.db)

    def client(self, request='client', name='合成客戶'):
        return self.service.create_client(dict(request_id=request, name=name, note='合成備註'))

    def contact(self, client, request='contact'):
        return self.service.create_contact(dict(request_id=request, client_id=client['id'],
            client_revision=client['revision'], name='合成聯絡人', address='person@example.test', note=''))

    def test_clients_same_name_distinct_uuid_and_exact_replay(self):
        first = self.client()
        self.assertEqual(str(UUID(first['id'])), first['id'])
        self.assertEqual(self.client()['id'], first['id'])
        self.assertNotEqual(self.client('other')['id'], first['id'])
        with self.assertRaises(Conflict): self.client(name='改名')
        self.assertEqual(self.service.list_clients()['total'],2)
        self.assertNotIn('request_payload', first)

    def test_client_update_archive_and_stale_edits(self):
        first = self.client()
        command = dict(revision=1,name='更正客戶',note='備註')
        updated = self.service.update_client(first['id'],command)
        self.assertEqual((updated['revision'],updated['name']),(2,'更正客戶'))
        with self.assertRaises(Conflict): self.service.update_client(first['id'],command)
        with self.assertRaises(Conflict): self.service.archive_client(first['id'],True)
        archived = self.service.archive_client(first['id'],2)
        self.assertIsNotNone(archived['archived_at'])
        self.assertEqual(self.service.list_clients()['total'],0)
        self.assertEqual(self.service.list_clients(include_archived=True)['total'],1)
        self.assertEqual(self.service.get_client(first['id'])['name'],'更正客戶')
        self.assertEqual(self.client()['id'],first['id'])
        with self.assertRaises(Conflict): self.service.update_client(first['id'],dict(revision=3,name='復活',note=''))

    def test_contacts_replay_validation_client_revision_and_archive(self):
        client = self.client()
        contact = self.contact(client)
        self.assertEqual(self.contact(client)['id'],contact['id'])
        self.service.update_client(client['id'],dict(revision=1,name='更名',note=''))
        self.assertEqual(self.contact(client)['id'],contact['id'])
        with self.assertRaises(Conflict): self.contact(client,'stale')
        current = self.service.get_client(client['id'])
        self.service.archive_client(client['id'],current['revision'])
        with self.assertRaises(Conflict): self.contact(self.service.get_client(client['id']),'archived')
        self.assertEqual(self.service.list_contacts(client['id'])['items'][0]['id'],contact['id'])
        self.assertEqual(self.service.archive_contact(contact['id'],1)['revision'],2)
        self.assertEqual(self.service.list_contacts(client['id'])['total'],0)

    def test_contact_updates_keep_owner_and_stale_guard(self):
        client = self.client()
        row = self.contact(client)
        command = dict(revision=1,name='修正',address='',note='非email也可')
        updated = self.service.update_contact(row['id'],command)
        self.assertEqual(updated['client_id'],client['id'])
        self.assertEqual(updated['address'],'')
        with self.assertRaises(Conflict): self.service.update_contact(row['id'],command)
        with self.assertRaises(InvalidAction): self.service.update_contact(row['id'],dict(command,revision=2,client_id='other'))

    def test_snapshot_rejects_other_client_stale_and_archived(self):
        first = self.client()
        other = self.client('other')
        contact = self.contact(first)
        selection = dict(client_id=first['id'],client_revision=1,contact_id=contact['id'],contact_revision=1)
        with self.db.connect() as conn:
            snapshot = self.service.selection_in(conn,selection)
            self.assertEqual(snapshot['client_name'],first['name'])
            with self.assertRaises(Conflict): self.service.selection_in(conn,dict(selection,client_id=other['id']))
            with self.assertRaises(Conflict): self.service.selection_in(conn,dict(selection,contact_revision=2))
        self.service.archive_contact(contact['id'],1)
        with self.db.connect() as conn:
            with self.assertRaises(Conflict): self.service.selection_in(conn,dict(selection,contact_revision=2))

    def test_empty_selection_and_contact_without_client(self):
        with self.db.connect() as conn:
            self.assertIsNone(self.service.selection_in(conn,dict(client_id=None,client_revision=None,contact_id=None,contact_revision=None)))
            with self.assertRaises(InvalidAction): self.service.selection_in(conn,dict(client_id=None,contact_id='missing',contact_revision=1))

    def test_limits_invalid_pages_unknown_fields_and_missing_entities(self):
        for changes in (dict(name=' '),dict(name='x'*201),dict(note='x'*2001),dict(request_id=''),dict(extra=True)):
            with self.subTest(changes=changes),self.assertRaises(InvalidAction):
                self.service.create_client(dict(request_id='invalid',name='ok',note='',**{k:v for k,v in changes.items() if k not in ('request_id','name','note')}) | changes)
        for options in (dict(limit=101),dict(offset=-1),dict(include_archived='yes'),dict(limit=True)):
            with self.subTest(options=options),self.assertRaises(InvalidAction): self.service.list_clients(**options)
        with self.assertRaises(KeyError): self.service.get_client('missing')
        with self.assertRaises(KeyError): self.service.list_contacts('missing')

    def test_pagination_repeated_migrate_and_read_only(self):
        first = self.client('first','A')
        self.client('second','B')
        self.assertEqual(self.service.list_clients(limit=1,offset=1)['items'][0]['name'],'B')
        self.contact(first)
        self.db.migrate();self.db.migrate()
        with self.db.connect(write=False) as conn:
            before=conn.total_changes
            self.assertEqual(self.service.selection_in(conn,dict(client_id=first['id'],client_revision=1,contact_id=None,contact_revision=None))['client_name'],'A')
            self.assertEqual(conn.total_changes,before)
            self.assertEqual(list(conn.execute('PRAGMA foreign_key_check')),[])
        self.assertEqual(self.service.list_contacts(first['id'])['total'],1)

    def application(self):
        store=SQLiteStore(self.db.path,database=self.db)
        row=store.create_application(dict(request_id='application',title='合成案',contact='歷史文字',url=None,
            applied_on='2026-10-01',stage='applied',follow_up_on=None,note='',versions={}))
        return store,row

    def test_application_party_snapshot_revision_and_client_filter(self):
        client=self.client();contact=self.contact(client);store,application=self.application()
        selection=dict(revision=1,client_id=client['id'],client_revision=1,contact_id=contact['id'],contact_revision=1)
        linked=store.set_application_party(application['id'],selection)
        self.assertEqual((linked['revision'],linked['contact']),(2,'歷史文字'))
        self.service.update_client(client['id'],dict(revision=1,name='新名稱',note=''))
        self.assertEqual(store.get_application(application['id'])['party']['client_name'],'合成客戶')
        self.assertEqual(store.list_applications(client_id=client['id'])['total'],1)
        self.assertEqual(store.list_applications(client_id=self.client('another')['id'])['total'],0)
        with self.assertRaises(Conflict):store.set_application_party(application['id'],selection)
        cleared=store.set_application_party(application['id'],dict(revision=2,client_id=None,client_revision=None,contact_id=None,contact_revision=None))
        self.assertIsNone(cleared['party'])
        self.assertEqual(store.list_applications(client_id=client['id'])['total'],0)
        with self.db.connect(write=False) as conn:
            states=[__import__('json').loads(r['state']) for r in conn.execute('SELECT state FROM manual_application_events ORDER BY revision')]
            self.assertEqual(states[1]['party']['client_name'],'合成客戶')

    def test_application_party_event_failure_rolls_back(self):
        client=self.client();store,application=self.application()
        with self.db.connect() as conn:
            conn.execute("CREATE TRIGGER fail_party_event BEFORE INSERT ON manual_application_events BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            store.set_application_party(application['id'],dict(revision=1,client_id=client['id'],client_revision=1,contact_id=None,contact_revision=None))
        self.assertEqual(store.get_application(application['id'])['revision'],1)
        self.assertIsNone(store.get_application(application['id'])['party'])
