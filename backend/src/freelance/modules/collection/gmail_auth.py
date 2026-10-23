"""One-time Gmail OAuth bootstrap with an explicit read/send purpose.

Supply explicit personal runtime paths for the Desktop client JSON and token JSON.
Keep both outside source control; this module never reads mailbox messages.
"""

import argparse
import json
import os
from pathlib import Path
import stat
import sys

from freelance.modules.collection.gmail_scopes import SCOPE, scopes_for
PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
_ERROR = 'Gmail authorization failed.'


class AuthorizationError(Exception):
    """A fixed stage code, never the underlying credential or remote error."""


def _read_client(path):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise AuthorizationError(_ERROR)
        with os.fdopen(fd, 'r', encoding='utf-8') as source:
            fd = -1
            config = json.load(source)
    finally:
        if fd != -1:
            os.close(fd)
    if not isinstance(config, dict) or set(config) != {'installed'}:
        raise AuthorizationError(_ERROR)
    installed = config['installed']
    if not isinstance(installed, dict):
        raise AuthorizationError(_ERROR)
    if (installed.get('auth_uri') not in {
            'https://accounts.google.com/o/oauth2/auth',
            'https://accounts.google.com/o/oauth2/v2/auth'}
            or installed.get('token_uri') != 'https://oauth2.googleapis.com/token'
            or not isinstance(installed.get('client_id'), str)
            or not installed['client_id']
            or not isinstance(installed.get('client_secret'), str)
            or not installed['client_secret']):
        raise AuthorizationError(_ERROR)
    return config


def _check_target(path):
    parent = path.parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise AuthorizationError(_ERROR)
    if os.path.lexists(path):
        raise AuthorizationError(_ERROR)


def _default_flow_factory(config, scopes, **kwargs):
    from google_auth_oauthlib.flow import InstalledAppFlow
    return InstalledAppFlow.from_client_config(config, scopes, **kwargs)


def _default_session_factory(credentials, **kwargs):
    from google.auth.transport.requests import AuthorizedSession
    return AuthorizedSession(credentials, **kwargs)


def authorize(client_path, token_path, expected_email, *, flow_factory=None,
              session_factory=None, purpose="read"):
    """Verify one account with exact purpose scopes, then create its token once."""
    stage = 'arguments'
    try:
        requested_scopes = scopes_for(purpose)
        client_path = Path(client_path)
        token_path = Path(token_path)
        if not isinstance(expected_email, str) or not expected_email.strip():
            raise AuthorizationError(_ERROR)
        stage = 'client_config'
        config = _read_client(client_path)
        stage = 'token_target'
        _check_target(token_path)
        stage = 'sdk_setup'
        flow = (flow_factory or _default_flow_factory)(
            config, requested_scopes, autogenerate_code_verifier=True)
        stage = 'browser_consent'
        credentials = flow.run_local_server(
            host='127.0.0.1', port=0, open_browser=True,
            timeout_seconds=180, authorization_prompt_message='',
            success_message='Authorization response received. Return to the terminal for verification.',
            prompt='consent', include_granted_scopes='false')
        stage = 'scope_mismatch'
        scopes = getattr(credentials, 'granted_scopes', None)
        if scopes is None:
            scopes = getattr(credentials, 'scopes', None)
        if scopes is None or set(scopes) != set(requested_scopes) or len(scopes) != len(requested_scopes):
            raise AuthorizationError(_ERROR)
        stage = 'refresh_token_missing'
        if not getattr(credentials, 'refresh_token', None):
            raise AuthorizationError(_ERROR)
        stage = 'profile_request'
        session = (session_factory or _default_session_factory)(
            credentials, max_refresh_attempts=0)
        try:
            response = session.get(PROFILE_URL, timeout=20, allow_redirects=False)
            if response.status_code != 200:
                if type(response.status_code) is int and 100 <= response.status_code <= 599:
                    stage = f'profile_http_{response.status_code}'
                raise AuthorizationError(_ERROR)
            stage = 'profile_response'
            email = response.json().get('emailAddress')
        finally:
            session.close()
        stage = 'account_mismatch'
        if not isinstance(email, str) or email.casefold() != expected_email.casefold():
            raise AuthorizationError(_ERROR)
        stage = 'token_write'
        serialized = credentials.to_json()
        fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                     getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as target:
                fd = -1
                target.write(serialized)
        finally:
            if fd != -1:
                os.close(fd)
        return None
    except Exception as error:
        if stage == 'browser_consent' and type(error).__name__ == 'WSGITimeoutError':
            stage = 'consent_timeout'
        # Never interpolate error text, URLs, scope payloads, or account values.
        raise AuthorizationError(f'{_ERROR} [{stage}]') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description='One-time Gmail OAuth bootstrap (readonly by default)')
    parser.add_argument('--client', required=True, help='private Desktop OAuth JSON path')
    parser.add_argument('--token', required=True, help='new private token JSON path')
    parser.add_argument('--expected-email', required=True, help='Gmail account to verify')
    parser.add_argument('--purpose', choices=('read', 'send'), default='read')
    args = parser.parse_args(argv)
    try:
        authorize(args.client, args.token, args.expected_email, purpose=args.purpose)
    except AuthorizationError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
