"""Run with an interpreter where the release wheel was installed (outside repo)."""
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory() as directory:
    code = '''
from pathlib import Path
from freelance.bootstrap.store import SQLiteStore
from freelance.bootstrap.api import create_server
store = SQLiteStore(Path('synthetic.db'))
store.migrate()
assert store.list() == []
client=store.relationships.create_client(dict(request_id='synthetic-client',name='Synthetic',note=''))
draft=store.create_proposal(dict(request_id='synthetic-draft',title='Synthetic',body='Synthetic body',template_id=None,template_revision=None,values={},versions={},party=None))
assert store.relationships.get_client(client['id'])['revision']==1
assert store.proposals.get(draft['id'])['versions'][0]['body']=='Synthetic body'
server = create_server(mode='demo', port=0)
server.server_close()
print('PASS installed wheel: schema, SQLite, demo server')
'''
    subprocess.run([sys.executable, '-I', '-c', code], cwd=directory, check=True)
