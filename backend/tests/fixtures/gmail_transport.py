import json

import unittest

from freelance.modules.collection.gmail import QUERY

from freelance.modules.collection.gmail_transport import GmailTransport, GmailTransportError

ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me'

class Response:
    def __init__(self, payload, status=200):
        self.content = json.dumps(payload).encode()
        self.status_code = status

    def json(self):
        return json.loads(self.content)

class Session:
    def __init__(self, replies):
        self.replies = replies
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

def transport(*replies, expected_email='will@example.com'):
    session = Session(list(replies))
    return GmailTransport(session, expected_email), session

PROFILE = Response({'emailAddress': 'Will@Example.com'})
