"""Step 12 rehearsal (plan): the pre-cutover Python reads the written-back copy and carries on.

Run in the running backend image with --network none; the copy is mounted read-only and checked on
a private clone. Prints counts only. Exit 0 when every expectation from inject.mts holds.
  python -I check.py <written-back copy> <expected.json>
"""
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

from freelance.bootstrap.store import SQLiteStore

source, expected = Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text())
with tempfile.TemporaryDirectory() as directory:
    clone = Path(directory) / 'clone.sqlite3'
    shutil.copyfile(source, clone)
    clone.chmod(0o600)  # SQLiteStore opens owner-only files only
    with closing(sqlite3.connect(clone)) as db:
        assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        count = db.execute('SELECT count(*) FROM opportunities').fetchone()[0]
        # The recipient of the injected run (personal data: read here, never passed or printed).
        recipient = db.execute('SELECT recipient FROM daily_runs WHERE local_date=?', (expected['day'],)).fetchone()[0]
        feedback = dict(db.execute("SELECT json_extract(state, '$.feedback') f, count(*) FROM opportunity_tracking GROUP BY f ORDER BY f").fetchall())
    store = SQLiteStore(clone, clock=lambda: datetime(2026, 11, 30, 2, tzinfo=timezone.utc))
    items = store.list()
    preferences = store.preferences()
    store.sources()
    checks = {
        'opportunities': count == expected['opportunities'],
        'feedback_counts': {str(k): v for k, v in feedback.items()} == expected['feedback_counts'],
        'settings_revision': preferences['revision'] == expected['settings_revision'],
        'new_listing_listed': any(expected['new_listing'] in (i.get('member_ids') or [i.get('id')]) for i in items),
        'day_already_ran': store.claim_daily_run(expected['day'], recipient, datetime(2026, 11, 30, 2, tzinfo=timezone.utc)) is False,
    }
    with closing(sqlite3.connect(clone)) as db:
        cursor = json.loads(db.execute('SELECT state FROM mail_sync_state WHERE source=? ORDER BY recipient LIMIT 1', (expected['mail']['source'],)).fetchone()[0])['cursor']
    checks['mail_cursor'] = cursor == expected['mail']['cursor']
    # Python carries on writing: one more feedback through its own store on the same clone.
    target = expected['feedback_target']
    with closing(sqlite3.connect(clone)) as db:
        revision = json.loads(db.execute('SELECT state FROM opportunity_tracking WHERE opportunity_id=?', (target,)).fetchone()[0])['revision']
    store.track(target, revision, feedback='neutral')
    checks['python_writes'] = True
print(json.dumps({'items': len(items), **checks}, sort_keys=True))
sys.exit(0 if all(v is True for k, v in checks.items()) else 1)
