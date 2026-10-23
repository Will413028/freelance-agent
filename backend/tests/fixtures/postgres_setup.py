import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from freelance.legacy.review import Conflict, InvalidAction
from fixtures.domain import job
DSN = os.environ.get('FREELANCE_TEST_DSN')
if DSN:
    import psycopg
    from psycopg.conninfo import make_conninfo
    from freelance.legacy.postgres import PostgresStore
    from freelance.modules.notifications.scheduler import daily_tick, dispatch
NOW = datetime(2026, 9, 17, 1, tzinfo=timezone.utc)

class PostgresTestsFixture:
    def setUp(self):
        self.schema = 'test_' + uuid.uuid4().hex
        with psycopg.connect(DSN) as conn:
            conn.execute(f'CREATE SCHEMA {self.schema}')
        self.dsn = make_conninfo(DSN, options=f'-c search_path={self.schema}')
        self.store = PostgresStore(self.dsn, clock=lambda: NOW)
        self.store.migrate()

    def tearDown(self):
        with psycopg.connect(DSN) as conn:
            conn.execute(f'DROP SCHEMA {self.schema} CASCADE')
