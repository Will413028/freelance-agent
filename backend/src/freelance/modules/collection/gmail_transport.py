"""Restricted Gmail read transport; caller supplies an authorized HTTP session."""

import re

from freelance.modules.collection.gmail import QUERY


_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me'
_MAX_BYTES = 2 * 1024 * 1024
_MESSAGE_ID = re.compile(r'[A-Za-z0-9_-]+\Z')


class GmailTransportError(Exception):
    """A content-free failure at the Gmail read boundary."""


class GmailTransport:
    def __init__(self, session, expected_email):
        if not isinstance(expected_email, str) or not expected_email.strip():
            raise ValueError('expected_email is required')
        self._session = session
        self._expected_email = expected_email.strip().casefold()
        self._verified = False
        self._listed_ids = set()

    def _get(self, path, params):
        try:
            response = self._session.get(_ROOT + path, params=params, timeout=20,
                                         allow_redirects=False)
            if not isinstance(response.status_code, int) or not 200 <= response.status_code < 300:
                raise GmailTransportError('Gmail request failed')
            if len(response.content) > _MAX_BYTES:
                raise GmailTransportError('Gmail response too large')
            payload = response.json()
            if not isinstance(payload, dict) or 'error' in payload:
                raise GmailTransportError('Invalid Gmail response')
            return payload
        except Exception:
            raise GmailTransportError('Gmail request failed') from None

    def _verify(self):
        if self._verified:
            return
        profile = self._get('/profile', None)
        address = profile.get('emailAddress')
        if not isinstance(address, str) or address.casefold() != self._expected_email:
            raise GmailTransportError('Gmail mailbox verification failed')
        self._verified = True

    def list_messages(self, *, query, page_token, max_results):
        if query != QUERY or not isinstance(query, str):
            raise ValueError('Unsupported Gmail query')
        if page_token is not None and (not isinstance(page_token, str) or not page_token):
            raise ValueError('Invalid Gmail page token')
        if isinstance(max_results, bool) or not isinstance(max_results, int) or not 1 <= max_results <= 100:
            raise ValueError('Invalid Gmail page size')
        self._verify()
        params = {'q': QUERY, 'maxResults': max_results, 'includeSpamTrash': False}
        if page_token is not None:
            params['pageToken'] = page_token
        page = self._get('/messages', params)
        messages = page.get('messages')
        if messages is None:
            estimate = page.get('resultSizeEstimate')
            if (not isinstance(estimate, int) or isinstance(estimate, bool) or estimate < 0
                    or (estimate > 0 and not page.get('nextPageToken'))):
                raise GmailTransportError('Invalid Gmail message list')
            messages = []
        if not isinstance(messages, list) or any(
            not isinstance(message, dict) or not isinstance(message.get('id'), str)
            or not _MESSAGE_ID.fullmatch(message['id']) for message in messages
        ):
            raise GmailTransportError('Invalid Gmail message list')
        token = page.get('nextPageToken')
        if token is not None and (not isinstance(token, str) or not token):
            raise GmailTransportError('Invalid Gmail message list')
        self._listed_ids.update(message['id'] for message in messages)
        return page

    def get_message(self, message_id):
        if not isinstance(message_id, str) or message_id not in self._listed_ids:
            raise GmailTransportError('Gmail message not listed')
        self._verify()
        message = self._get('/messages/' + message_id, {'format': 'full'})
        if message.get('id') != message_id or not isinstance(message.get('payload'), dict):
            raise GmailTransportError('Invalid Gmail message')
        return message
