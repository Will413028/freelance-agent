from unittest import TestCase
from unittest.mock import Mock
from freelance.modules.collection.himalayas import normalize, sync


def listing(**changes):
    return dict(title='AI agent backend engineer', description='<p>Build AI agents and APIs</p>',
                employmentType='Contractor', locationRestrictions=[], timezoneRestrictions=[],
                pubDate=1789746632, expiryDate=1893456000,
                applicationLink='https://himalayas.app/companies/example/jobs/engineer',
                guid='https://himalayas.app/companies/example/jobs/engineer') | changes


class HimalayasTests(TestCase):
    def test_seconds_milliseconds_and_iso_dates(self):
        a=normalize(listing()); b=normalize(listing(pubDate=1789746632000))
        c=normalize(listing(pubDate=a['received_at']))
        self.assertEqual(a['received_at'], b['received_at'])
        self.assertEqual(a['received_at'], c['received_at'])
        self.assertIsNone(a['taiwan_eligible'])
        self.assertIsNone(a['weekly_hours'])
        self.assertIsNone(a['budget_min'])

    def test_country_and_timezone_restrictions(self):
        self.assertFalse(normalize(listing(locationRestrictions=[{'alpha2':'US','name':'United States'}]))['taiwan_eligible'])
        self.assertFalse(normalize(listing(timezoneRestrictions=[-5,0]))['timezone_compatible'])
        self.assertIsNone(normalize(listing(locationRestrictions=['Taiwan']))['taiwan_eligible'])

    def test_untrusted_url_missing_body_or_geo_rejected(self):
        for changes in ({'applicationLink':'https://evil.example/'}, {'description':''},
                        {'locationRestrictions':None}, {'pubDate':True}):
            with self.assertRaises(ValueError): normalize(listing(**changes))

    def test_fulltime_expired_and_wrong_country_not_imported(self):
        store=Mock()
        result=sync(store,reader=lambda:[listing(),listing(employmentType='Full Time'),
                    listing(expiryDate=1),listing(locationRestrictions=['United States'])])
        self.assertEqual(result['jobs'],1)
        store.ingest.assert_called_once()

    def test_malformed_batch_does_not_import_partial_results(self):
        store=Mock(); result=sync(store,reader=lambda:[listing(),listing(description='')])
        self.assertEqual(result['status'],'failed');store.ingest.assert_not_called()

    def test_repeat_sync_keeps_one_opportunity_and_revision(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from freelance.bootstrap.store import SQLiteStore
        with TemporaryDirectory() as directory:
            store=SQLiteStore(Path(directory)/'jobs.sqlite3');store.migrate()
            sync(store,reader=lambda:[listing()]);sync(store,reader=lambda:[listing()])
            rows=store.list()
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['version'],1)
