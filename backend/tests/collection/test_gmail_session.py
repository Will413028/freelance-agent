import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import freelance.modules.collection.gmail_session as gmail_session


SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'


class GmailSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'token.json'
        self.data = {
            'token': 'synthetic-access', 'refresh_token': 'synthetic-refresh',
            'client_id': 'synthetic-client', 'client_secret': 'synthetic-secret',
            'token_uri': 'https://oauth2.googleapis.com/token',
            'scopes': [SCOPE],
        }
        self.write_token()
        self.calls = []

    def write_token(self, data=None):
        self.path.write_text(json.dumps(self.data if data is None else data))
        self.path.chmod(0o600)

    def open(self):
        def credentials_factory(data):
            self.calls.append(('credentials', data))
            return 'credentials'

        def session_factory(credentials, **kwargs):
            self.calls.append(('session', credentials, kwargs))
            return 'session'

        return gmail_session.open_session(
            self.path, credentials_factory=credentials_factory,
            session_factory=session_factory)

    def assert_rejected(self):
        with self.assertRaises(gmail_session.GmailSessionError) as caught:
            self.open()
        self.assertEqual(self.calls, [])
        self.assertNotIn('synthetic', str(caught.exception))

    def test_valid_private_token_creates_bounded_session_without_request(self):
        self.assertEqual(self.open(), 'session')
        self.assertEqual(self.calls, [
            ('credentials', self.data),
            ('session', 'credentials', {'max_refresh_attempts': 0, 'refresh_timeout': 20}),
        ])

    def test_send_session_requires_exact_combined_scopes_and_read_rejects_them(self):
        def create(data): return 'credentials'
        def session(credentials,**kwargs): return 'send session'
        with self.assertRaises(gmail_session.GmailSessionError):
            gmail_session.open_session(self.path,purpose='send',credentials_factory=create,session_factory=session)
        self.data['scopes']=[SCOPE,'https://www.googleapis.com/auth/gmail.send']
        self.write_token()
        self.assert_rejected()
        self.assertEqual(gmail_session.open_session(self.path,purpose='send',credentials_factory=create,session_factory=session),'send session')

    def test_missing_and_insecure_files_are_rejected(self):
        for mode in ('missing', 'public', 'symlink', 'directory', 'oversize'):
            with self.subTest(mode=mode):
                self.write_token()
                if mode == 'missing':
                    self.path.unlink()
                elif mode == 'public':
                    self.path.chmod(0o644)
                elif mode == 'symlink':
                    target = self.path.with_name('target.json')
                    self.path.rename(target)
                    self.path.symlink_to(target)
                elif mode == 'directory':
                    self.path.unlink()
                    self.path.mkdir()
                else:
                    self.path.write_bytes(b' ' * (64 * 1024 + 1))
                self.assert_rejected()
                if mode == 'symlink':
                    self.path.unlink()
                elif mode == 'directory':
                    self.path.rmdir()

    def test_malformed_or_wrong_authority_is_rejected_before_factories(self):
        cases = [
            'not json', [], {},
            {**self.data, 'refresh_token': ''},
            {**self.data, 'client_id': None},
            {**self.data, 'client_secret': ''},
            {**self.data, 'token_uri': 'https://evil.example/token'},
            {**self.data, 'scopes': ['https://mail.google.com/']},
            {**self.data, 'scopes': [SCOPE, SCOPE]},
            {**self.data, 'scopes': SCOPE},
            {**self.data, 'universe_domain': 'evil.example'},
            {**self.data, 'quota_project_id': 'alternate'},
            {**self.data, 'type': 'service_account'},
            {**self.data, 'token': ''},
        ]
        for data in cases:
            with self.subTest(data=data):
                if isinstance(data, str):
                    self.path.write_text(data)
                    self.path.chmod(0o600)
                else:
                    self.write_token(data)
                self.assert_rejected()

    def test_expired_token_is_loaded_without_refresh(self):
        self.write_token({**self.data, 'expiry': '2000-01-01T00:00:00Z'})
        self.assertEqual(self.open(), 'session')
        self.assertEqual(len(self.calls), 2)

    def test_file_owned_by_another_user_is_rejected(self):
        with patch.object(gmail_session.os, 'getuid', return_value=os.getuid() + 1):
            self.assert_rejected()

    def test_factory_errors_do_not_expose_token_content(self):
        def broken_factory(data):
            raise RuntimeError(data['refresh_token'])

        with self.assertRaises(gmail_session.GmailSessionError) as caught:
            gmail_session.open_session(self.path, credentials_factory=broken_factory)
        self.assertNotIn('synthetic-refresh', str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)

    def test_sdk_defaults_construct_offline_with_synthetic_token(self):
        try:
            from google.auth.transport.requests import AuthorizedSession
        except ImportError:
            self.skipTest('google-auth[requests] is not installed')
        session = gmail_session.open_session(self.path)
        try:
            self.assertIsInstance(session, AuthorizedSession)
            self.assertEqual(session.credentials.token_uri,
                             'https://oauth2.googleapis.com/token')
            self.assertEqual(session._max_refresh_attempts, 0)
            self.assertEqual(session._refresh_timeout, 20)
        finally:
            session.close()


if __name__ == '__main__':
    unittest.main()
