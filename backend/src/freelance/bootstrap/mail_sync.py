"""Explicit one-shot Gmail preview or persistent import. Never sends messages."""
import argparse
import json
import os
from pathlib import Path
import stat
import sys

from freelance.modules.collection.gmail import QUERY, sync_tasker
from freelance.modules.collection.gmail_session import open_session
from freelance.modules.collection.gmail_transport import GmailTransport
from freelance.modules.collection.intake import preview
from freelance.modules.collection.tasker import TaskerParseError


class SyncError(Exception):
    pass


def preview_tasker(client, *, max_messages=20, max_pages=20):
    """A bounded sample; truncation is explicit and never updates source health."""
    if any(type(n) is not int or not 1 <= n <= 100 for n in (max_messages, max_pages)):
        raise ValueError('Preview limits must be integers from 1 to 100')
    try:
        ids, seen, tokens = [], set(), set()
        token, truncated, pages = None, False, 0
        while pages < max_pages:
            page = client.list_messages(query=QUERY, page_token=token,
                                        max_results=min(100, max_messages-len(ids)))
            pages += 1
            if not isinstance(page, dict) or 'error' in page:
                raise SyncError()
            messages = page.get('messages', [])
            if not isinstance(messages, list):
                raise SyncError()
            for entry in messages:
                mid = entry.get('id') if isinstance(entry, dict) else None
                if not isinstance(mid, str) or not mid:
                    raise SyncError()
                if mid in seen:
                    continue
                if len(ids) == max_messages:
                    truncated = True
                    break
                seen.add(mid)
                ids.append(mid)
            token = page.get('nextPageToken')
            if token is not None:
                if not isinstance(token, str) or not token or token in tokens:
                    raise SyncError()
                tokens.add(token)
            if truncated or token is None:
                break
            if len(ids) == max_messages or pages == max_pages:
                truncated = True
                break
        items, unsupported = [], []
        for mid in ids:
            message = client.get_message(mid)
            if not isinstance(message, dict) or message.get('id') != mid:
                raise SyncError()
            try:
                items.extend(preview(message))
            except TaskerParseError:
                unsupported.append({'message_id':mid, 'reason':'unsupported_notification'})
        return {'status':'preview_partial' if unsupported else ('preview_limited' if truncated else 'preview_complete'),
                'truncated':truncated, 'pages':pages, 'messages':len(ids), 'items':items,
                'unsupported_messages':unsupported, 'generation':'template', 'database_written':False}
    except Exception:
        raise SyncError('Gmail preview failed; no preview saved.') from None


def _output_target(path):
    target = Path(path)
    if os.path.lexists(target) or not stat.S_ISDIR(target.parent.lstat().st_mode):
        raise SyncError('Preview target must be a new file in an existing directory.')
    return target


def main(argv=None):
    parser = argparse.ArgumentParser(description='Opt-in Tasker Gmail read; template drafts only, never sends')
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--preview', action='store_true', help='write a bounded sample; no database changes')
    modes.add_argument('--apply', action='store_true', help='complete bounded scan into explicitly configured database')
    parser.add_argument('--live-read', action='store_true', help='authorize this invocation to use token and read the fixed Tasker query')
    parser.add_argument('--token', required=True)
    parser.add_argument('--expected-email', required=True)
    parser.add_argument('--output', help='new sanitized preview JSON path (preview only)')
    parser.add_argument('--max-messages', type=int, default=20)
    parser.add_argument('--max-pages', type=int, default=20)
    parser.add_argument("--backend", choices=("postgres", "sqlite"), default="postgres")
    parser.add_argument("--database", help="existing SQLite database path (apply only)")
    args = parser.parse_args(argv)
    if not args.live_read:
        parser.error('--live-read is required; no credentials or mailbox accessed')
    if not 1 <= args.max_messages <= 100 or not 1 <= args.max_pages <= 100:
        parser.error('limits must be from 1 to 100')
    if args.preview and not args.output:
        parser.error('--preview requires --output')
    if args.apply and args.output:
        parser.error('--output is preview-only')
    dsn = os.environ.get('FREELANCE_DATABASE_URL') if args.apply else None
    if args.preview and (args.database or args.backend != 'postgres'):
        parser.error('backend options are apply-only')
    if args.apply and args.backend == 'sqlite' and not args.database:
        parser.error('SQLite apply requires --database')
    if args.backend == 'postgres' and args.database:
        parser.error('--database requires SQLite')
    if args.apply and args.backend == 'postgres' and not dsn:
        parser.error('--apply requires explicit FREELANCE_DATABASE_URL; schema must already be migrated')
    session = None
    try:
        target = _output_target(args.output) if args.preview else None
        session = open_session(args.token)
        client = GmailTransport(session, args.expected_email)
        if args.preview:
            result = preview_tasker(client, max_messages=args.max_messages, max_pages=args.max_pages)
            content = json.dumps(result, ensure_ascii=False, indent=2)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os,'O_NOFOLLOW',0), 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                output.write(content+'\n')
            summary = {k:v for k,v in result.items() if k not in ('items', 'unsupported_messages')}
            summary['unsupported_messages'] = len(result['unsupported_messages'])
        else:
            if args.backend == 'sqlite':
                from freelance.bootstrap.store import SQLiteStore
                store = SQLiteStore(args.database)
            else:
                from freelance.legacy.postgres import PostgresStore
                store = PostgresStore(dsn)
            summary = sync_tasker(client, store,
                                  max_messages=args.max_messages, max_pages=args.max_pages)
        print(json.dumps(summary))
        return 1 if summary.get('status') == 'failed' else 0
    except Exception:
        print('Gmail sync failed; check token, account, output or database configuration.', file=sys.stderr)
        return 1
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass


if __name__ == '__main__':
    raise SystemExit(main())
