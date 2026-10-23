import argparse
from datetime import date
from hashlib import sha256
import hmac
import json
import re
from urllib.request import Request, build_opener
from uuid import UUID
from freelance.modules.notifications.digest import render
from freelance.modules.collection.resend_preview import NoRedirect, read_key, write_preview
from freelance.modules.notifications.scheduler import dispatch
from freelance.modules.notifications.resend_send import SendingClient, build_payload, send_intent

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--intent-id', required=True)
    parser.add_argument('--recipient', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preview', action='store_true')
    mode.add_argument('--send', action='store_true')
    parser.add_argument('--output')
    parser.add_argument('--key-file')
    parser.add_argument('--expected-sha256')
    parser.add_argument('--live-send', action='store_true')
    args = parser.parse_args(argv)
    if args.preview and (not args.output or args.key_file or args.expected_sha256 or args.live_send):
        parser.error('Preview requires output only; no credentials')
    if args.send and (not args.live_send or not args.key_file or not args.expected_sha256 or args.output):
        parser.error('Send requires explicit live flag, key and reviewed hash')
    try:
        from freelance.bootstrap.store import SQLiteStore
        store = SQLiteStore(args.database)
        if args.preview:
            raw = build_payload(store.get_digest(args.intent_id)['snapshot'], args.recipient)
            write_preview(json.loads(raw), args.output)
            result = {'status': 'preview_only', 'sha256': sha256(raw).hexdigest()}
        else:
            intent = send_intent(store, args.intent_id, args.recipient, args.expected_sha256,
                                 lambda: SendingClient(read_key(args.key_file)))
            result = {'status': intent['status'], 'id': intent['id']}
    except Exception:
        parser.exit(1, 'Resend operation failed; no automatic retry.\n')
    print(json.dumps(result))
    return 0 if result['status'] in ('preview_only', 'sent') else 1


if __name__ == "__main__":
    raise SystemExit(main())
