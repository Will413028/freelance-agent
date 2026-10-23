import hashlib,tempfile,json
from pathlib import Path
from datetime import datetime,timezone
from unittest import TestCase
from unittest.mock import Mock,patch
from freelance.modules.notifications.gmail_smtp import deliver, open_client
from freelance.modules.notifications.gmail_send import build_message
from freelance.bootstrap.store import SQLiteStore
class SMTPTests(TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.path=Path(self.tmp.name)
        self.store=SQLiteStore(self.path/'db');self.store.migrate()
        self.mail='self@gmail.com';now=datetime(2026,9,20,1,tzinfo=timezone.utc)
        self.intent=self.store.create_digest(now.date(),self.mail,now)
        self.raw=build_message(self.intent['snapshot'],self.intent['id'],self.mail)
        self.sha=hashlib.sha256(self.raw).hexdigest();self.client=Mock();self.client.sendmail.return_value={};self.factory=Mock(return_value=self.client)
    def call(self,sha=None):return deliver(self.store,self.intent['id'],self.mail,sha or self.sha,self.factory)
    def test_exact_self_only_and_once(self):
        self.assertEqual(self.call()['status'],'sent');self.call();self.client.sendmail.assert_called_once_with(self.mail,[self.mail],self.raw)
    def test_hash_mismatch_before_login(self):
        with self.assertRaises(ValueError):self.call('0'*64)
        self.factory.assert_not_called()
    def test_timeout_never_retries(self):
        self.client.sendmail.side_effect=TimeoutError()
        self.assertEqual(self.call()['status'],'unknown');self.call();self.client.sendmail.assert_called_once()
    def test_auth_failure_preserves_pending(self):
        self.factory.side_effect=ValueError()
        with self.assertRaises(ValueError):self.call()
        self.assertEqual(self.store.get_digest(self.intent['id'])['status'],'pending')
    def test_private_config_and_tls_login(self):
        p=self.path/'smtp.json';p.write_text(json.dumps({'email':self.mail,'app_password':'abcdefghijklmnop'}));p.chmod(0o600)
        with patch('freelance.platform.gmail_smtp.smtplib.SMTP_SSL') as smtp:
            open_client(p,self.mail);smtp.assert_called_once();self.assertEqual(smtp.call_args.args,('smtp.gmail.com',465));self.assertEqual(smtp.call_args.kwargs['timeout'],20)
            smtp.return_value.login.assert_called_once_with(self.mail,'abcdefghijklmnop')
        p.chmod(0o644)
        with self.assertRaises(Exception):open_client(p,self.mail)
