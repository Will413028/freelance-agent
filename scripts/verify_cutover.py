"""Read-only fingerprints and explicit backup/clone verification for a release.

Never imports providers, reads credentials, or sends messages. Run as DB owner.
Old-mode PYTHONPATH is only for the previous un-packaged release, never the wheel.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import importlib
import json
import os
from pathlib import Path
import sqlite3


def fingerprint(path):
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        result = {}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            rows = db.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall()
            encoded = sorted(json.dumps(row, sort_keys=True, default=str) for row in rows)
            result[name] = {'count': len(rows), 'sha256': hashlib.sha256(json.dumps(encoded).encode()).hexdigest()}
        return result


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('backup', 'old', 'new', 'final'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    if not args.release.replace('-', '').isalnum():
        parser.error('release must be an alphanumeric label')
    root = args.root.resolve()
    live = root / 'freelance-agent.sqlite3'
    prefix = 'compose-' + args.release
    backup, clone = root / (prefix + '-backup.sqlite3'), root / (prefix + '-clone.sqlite3')
    before = root / (prefix + '-before.json')
    if args.mode == 'backup':
        for dest in (backup, clone):
            write_private(dest, '')
            with closing(sqlite3.connect(live.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(dest)) as dst:
                src.backup(dst)
        state = fingerprint(live)
        assert state == fingerprint(backup) == fingerprint(clone)
        write_private(before, json.dumps(state))
        print(json.dumps({k: v['count'] for k, v in state.items()}))
    elif args.mode in ('old', 'new'):
        module = importlib.import_module('worker.sqlite' if args.mode == 'old' else 'freelance.bootstrap.store')
        store = module.SQLiteStore(clone, clock=lambda: datetime(2026, 9, 28, 1, tzinfo=timezone.utc))
        if args.mode == 'new':
            store.migrate()
        projection = json.dumps({'items': store.list(), 'preferences': store.preferences(), 'sources': store.sources()}, sort_keys=True, default=str)
        if args.mode == 'new':
            assert projection == (root / (prefix + '-old.json')).read_text(), 'projection differs'
            assert fingerprint(clone) == json.loads(before.read_text()), 'clone changed'
        write_private(root / (prefix + '-' + args.mode + '.json'), projection)
        print(args.mode, 'projection sha256', hashlib.sha256(projection.encode()).hexdigest())
    else:
        assert fingerprint(live) == json.loads(before.read_text()), 'live data changed'
        print('PASS live fingerprints unchanged; integrity/FK valid')


if __name__ == '__main__':
    main()
