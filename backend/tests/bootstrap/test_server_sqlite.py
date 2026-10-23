"""Real HTTP + temporary SQLite; no mailbox or external delivery."""
import json
import os
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import tempfile
from pathlib import Path

from freelance.bootstrap.api import create_server
from fixtures.domain import job

class SQLiteServerTests(unittest.TestCase):
    def test_http_feedback_survives_restart_and_reports_current_source_health(self):
        from freelance.bootstrap.store import SQLiteStore
        directory=tempfile.TemporaryDirectory()
        dsn=Path(directory.name)/'review.sqlite3'
        store=SQLiteStore(dsn);store.migrate()
        item=store.ingest(job(),receipt_id='synthetic-receipt')
        def request(httpd,path,body=None):
            req=Request(f'http://127.0.0.1:{httpd.server_port}'+path,
                        data=None if body is None else json.dumps(body).encode(),
                        headers={'Origin':'http://127.0.0.1:3327','Content-Type':'application/json'})
            try:
                with urlopen(req,timeout=3) as response:return response.status,response.read()
            except HTTPError as e:
                with e:return e.code,e.read()
        try:
            for restart in (False,True):
                httpd=create_server(port=0,store=SQLiteStore(dsn),mode='sqlite',intake_enabled=True)
                thread=Thread(target=httpd.serve_forever,daemon=True);thread.start()
                try:
                    status,raw=request(httpd,'/dashboard');data=json.loads(raw)
                    self.assertEqual(status,200);self.assertEqual(data['mode'],'sqlite')
                    self.assertFalse(data['schedule_enabled'])
                    self.assertTrue(data['intake_enabled'])
                    self.assertIsNone(data['operations']['last_run'])
                    if restart:
                        self.assertIsNotNone(data['operations']['sources']['tasker']['checked_at'])
                    else:
                        self.assertIsNone(data['operations']['sources']['tasker']['checked_at'])
                    self.assertEqual(len(data['items']),1)
                    if restart:
                        self.assertEqual(data['items'][0]['tracking']['feedback'],'interested')
                        self.assertNotIn('proposal',data['items'][0])
                        status,_=request(httpd,'/feedback/'+item['id'],{'feedback':'neutral','versions':{item['id']:item['fingerprint']+':0'}})
                        self.assertEqual(status,409)
                    else:
                        status,_=request(httpd,'/feedback/'+item['id'],{'feedback':'interested','versions':{item['id']:item['fingerprint']+':0'}})
                        self.assertEqual(status,200)
                        store.set_source_health('tasker','failed')
                        _,raw=request(httpd,'/dashboard')
                        self.assertEqual(json.loads(raw)['sources']['tasker'],'failed')
                        _,raw=request(httpd,'/digest')
                        self.assertNotIn('合成案件',raw.decode())
                        self.assertIn('尚未寄出',raw.decode())
                finally:httpd.shutdown();httpd.server_close();thread.join()
        finally:
            directory.cleanup()
