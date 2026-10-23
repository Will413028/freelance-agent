"""Inspect quarantined IDs or requeue one after a parser fix; no network or mail bodies."""
import argparse
import json
from freelance.modules.collection.resend_preview import SENDERS, _id
from freelance.bootstrap.store import SQLiteStore


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--source', choices=tuple(SENDERS), required=True)
    parser.add_argument('--recipient', required=True)
    parser.add_argument('--retry', metavar='MESSAGE_UUID')
    args = parser.parse_args(argv)
    store = SQLiteStore(args.database)
    recipient = args.recipient.casefold()
    try:
        if args.retry:
            store.retry_mail(args.source, recipient, _id(args.retry))
            print(json.dumps({'status': 'queued_for_next_sync'}))
        else:
            records = store.mail_records(args.source, recipient)
            print(json.dumps([row for row in records.values() if row['status'] != 'processed']))
    except Exception:
        parser.exit(1, 'Mail recovery failed; verify database, source, recipient and quarantined ID.\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
