"""Discovery filter settings: rules owns the contract and defaults, this owns their storage."""
import json
from freelance.platform.errors import Conflict
from freelance.platform.sqlite import encode
from freelance.modules.discovery.rules import DEFAULTS, preferences


class DiscoverySettings:
    def __init__(self, database):
        self.database = database

    def read(self, conn):
        row = conn.execute('SELECT revision,settings FROM discovery_settings WHERE id=1').fetchone()
        return dict(revision=row['revision'], settings=json.loads(row['settings'])) if row else dict(revision=0, settings=preferences(DEFAULTS))

    def current(self):
        with self.database.connect(write=False) as conn:
            return self.read(conn)

    def replace(self, revision, settings):
        settings = preferences(settings)
        with self.database.connect() as conn:
            current = self.read(conn)
            if type(revision) is not int or revision != current['revision']:
                raise Conflict('篩選設定已更新，請重新載入')
            conn.execute('''INSERT INTO discovery_settings(id,revision,settings) VALUES (1,?,?)
                ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,settings=excluded.settings''',
                (revision + 1, encode(settings)))
            return dict(revision=revision + 1, settings=settings)
