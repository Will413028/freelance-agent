import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from freelance.bootstrap.api import create_server
from freelance.bootstrap.store import SQLiteStore
from fixtures.domain import job

class TrackingHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store=SQLiteStore(Path(self.tmp.name)/'cases.db'); self.store.migrate()
        self.item=self.store.ingest(job())
        self.token=self.item['fingerprint']+':'
        self.httpd=create_server(0,self.store,mode='sqlite')
        self.thread=Thread(target=self.httpd.serve_forever,daemon=True); self.thread.start()
    def tearDown(self):
        self.httpd.shutdown();self.httpd.server_close();self.thread.join()
    def request(self,path,body=None,origin='http://127.0.0.1:3327'):
        request=Request(f'http://127.0.0.1:{self.httpd.server_port}'+path,
                        data=json.dumps(body).encode() if body is not None else None,
                        headers={'Origin':origin,'Content-Type':'application/json'})
        try:
            with urlopen(request,timeout=3) as response:return response.status,response.read()
        except HTTPError as error:
            with error:return error.code,error.read()
    def test_discovery_feedback_roundtrip_and_digest(self):
        path='/feedback/'+self.item['id']
        self.assertEqual(self.request(path,{'versions':{self.item['id']:self.token+'0'},'feedback':'interested'})[0],200)
        self.assertEqual(self.request(path,{'versions':{self.item['id']:self.token+'0'},'feedback':'neutral'})[0],409)
        self.assertEqual(self.request(path,{'versions':{self.item['id']:self.token+'1'},'feedback':'skipped'})[0],200)
        _,raw=self.request('/dashboard'); dashboard=json.loads(raw)
        self.assertTrue(dashboard['capabilities']['discovery'])
        self.assertNotIn('tracking_summary', dashboard)
        self.assertNotIn('proposal', dashboard['items'][0])
        self.assertEqual(dashboard['items'][0]['tracking']['revision'],2)
        _,html=self.request('/digest');self.assertNotIn('AI agent workflow',html.decode())
    def test_bad_origin_json_and_unknown_fields_never_mutate(self):
        path='/feedback/'+self.item['id']
        self.assertEqual(self.request(path,{'versions':{self.item['id']:self.token+'0'},'feedback':'interested'},'https://bad.invalid')[0],403)
        self.assertEqual(self.request(path,[])[0],400)
        self.assertEqual(self.request(path,{'versions':{self.item['id']:self.token+'0'},'feedback':'interested','send':True})[0],400)
        self.assertEqual(self.store.list()[0]['tracking']['revision'],0)
