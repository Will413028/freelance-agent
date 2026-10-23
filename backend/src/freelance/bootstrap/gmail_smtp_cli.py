import argparse
from hashlib import sha256
import hmac
import json
import os
import re
import smtplib
import ssl
import stat
from freelance.modules.notifications.gmail_send import build_message, write_preview
from freelance.modules.notifications.scheduler import dispatch
from freelance.modules.notifications.gmail_smtp import deliver, open_client

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--database',required=True);p.add_argument('--intent-id',required=True);p.add_argument('--email',required=True)
    g=p.add_mutually_exclusive_group(required=True);g.add_argument('--preview',action='store_true');g.add_argument('--send',action='store_true')
    p.add_argument('--output');p.add_argument('--config');p.add_argument('--expected-sha256');p.add_argument('--live-send',action='store_true')
    a=p.parse_args(argv)
    if a.preview and (not a.output or a.config or a.live_send or a.expected_sha256):p.error('Preview requires output only')
    if a.send and (not a.config or not a.live_send or not a.expected_sha256 or a.output):p.error('Send requires config, live flag and reviewed hash')
    from freelance.bootstrap.store import SQLiteStore
    store=SQLiteStore(a.database)
    try:
        if a.preview:
            intent=store.get_digest(a.intent_id);raw=build_message(intent['snapshot'],a.intent_id,a.email)
            result={'status':'preview_only','sha256':write_preview(raw,a.output)}
        else:
            result={'status':deliver(store,a.intent_id,a.email,a.expected_sha256,lambda:open_client(a.config,a.email))['status']}
    except Exception:p.exit(1,'SMTP operation failed; no automatic retry.\n')
    print(json.dumps(result));return 0 if result['status'] in ('sent','preview_only') else 1


if __name__ == "__main__":
    raise SystemExit(main())
