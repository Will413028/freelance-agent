import base64

import unittest

import freelance.modules.collection.mail as mail

def encoded(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip('=')

def message(body='完整正文', mime='text/html'):
    return {'id': 'synthetic-message', 'internalDate': '1789603200000',
            'snippet': 'NOT THE BODY', 'payload': {'mimeType': mime,
            'headers': [{'name': 'From', 'value': 'Tasker <deals@tasker.com.tw>'},
                        {'name': 'Subject', 'value': '新案件【測試網站】'}],
            'body': {'data': encoded(body)}}}
