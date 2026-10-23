import unittest

from fixtures.mail import message

from fixtures.tasker import listing

from freelance.modules.collection.gmail import sync_tasker

def mail(mid, timestamp='1789603200000', body=None):
    item = message(listing() if body is None else body)
    item['id'] = mid
    item['internalDate'] = timestamp
    return item

class Client:
    def __init__(self, pages, messages):
        self.pages = pages
        self.messages = messages
        self.calls = []

    def list_messages(self, *, query, page_token, max_results):
        self.calls.append((query, page_token, max_results))
        return self.pages[page_token]

    def get_message(self, mid):
        return self.messages[mid]

class Store:
    def __init__(self):
        self.health = []
        self.jobs = []

    def set_source_health(self, source, status):
        self.health.append((source, status))

    def ingest(self, job, receipt_id=None):
        self.jobs.append((job, receipt_id))
