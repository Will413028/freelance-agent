import argparse
import base64
from datetime import date, datetime
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import hashlib
import hmac
import json
import os
import re
from freelance.modules.notifications.digest import render, SOURCE_STATUS, safe_url
from freelance.modules.collection.gmail_auth import PROFILE_URL
from freelance.modules.notifications.scheduler import dispatch
from freelance.modules.discovery.ranking import is_candidate
from freelance.modules.notifications.gmail_send import build_message, send_intent, write_preview

def main(argv=None):
    parser = argparse.ArgumentParser(description='Preview or explicitly send an existing SQLite digest intent')
    parser.add_argument('--database', required=True)
    parser.add_argument('--intent-id', required=True)
    parser.add_argument('--expected-email', required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--preview', action='store_true')
    action.add_argument('--send', action='store_true')
    parser.add_argument('--output')
    parser.add_argument('--token')
    parser.add_argument('--expected-sha256')
    parser.add_argument('--live-send', action='store_true')
    args = parser.parse_args(argv)
    if args.preview and (not args.output or args.token or args.live_send or args.expected_sha256):
        parser.error('Preview requires only --output; no token or send flags')
    if args.send and (not args.live_send or not args.token or not args.expected_sha256 or args.output):
        parser.error('Send requires --live-send, --token and --expected-sha256; no output')
    try:
        from freelance.bootstrap.store import SQLiteStore
        store = SQLiteStore(args.database)
        if args.preview:
            intent = store.get_digest(args.intent_id)
            raw = build_message(intent['snapshot'], intent['id'], args.expected_email)
            result = {'status': 'preview_only', 'sha256': write_preview(raw, args.output)}
        else:
            from freelance.modules.collection.gmail_session import open_session
            intent = send_intent(store, args.intent_id, args.expected_email, args.expected_sha256,
                                 lambda: open_session(args.token, purpose='send'))
            result = {'id': intent['id'], 'status': intent['status']}
    except Exception:
        parser.exit(1, 'Digest operation failed; no automatic retry.\n')
    print(json.dumps(result))
    return 0 if result['status'] in ('preview_only', 'sent') else 1


if __name__ == "__main__":
    raise SystemExit(main())
