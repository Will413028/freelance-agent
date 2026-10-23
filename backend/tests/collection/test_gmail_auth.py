import contextlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import freelance.modules.collection.gmail_auth as gmail_auth

SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'


class FakeCredentials:
    def __init__(self, scopes=None, refresh_token='refresh-secret'):
        self.scopes = [SCOPE] if scopes is None else scopes
        self.granted_scopes = self.scopes
        self.refresh_token = refresh_token

    def to_json(self):
        return json.dumps({'refresh_token': self.refresh_token})


class FakeFlow:
    def __init__(self, credentials):
        self.credentials = credentials
        self.calls = []

    def run_local_server(self, **kwargs):
        self.calls.append(kwargs)
        return self.credentials


class FakeResponse:
    status_code = 200

    def __init__(self, email):
        self.email = email

    def json(self):
        return {'emailAddress': self.email}


class FakeSession:
    def __init__(self, email):
        self.email = email
        self.calls = []
        self.closed = False

    def close(self):
        self.closed = True

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return FakeResponse(self.email)


class GmailAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.client = self.root / 'client.json'
        self.token = self.root / 'token.json'
        self.client.write_text(json.dumps({'installed': {
            'client_id': 'synthetic-id', 'client_secret': 'synthetic-secret',
            'auth_uri': 'https://accounts.google.com/o/oauth2/v2/auth',
            'token_uri': 'https://oauth2.googleapis.com/token',
        }}))
        self.client.chmod(0o600)
        self.flow = FakeFlow(FakeCredentials())
        self.session = FakeSession('PERSON@example.com')
        self.factory_calls = []

    def authorize(self, purpose="read"):
        def flow_factory(config, scopes, **kwargs):
            self.factory_calls.append((config, scopes, kwargs))
            return self.flow

        def session_factory(credentials, **kwargs):
            self.factory_calls.append((credentials, kwargs))
            return self.session

        return gmail_auth.authorize(self.client, self.token, 'person@EXAMPLE.com',
                                     flow_factory=flow_factory,
                                     session_factory=session_factory, purpose=purpose)

    def test_saves_only_verified_readonly_account_with_private_mode(self):
        self.authorize()
        self.assertEqual(stat.S_IMODE(self.token.stat().st_mode), 0o600)
        self.assertEqual(json.loads(self.token.read_text())['refresh_token'], 'refresh-secret')
        self.assertEqual(self.factory_calls[0][1], [SCOPE])
        self.assertTrue(self.factory_calls[0][2]['autogenerate_code_verifier'])
        self.assertEqual(self.flow.calls[0], {
            'host': '127.0.0.1', 'port': 0, 'open_browser': True,
            'timeout_seconds': 180, 'authorization_prompt_message': '',
            'prompt': 'consent', 'include_granted_scopes': 'false',
            'success_message': 'Authorization response received. Return to the terminal for verification.',
        })
        self.assertEqual(self.factory_calls[1][1], {'max_refresh_attempts': 0})
        self.assertTrue(self.session.closed)
        self.assertEqual(self.session.calls[0],
                         ('https://gmail.googleapis.com/gmail/v1/users/me/profile',
                          {'timeout': 20, 'allow_redirects': False}))

    def test_send_purpose_requests_only_readonly_and_send(self):
        scopes=[SCOPE,'https://www.googleapis.com/auth/gmail.send']
        self.flow.credentials=FakeCredentials(scopes)
        self.authorize(purpose='send')
        self.assertEqual(self.factory_calls[0][1],scopes)
        self.assertTrue(self.token.exists())

    def test_readonly_grant_cannot_create_send_token(self):
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize(purpose='send')
        self.assertFalse(self.token.exists())

    def test_wrong_account_does_not_save(self):
        self.session.email = 'someone-else@example.com'
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertFalse(self.token.exists())

    def test_broad_scopes_do_not_save(self):
        self.flow.credentials.granted_scopes = [SCOPE, 'https://mail.google.com/']
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertFalse(self.token.exists())

    def test_missing_refresh_token_does_not_save(self):
        self.flow.credentials.refresh_token = None
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertFalse(self.token.exists())

    def test_invalid_client_endpoint_does_not_launch_flow(self):
        data = json.loads(self.client.read_text())
        data['installed']['auth_uri'] = 'https://evil.example/oauth'
        self.client.write_text(json.dumps(data))
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertEqual(self.factory_calls, [])

    def test_unsafe_client_permissions_do_not_launch_flow(self):
        self.client.chmod(0o644)
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertEqual(self.factory_calls, [])

    def test_existing_token_is_untouched(self):
        self.token.write_text('original')
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertEqual(self.token.read_text(), 'original')
        self.assertEqual(self.factory_calls, [])

    def test_symlink_client_is_rejected(self):
        real = self.root / 'real-client.json'
        self.client.rename(real)
        self.client.symlink_to(real)
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertEqual(self.factory_calls, [])

    def test_symlink_token_parent_is_rejected(self):
        real = self.root / 'real-dir'
        real.mkdir()
        link = self.root / 'linked-dir'
        link.symlink_to(real, target_is_directory=True)
        self.token = link / 'token.json'
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertEqual(self.factory_calls, [])

    def test_redirected_profile_is_rejected(self):
        self.session.get = lambda *args, **kwargs: type('Response', (), {'status_code': 302})()
        with self.assertRaises(gmail_auth.AuthorizationError):
            self.authorize()
        self.assertFalse(self.token.exists())

    def test_failures_do_not_print_or_expose_secrets(self):
        self.session.email = 'someone-else@example.com'
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(gmail_auth.AuthorizationError) as caught:
                self.authorize()
        output = stdout.getvalue() + stderr.getvalue() + str(caught.exception)
        self.assertNotIn('synthetic-secret', output)
        self.assertNotIn('refresh-secret', output)
        self.assertNotIn('someone-else@example.com', output)

    def test_safe_diagnostics_distinguish_failure_stages(self):
        cases = [
            ('client_config', lambda: self.client.chmod(0o644)),
            ('token_target', lambda: self.token.write_text('original')),
            ('scope_mismatch', lambda: setattr(self.flow.credentials, 'granted_scopes', [])),
            ('refresh_token_missing', lambda: setattr(self.flow.credentials, 'refresh_token', None)),
            ('account_mismatch', lambda: setattr(self.session, 'email', 'wrong@example.com')),
        ]
        for code, break_step in cases:
            with self.subTest(code=code):
                self.client.chmod(0o600)
                if self.token.exists():
                    self.token.unlink()
                self.flow.credentials = FakeCredentials()
                self.session.email = 'PERSON@example.com'
                break_step()
                with self.assertRaises(gmail_auth.AuthorizationError) as error:
                    self.authorize()
                self.assertIn('[' + code + ']', str(error.exception))
                self.assertNotIn('secret', str(error.exception))

    def test_profile_http_status_is_safe_diagnostic(self):
        self.session.get = lambda *a, **kw: type('Response', (), {'status_code': 403})()
        with self.assertRaises(gmail_auth.AuthorizationError) as error:
            self.authorize()
        self.assertIn('[profile_http_403]', str(error.exception))
        self.assertFalse(self.token.exists())

    def test_callback_timeout_is_diagnosable_without_exception_payload(self):
        class WSGITimeoutError(Exception):
            pass
        with patch.object(self.flow, 'run_local_server', side_effect=WSGITimeoutError('PRIVATE-CODE')):
            with self.assertRaises(gmail_auth.AuthorizationError) as error:
                self.authorize()
        self.assertIn('[consent_timeout]', str(error.exception))
        self.assertNotIn('PRIVATE-CODE', str(error.exception))

    def test_cli_emits_safe_error_code_instead_of_discarding_it(self):
        err = io.StringIO()
        with patch.object(gmail_auth, 'authorize', side_effect=gmail_auth.AuthorizationError('Gmail authorization failed. [account_mismatch]')):
            with contextlib.redirect_stderr(err):
                result = gmail_auth.main(['--client','unused','--token','unused','--expected-email','person@example.com'])
        self.assertEqual(result, 1)
        self.assertIn('[account_mismatch]', err.getvalue())


if __name__ == '__main__':
    unittest.main()
