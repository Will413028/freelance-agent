import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
from freelance.modules.notifications.digest import render
from freelance.modules.collection.gmail import sync_tasker
from freelance.modules.collection.gmail_session import open_session
from freelance.modules.collection.gmail_transport import GmailTransport
from freelance.modules.notifications.scheduler import TAIPEI, daily_tick
from freelance.bootstrap.store import SQLiteStore
from freelance.modules.notifications.daily import run_daily

def main(argv=None):
    parser = argparse.ArgumentParser(description='Daily Tasker intake and local unsent digest; explicit live read required')
    parser.add_argument('--database', required=True)
    parser.add_argument('--token', required=True)
    parser.add_argument('--expected-email', required=True)
    parser.add_argument('--recipient', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--max-messages', type=int, default=100)
    parser.add_argument('--live-read', action='store_true')
    parser.add_argument('--live-send', action='store_true')
    parser.add_argument('--send-token')
    args = parser.parse_args(argv)
    if args.live_send != bool(args.send_token):
        parser.error('--live-send and --send-token must be supplied together')
    if not args.live_read:
        parser.error('--live-read required; no mailbox or token accessed')
    if args.recipient.strip().casefold() != args.expected_email.strip().casefold():
        parser.error('This personal runner requires recipient to equal the verified mailbox')
    if not 1 <= args.max_messages <= 100:
        parser.error('Message limit must be from 1 to 100')

    @contextmanager
    def client():
        session = open_session(args.token)
        try:
            yield GmailTransport(session, args.expected_email)
        finally:
            session.close()
    try:
        result = run_daily(SQLiteStore(args.database), client, recipient=args.recipient,
                           output_dir=args.output_dir, max_messages=args.max_messages,
                           send_session_factory=(lambda: open_session(args.send_token, purpose="send")) if args.live_send else None)
    except Exception:
        print('Daily run failed; check local database, output and authorization configuration.')
        return 1
    print(json.dumps(result))
    return 1 if (result['status'] in ('failed', 'source_failed') or result.get('delivery_error')
                 or result.get('delivery_status') in ('unknown', 'attempted')) else 0


if __name__ == "__main__":
    raise SystemExit(main())
