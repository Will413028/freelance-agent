import io,json,tempfile
from pathlib import Path
from datetime import datetime,timezone
from unittest import TestCase
from unittest.mock import Mock
from freelance.modules.notifications.resend_delivery import build_payload, DeliveryClient, deliver
from freelance.bootstrap.store import SQLiteStore

class DeliveryTests(TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=SQLiteStore(Path(self.tmp.name)/'db');self.store.migrate()
        self.intent=self.store.create_digest(datetime(2026,9,20).date(),'self@example.com',datetime(2026,9,20,1,tzinfo=timezone.utc))
        self.client=Mock();self.client.send.return_value={'message_id':'accepted'}
    def test_production_payload_has_exact_sender_recipient(self):
        p=json.loads(build_payload(self.intent['snapshot'],'self@example.com','digest@mydomain.example'))
        self.assertEqual(p['from'],'digest@mydomain.example');self.assertEqual(p['to'],['self@example.com']);self.assertNotIn('測試',p['subject'])
    def test_test_and_receiving_domains_rejected(self):
        for sender in ['onboarding@resend.dev','a@x.resend.app','invalid','a@evil.com\nBcc:x@y.com']:
            with self.assertRaises(ValueError):build_payload(self.intent['snapshot'],'self@example.com',sender)
    def test_domain_preflight_before_claim(self):
        self.client.verify_sender.side_effect=ValueError()
        with self.assertRaises(ValueError):deliver(self.store,self.intent['id'],'self@example.com','digest@mydomain.example',lambda:self.client)
        self.assertEqual(self.store.get_digest(self.intent['id'])['status'],'pending');self.client.send.assert_not_called()
    def test_sent_once_unknown_no_retry(self):
        self.client.send.side_effect=TimeoutError()
        self.assertEqual(deliver(self.store,self.intent['id'],'self@example.com','digest@mydomain.example',lambda:self.client)['status'],'unknown')
        self.assertEqual(deliver(self.store,self.intent['id'],'self@example.com','digest@mydomain.example',lambda:self.client)['status'],'unknown')
        self.client.send.assert_called_once()
    def test_only_verified_enabled_exact_domain(self):
        for name,status,cap,ok in [('mydomain.example','verified','enabled',True),('evil.example','verified','enabled',False),('mydomain.example','pending','enabled',False),('mydomain.example','verified','disabled',False)]:
            response=io.BytesIO(json.dumps({'data':[{'name':name,'status':status,'capabilities':{'sending':cap}}]}).encode());response.status=200
            opener=Mock();opener.open.return_value=response
            c=DeliveryClient('re_synthetic',opener=opener,pause=lambda _:None)
            if ok:c.verify_sender('digest@mydomain.example')
            else:
                with self.assertRaises(Exception):c.verify_sender('digest@mydomain.example')
            self.assertEqual(opener.open.call_args.args[0].full_url,'https://api.resend.com/domains?limit=100')
