"""Explicit purposes; readonly remains the default everywhere."""
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'


def scopes_for(purpose):
    if purpose == 'read':
        return [SCOPE]
    if purpose == 'send':
        return [SCOPE, SEND_SCOPE]
    raise ValueError('Unknown Gmail purpose')
