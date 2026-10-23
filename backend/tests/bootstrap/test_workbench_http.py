"""New workbench routes and boundary/DTO behavior using temporary SQLite."""
from datetime import datetime,timezone
from pathlib import Path
import tempfile
import unittest
from fastapi.testclient import TestClient
from freelance.bootstrap.store import SQLiteStore
from freelance.bootstrap.http import create_app


class WorkbenchHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=SQLiteStore(Path(self.tmp.name)/'app.sqlite',clock=lambda:datetime(2026,10,1,tzinfo=timezone.utc));self.store.migrate()
        self.client=TestClient(create_app(self.store,mode='sqlite'),base_url='http://127.0.0.1:8327',raise_server_exceptions=False)
        self.addCleanup(self.client.close);self.headers={'Origin':'http://127.0.0.1:3327'}

    def post(self,path,body):
        response=self.client.post(path,json=body,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text);return response.json()

    def test_client_contact_and_party_contracts(self):
        body=dict(request_id='client',name='合成客戶',note='私有備註')
        self.assertEqual(self.client.post('/clients',json=body).status_code,403)
        row=self.post('/clients',body)
        self.assertNotIn('request_payload',row)
        contact=self.post('/contacts',dict(request_id='contact',client_id=row['id'],client_revision=1,name='合成聯絡人',address='person@example.test',note=''))
        self.assertEqual(self.client.get(f"/clients/{row['id']}/contacts").json()['total'],1)
        self.assertEqual(self.client.get('/clients?limit=0').status_code,400)
        self.assertEqual(self.client.patch('/clients/'+row['id'],json=dict(revision=1,name='更新',note=''),headers=self.headers).status_code,200)
        self.assertEqual(self.client.patch('/clients/'+row['id'],json=dict(revision=1,name='過期',note=''),headers=self.headers).status_code,409)
        self.assertEqual(self.client.get('/contacts/'+contact['id']).status_code,200)
        self.assertNotIn('私有備註',self.client.get('/dashboard').text)

    def test_template_draft_submission_and_disabled_dispatch(self):
        template=self.post('/proposal-templates',dict(request_id='template',name='合成模板',body='Hi {client_name}'))
        draft=self.post('/proposals',dict(request_id='draft',title='合成稿',body=None,template_id=template['id'],template_revision=1,values={'client_name':'合成客戶'},versions={},party=None))
        self.assertEqual(draft['versions'][0]['body'],'Hi 合成客戶')
        self.assertEqual(self.client.get('/proposals/'+draft['id']).status_code,200)
        intent=self.post('/submissions',dict(request_id='intent',draft_id=draft['id'],draft_version=1,provider='email',environment='live',account='sender@example.test',fields={'from':'sender@example.test','to':'recipient@example.test','subject':'合成'}))
        approved=self.post('/submissions/'+intent['id']+'/approve',dict(revision=1,snapshot_hash=intent['snapshot_hash']))
        result=self.client.post('/submissions/'+intent['id']+'/dispatch',json={'revision':approved['revision']},headers=self.headers)
        self.assertEqual(result.status_code,409)
        self.assertEqual(self.client.get('/submissions/'+intent['id']).json()['status'],'approved')
        self.assertEqual(self.client.get('/submission-capabilities').json()['email']['status'],'not_configured')
        self.assertEqual(self.client.get('/submission-capabilities').json()['freelancer']['status'],'not_configured')

    def test_strict_commands_and_no_secrets_in_error(self):
        self.assertEqual(self.client.post('/clients',json=dict(request_id='client',name='合成',note='',token='PRIVATE'),headers=self.headers).status_code,400)
        self.assertEqual(self.client.get('/proposals/missing').status_code,404)
        self.assertEqual(self.client.post('/proposal-templates',json=dict(request_id='template',name='合成',body='{client_name.__class__}'),headers=self.headers).status_code,400)
