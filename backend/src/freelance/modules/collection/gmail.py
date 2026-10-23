"""Bounded Tasker notification ingestion over an injected Gmail transport."""

from freelance.modules.collection.tasker import parse_tasker


QUERY = 'from:deals@tasker.com.tw newer_than:90d'


class _SourceFailure(Exception):
    pass


def _limit(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f'{name} must be a positive integer')


def sync_tasker(client, store, *, max_pages=20, max_messages=1000):
    """Read and parse the complete bounded scan before writing normalized jobs.

    The caller supplies an authorized transport and persistent store. This
    function neither obtains credentials nor retains raw message content.
    """
    _limit(max_pages, 'max_pages')
    _limit(max_messages, 'max_messages')
    try:
        store.set_source_health('tasker', 'failed')
    except Exception:
        return {'source': 'tasker', 'status': 'failed', 'reason': 'source_state_failed'}

    try:
        ids = []
        seen_ids = set()
        seen_tokens = set()
        token = None
        pages = 0
        while True:
            if pages >= max_pages or (token is not None and len(ids) >= max_messages):
                raise _SourceFailure()
            response = client.list_messages(query=QUERY, page_token=token,
                                            max_results=min(100, max_messages - len(ids)))
            pages += 1
            if not isinstance(response, dict):
                raise _SourceFailure()
            messages = response.get('messages', [])
            if not isinstance(messages, list):
                raise _SourceFailure()
            for entry in messages:
                if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not entry['id']:
                    raise _SourceFailure()
                mid = entry['id']
                if mid not in seen_ids:
                    seen_ids.add(mid)
                    ids.append(mid)
                    if len(ids) > max_messages:
                        raise _SourceFailure()
            next_token = response.get('nextPageToken')
            if next_token is None:
                break
            if not isinstance(next_token, str) or not next_token or next_token in seen_tokens:
                raise _SourceFailure()
            seen_tokens.add(next_token)
            token = next_token

        jobs = []
        for mid in ids:
            message = client.get_message(mid)
            if not isinstance(message, dict) or message.get('id') != mid:
                raise _SourceFailure()
            parsed = parse_tasker(message)
            if not isinstance(parsed, list) or not parsed:
                raise _SourceFailure()
            jobs.extend(parsed)
        jobs.sort(key=lambda job: job['received_at'])
    except Exception:
        return {'source': 'tasker', 'status': 'failed', 'reason': 'source_read_failed'}

    try:
        for job in jobs:
            store.ingest(job, receipt_id=job['receipt_id'])
        store.set_source_health('tasker', 'ok')
    except Exception:
        return {'source': 'tasker', 'status': 'failed', 'reason': 'persistence_failed'}
    return {'source': 'tasker', 'status': 'ok', 'pages': pages,
            'messages': len(ids), 'jobs': len(jobs)}
