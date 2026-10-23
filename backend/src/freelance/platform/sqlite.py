"""SQLite transactions and explicit schema upgrades; no product decisions."""
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import sqlite3
import stat
from threading import RLock
from importlib.resources import files

def encode(value):
    return json.dumps(value, ensure_ascii=False)

def row(cursor, values):
    return dict(zip((column[0] for column in cursor.description), values))

class Database:
    def __init__(self, path, clock=None):
        self.path = Path(path).absolute()
        self.clock = clock or (lambda: datetime.now(timezone.utc))


    def _validate(self):
        info = self.path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('SQLite database must be an owner-only regular file')


    @contextmanager
    def connect(self, *, write=True):
        self._validate()
        conn = sqlite3.connect(self.path.as_uri() + ('?mode=rw' if write else '?mode=ro'), uri=True, timeout=5, isolation_level=None)
        conn.row_factory = row
        try:
            conn.execute('PRAGMA foreign_keys=ON')
            conn.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()


    def migrate(self):
        if not os.path.lexists(self.path):
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            os.close(fd)
        self._validate()
        conn = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=5)
        try:
            conn.execute('PRAGMA foreign_keys=ON')
            sql = files('freelance.platform').joinpath('schema/001_sqlite.sql').read_text()
            conn.executescript('BEGIN IMMEDIATE;\n' + sql + '\nCOMMIT;')
            health_schema = conn.execute("SELECT sql FROM sqlite_master WHERE name='source_health'").fetchone()[0]
            if "'waiting'" not in health_schema:
                conn.execute('BEGIN IMMEDIATE')
                conn.execute("""CREATE TABLE source_health_with_waiting (
                    source text PRIMARY KEY,
                    status text NOT NULL CHECK(status IN ('not_connected','ok','failed','waiting')),
                    checked_at text NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
                conn.execute('INSERT INTO source_health_with_waiting SELECT source,status,checked_at FROM source_health')
                conn.execute('DROP TABLE source_health')
                conn.execute('ALTER TABLE source_health_with_waiting RENAME TO source_health')
                conn.commit()
            columns = {row[1]: row for row in conn.execute('PRAGMA table_info(ai_draft_attempts)')}
            if 'priority' not in columns or columns['priority'][5] != 3:
                conn.execute('BEGIN IMMEDIATE')
                conn.execute('ALTER TABLE ai_draft_attempts RENAME TO ai_draft_attempts_legacy')
                conn.execute('''CREATE TABLE ai_draft_attempts (
                    opportunity_id text NOT NULL REFERENCES opportunities(id),
                    fingerprint text NOT NULL, version integer NOT NULL CHECK (version > 0),
                    local_date text NOT NULL, recipient text NOT NULL,
                    status text NOT NULL CHECK (status IN ('attempted','succeeded','failed','stale')),
                    attempted_at text NOT NULL, finished_at text, reason text,
                    priority text NOT NULL CHECK (priority IN ('interested','prewrite','legacy')),
                    PRIMARY KEY (opportunity_id,fingerprint,priority))''')
                old_priority = 'priority' in columns
                conn.execute('''INSERT INTO ai_draft_attempts
                    (opportunity_id,fingerprint,version,local_date,recipient,status,attempted_at,finished_at,reason,priority)
                    SELECT opportunity_id,fingerprint,version,local_date,recipient,status,attempted_at,finished_at,reason,'''
                    + ("COALESCE(priority,'legacy')" if old_priority else "'legacy'")
                    + ' FROM ai_draft_attempts_legacy')
                conn.execute('DROP TABLE ai_draft_attempts_legacy')
                conn.execute('CREATE INDEX ai_draft_attempts_local_date ON ai_draft_attempts(local_date)')
                conn.commit()
        finally:
            conn.close()




class MemoryDatabase:
    """Synthetic demo using the same transactions/use cases without runtime files."""
    def __init__(self, clock=None):
        self.path = None
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.lock = RLock()
        self.connection = sqlite3.connect(':memory:', check_same_thread=False, isolation_level=None)
        self.connection.row_factory = row
        self.connection.execute('PRAGMA foreign_keys=ON')

    @contextmanager
    def connect(self, *, write=True):
        with self.lock:
            self.connection.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            try:
                yield self.connection
                self.connection.commit()
            except BaseException:
                self.connection.rollback()
                raise

    def migrate(self):
        schema = files('freelance.platform').joinpath('schema/001_sqlite.sql').read_text()
        with self.lock:
            self.connection.executescript(schema)

    def close(self):
        self.connection.close()
