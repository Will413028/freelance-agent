"""Open an explicit, private Gmail token with exact purpose scopes.

Loading credentials is offline. The caller owns and closes the returned session.
"""

import json
import os
from pathlib import Path
import stat


from freelance.modules.collection.gmail_scopes import SCOPE, scopes_for
TOKEN_URI = 'https://oauth2.googleapis.com/token'
MAX_TOKEN_BYTES = 64 * 1024


class GmailSessionError(Exception):
    """Credential loading failed without exposing token or SDK error content."""


def _read_token(path):
    if not hasattr(os, 'O_NOFOLLOW'):
        raise GmailSessionError('Gmail session unavailable.')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_size > MAX_TOKEN_BYTES):
            raise GmailSessionError('Gmail session unavailable.')
        with os.fdopen(fd, 'rb') as source:
            fd = -1
            raw = source.read(MAX_TOKEN_BYTES + 1)
        if len(raw) > MAX_TOKEN_BYTES:
            raise GmailSessionError('Gmail session unavailable.')
        return json.loads(raw)
    finally:
        if fd != -1:
            os.close(fd)


def _validate_token(data, purpose="read"):
    if not isinstance(data, dict):
        raise GmailSessionError('Gmail session unavailable.')
    for key in ('refresh_token', 'client_id', 'client_secret'):
        if not isinstance(data.get(key), str) or not data[key]:
            raise GmailSessionError('Gmail session unavailable.')
    if (data.get('token_uri') != TOKEN_URI
            or type(data.get('scopes')) is not list
            or (len(data['scopes']) != len(scopes_for(purpose))
                or set(data['scopes']) != set(scopes_for(purpose)))
            or data.get('universe_domain', 'googleapis.com') != 'googleapis.com'
            or data.get('quota_project_id') is not None
            or data.get('type', 'authorized_user') != 'authorized_user'):
        raise GmailSessionError('Gmail session unavailable.')
    if 'token' in data and (not isinstance(data['token'], str) or not data['token']):
        raise GmailSessionError('Gmail session unavailable.')


def _default_credentials_factory(data):
    from google.oauth2.credentials import Credentials
    return Credentials.from_authorized_user_info(data)


def _default_session_factory(credentials, **kwargs):
    from google.auth.transport.requests import AuthorizedSession
    return AuthorizedSession(credentials, **kwargs)


def open_session(token_path, *, credentials_factory=None, session_factory=None, purpose="read"):
    """Load a private token without refreshing it and return an owned session."""
    try:
        data = _read_token(Path(token_path))
        _validate_token(data, purpose)
        credentials = (credentials_factory or _default_credentials_factory)(data)
        return (session_factory or _default_session_factory)(
            credentials, max_refresh_attempts=0, refresh_timeout=20)
    except Exception:
        raise GmailSessionError('Gmail session unavailable.') from None
