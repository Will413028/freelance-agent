"""Preferences and feedback, preserving the historical tracking ledger."""
from contextlib import nullcontext
import json
from freelance.platform.sqlite import encode
from freelance.modules.preferences.domain import empty_tracking, update_tracking

class Preferences:
    def __init__(self, database):
        self.database = database

    def states(self, conn):
        return {row['opportunity_id']: json.loads(row['state'])
                for row in conn.execute('SELECT * FROM opportunity_tracking')}

    def state(self, conn, key):
        row = conn.execute('SELECT state FROM opportunity_tracking WHERE opportunity_id=?', (key,)).fetchone()
        return json.loads(row['state']) if row else empty_tracking()

    def events(self, conn):
        return list(conn.execute('SELECT opportunity_id,state FROM tracking_events'))

    def track(self, key, revision, *, feedback=None, stage=None, reason='', note='', evidence='', _conn=None, records=None, now=None):
        with (self.database.connect() if _conn is None else nullcontext(_conn)) as conn:
            item = records.get(conn, key)
            if item is None:
                raise KeyError(key)
            previous = conn.execute('SELECT state FROM opportunity_tracking WHERE opportunity_id=?', (key,)).fetchone()
            current = json.loads(previous['state']) if previous else empty_tracking()
            now = self.database.clock() if now is None else now
            state = update_tracking(current, revision, now, feedback=feedback, stage=stage,
                                    reason=reason, note=note, evidence=evidence)
            conn.execute('INSERT INTO opportunity_tracking(opportunity_id,state) VALUES (?,?) '
                         'ON CONFLICT(opportunity_id) DO UPDATE SET state=excluded.state', (key, encode(state)))
            conn.execute('INSERT INTO tracking_events(opportunity_id,revision,state,created_at) VALUES (?,?,?,?)',
                         (key, state['revision'], encode(state), now.isoformat()))
            item = records.feedback_changed(conn, item, feedback, now)
            item['tracking'] = state
            return item
