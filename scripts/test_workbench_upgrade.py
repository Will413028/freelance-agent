"""Read an existing database; migrate only private temporary copies twice.

The previous source directory must be an inspected, trusted release checkout.
No providers, credentials, or external calls are used.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

from verify_cutover import fingerprint
from freelance.bootstrap.store import SQLiteStore

NEW_TABLES = {'clients', 'client_contacts', 'application_parties', 'proposal_templates',
              'proposal_drafts', 'proposal_draft_revisions', 'submission_intents',
              'submission_events', 'application_proposals'}


def projection(database, previous=None, *, migrate=False):
    code = '''
import json,sys
from datetime import datetime,timezone
from freelance.bootstrap.store import SQLiteStore
s=SQLiteStore(sys.argv[1],clock=lambda:datetime(2026,10,1,tzinfo=timezone.utc))
if sys.argv[2]=='migrate':s.migrate()
print(json.dumps(dict(items=s.list(),preferences=s.preferences(),sources=s.sources()),sort_keys=True,default=str))
'''
    env = os.environ.copy()
    env.pop('PYTHONPATH', None)
    if previous is not None:
        env['PYTHONPATH'] = str(previous)
    return subprocess.check_output([sys.executable, '-c', code, str(database), 'migrate' if migrate else 'read'],
                                   env=env, cwd='/tmp', text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--previous-source', required=True, type=Path)
    args = parser.parse_args()
    original = args.database.resolve()
    before = fingerprint(original)
    with tempfile.TemporaryDirectory(prefix='freelance-upgrade-') as directory:
        clone = Path(directory) / 'clone.sqlite3'
        fd = os.open(clone, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(original.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(clone)) as dst:
            src.backup(dst)
        old_projection = projection(clone, args.previous_source.resolve(), migrate=True)
        previous_tables = fingerprint(clone)
        store = SQLiteStore(clone)
        store.migrate()
        first = fingerprint(clone)
        store.migrate()
        assert first == fingerprint(clone), 'second migration changed data'
        assert all(first[name] == value for name, value in before.items()), 'existing rows changed'
        assert all(first[name] == value for name, value in previous_tables.items()), 'previous release rows changed'
        assert all(first[name]['count'] == 0 for name in NEW_TABLES - before.keys()), 'migration inserted synthetic data'
        assert projection(clone) == old_projection, 'new projection differs'
        assert projection(clone, args.previous_source.resolve()) == old_projection, 'previous release cannot read upgraded data'
    assert fingerprint(original) == before, 'original changed during verification'
    print('PASS copy-only upgrade twice, existing fingerprints, new/previous projections, original unchanged')


if __name__ == '__main__':
    main()
