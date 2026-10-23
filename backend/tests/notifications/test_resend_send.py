import freelance.bootstrap.resend_send_cli as resend_send_command
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import freelance.modules.notifications.resend_send as rs
from freelance.bootstrap.store import SQLiteStore
MAIL='self@example.com'
NOW=datetime(2026,9,18,1,tzinfo=timezone.utc)
class SendTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=SQLiteStore(Path(self.temp.name)/'db');self.store.migrate()
        self.intent=self.store.create_digest(NOW.date(),MAIL,NOW)
        self.raw=rs.build_payload(self.intent['snapshot'],MAIL);self.sha=hashlib.sha256(self.raw).hexdigest()
        self.client=Mock();self.client.send.return_value={'message_id':'abc'};self.factory=Mock(return_value=self.client)
    def send(self,digest=None):return rs.send_intent(self.store,self.intent['id'],MAIL,digest or self.sha,self.factory)
    def test_preview_deterministic_self_only(self):
        self.assertEqual(self.raw,rs.build_payload(self.intent['snapshot'],MAIL))
        p=json.loads(self.raw);self.assertEqual(p['to'],[MAIL]);self.assertEqual(p['from'],'onboarding@resend.dev')
        self.assertEqual(set(p),{'from','to','subject','html'});self.assertIn('測試',p['subject'])
        with self.assertRaises(ValueError):rs.build_payload(self.intent['snapshot'],'other@example.com')
    def test_hash_mismatch_before_key_and_claim(self):
        with self.assertRaises(ValueError):self.send('0'*64)
        self.factory.assert_not_called();self.assertEqual(self.store.get_digest(self.intent['id'])['status'],'pending')
    def test_once_and_restart(self):
        self.assertEqual(self.send()['status'],'sent');self.assertEqual(self.send()['status'],'sent')
        self.client.send.assert_called_once();self.factory.assert_called_once()
    def test_timeout_never_retry(self):
        self.client.send.side_effect=TimeoutError()
        self.assertEqual(self.send()['status'],'unknown');self.assertEqual(self.send()['status'],'unknown');self.client.send.assert_called_once()
    def test_missing_receipt_unknown(self):
        self.client.send.return_value={};self.assertEqual(self.send()['status'],'unknown')
    def test_key_failure_before_claim(self):
        self.factory.side_effect=ValueError()
        with self.assertRaises(ValueError):self.send()
        self.assertEqual(self.store.get_digest(self.intent['id'])['status'],'pending')
    def test_http_exact_endpoint_and_idempotency(self):
        response=io.BytesIO(b'{"id":"4ef9a417-02e9-4d39-ad75-9611e0fcc33c"}');response.status=200
        opener=Mock();opener.open.return_value=response
        result=rs.SendingClient('re_synthetic',opener=opener).send(self.raw,self.intent['id']);self.assertIn('message_id',result)
        request=opener.open.call_args.args[0];self.assertEqual(request.full_url,'https://api.resend.com/emails');self.assertEqual(request.method,'POST')
        self.assertEqual(request.data,self.raw);self.assertTrue(request.get_header('Idempotency-key'));self.assertEqual(opener.open.call_args.kwargs['timeout'],20)
    def test_http_failure_fixed_and_once(self):
        opener=Mock();opener.open.side_effect=RuntimeError('SECRET')
        with self.assertRaisesRegex(rs.SendError,'Resend delivery unavailable'):rs.SendingClient('re_synthetic',opener=opener).send(self.raw,self.intent['id'])
        opener.open.assert_called_once()
    def test_cli_no_live_flag(self):
        with self.assertRaises(SystemExit):resend_send_command.main(['--database','missing','--intent-id','missing','--recipient',MAIL,'--send','--key-file','missing','--expected-sha256',self.sha])

    def test_parallel_claim_sends_once(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.send(),range(2)))
        self.client.send.assert_called_once()
        self.assertEqual(self.store.get_digest(self.intent['id'])['status'],'sent')
    def test_http_missing_or_oversize_receipt_rejected(self):
        for content in (b'{}',b'x'*65537):
            response=io.BytesIO(content);response.status=200
            opener=Mock();opener.open.return_value=response
            with self.assertRaises(rs.SendError):rs.SendingClient('re_synthetic',opener=opener).send(self.raw,self.intent['id'])
