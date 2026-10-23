from fixtures.daily import NOW
import freelance.bootstrap.daily_cli as daily_command
import contextlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from freelance.bootstrap.store import SQLiteStore
import freelance.modules.notifications.daily as daily
from fixtures.gmail import Client, mail

class DailyTestsFixture:
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.root=Path(self.directory.name)
        self.store=SQLiteStore(self.root/'daily.sqlite3');self.store.migrate()
        self.calls=[]

    def tearDown(self):self.directory.cleanup()

    @contextlib.contextmanager
    def client(self):
        self.calls.append('opened')
        yield Client({None:{'messages':[{'id':'a'}]}},{'a':mail('a')})

    def run_daily(self,**kwargs):
        return daily.run_daily(self.store,self.client,recipient='test@example.invalid',output_dir=self.root,now=NOW,**kwargs)
