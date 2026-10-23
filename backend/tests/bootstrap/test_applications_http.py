from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from fastapi.testclient import TestClient
from freelance.bootstrap.http import create_app
from freelance.bootstrap.store import SQLiteStore
from fixtures.domain import job

class ApplicationHTTPTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.store=SQLiteStore(Path(temp.name)/'app.db',clock=lambda:datetime(2026,9,30,1,tzinfo=timezone.utc))
        self.store.migrate(); self.store.ingest(job())
        self.client=TestClient(create_app(self.store,mode='sqlite'),base_url='http://127.0.0.1:8327',raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.headers={'Origin':'http://127.0.0.1:3327'}
        self.body=dict(request_id='http-test',title='API',contact='PRIVATE CONTACT',url=None,applied_on='2026-09-30',
                       stage='applied',follow_up_on=None,note='PRIVATE NOTE',versions={})

    def test_create_update_delete_and_strict_boundary(self):
        self.assertEqual(self.client.post('/applications',json=self.body).status_code,403)
        for change in ({'send':True},{'applied_on':'2099-01-01'},{'versions':{'fake':'bad'}}):
            self.assertIn(self.client.post('/applications',json=self.body|change,headers=self.headers).status_code,(400,404))
        response=self.client.post('/applications',json=self.body,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text); row=response.json()
        self.assertEqual(self.client.post('/applications',json=self.body,headers=self.headers).json()['id'],row['id'])
        body={k:row[k] for k in ('title','contact','url','applied_on','stage','follow_up_on','note','revision')}
        body['stage']='won'
        self.assertEqual(self.client.patch('/applications/'+row['id'],json=body).status_code,403)
        self.assertEqual(self.client.patch('/applications/'+row['id'],json=body,headers=self.headers).status_code,200)
        self.assertEqual(self.client.patch('/applications/'+row['id'],json=body,headers=self.headers).status_code,409)
        self.assertEqual(self.client.request('DELETE','/applications/'+row['id'],json={'revision':2}).status_code,403)
        self.assertEqual(self.client.request('DELETE','/applications/'+row['id'],json={'revision':2},headers=self.headers).status_code,200)
        self.assertEqual(self.client.get('/applications').json()['total'],0)
        self.assertEqual(self.client.get('/applications/summary').json()['weekly_count'],0)

    def test_linked_status_no_private_fields_and_filters(self):
        item=self.client.get('/dashboard').json()['items'][0]
        body=self.body|{'versions':{m['id']:m['token'] for m in item['members']}}
        response=self.client.post('/applications',json=body,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        dash=self.client.get('/dashboard')
        self.assertFalse(dash.json()['items'][0]['candidate'])
        self.assertEqual(dash.json()['items'][0]['application_ids'],[response.json()['id']])
        self.assertNotIn('PRIVATE',dash.text)
        self.assertNotIn('PRIVATE',self.client.get('/digest').text)
        self.assertEqual(self.client.get('/applications?stage=closed').json()['total'],0)
        self.assertEqual(self.client.get('/applications?limit=0').status_code,400)
        self.assertEqual(self.client.get('/applications?stage=unknown').status_code,400)
