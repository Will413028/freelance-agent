"""Isolated Compose acceptance. Only synthetic data; never starts live worker."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]

def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 3327))  # Do not replace an existing service.
    with tempfile.TemporaryDirectory(prefix='freelance-compose-') as directory:
        root = Path(directory)
        for name in ('data', 'queue', 'config'):
            (root / name).mkdir(mode=0o700)
        (root / 'config/worker.json').write_text(json.dumps({
            'database': '/data/freelance-agent.sqlite3', 'output_dir': '/data',
            'key_file': '/run/config/never-read.json', 'inbox': 'synthetic@example.invalid',
            'recipient': 'synthetic@example.invalid', 'live_read': True}))
        env = os.environ | {'DATA_DIR': str(root / 'data'), 'QUEUE_DIR': str(root / 'queue'),
                            'CONFIG_DIR': str(root / 'config'), 'APP_UID': str(os.getuid()),
                            'APP_GID': str(os.getgid())}
        # Linux volumes preserve flock/SQLite semantics on Docker Desktop too.
        override = root / 'volumes.yaml'
        override.write_text('services:\n  worker:\n    volumes:\n'
                            '      - check-data:/data\n      - check-queue:/queue\n'
                            '  api:\n    volumes:\n      - check-data:/data\n'
                            'volumes:\n  check-data: {}\n  check-queue: {}\n')
        command = ['docker', 'compose', '-f', str(ROOT / 'deploy/compose.yaml'),
                   '-f', str(override), '-p', 'freelance-check-' + uuid4().hex[:8], '--profile', 'ui']
        logpath = ROOT / 'runtime/compose-check.log'
        logpath.parent.mkdir(exist_ok=True)
        with logpath.open('w') as log:
            def compose(*args):
                subprocess.run(command + list(args), env=env, check=True, stdout=log, stderr=log, timeout=180)

            def request(path, body=None, host=None, method=None):
                headers = {'Origin': 'http://127.0.0.1:3327', 'Content-Type': 'application/json'}
                if host:
                    headers['Host'] = host
                req = Request('http://127.0.0.1:3327/api/' + path,
                              data=None if body is None else json.dumps(body).encode(), headers=headers,
                              method=method)
                try:
                    with urlopen(req, timeout=10) as response:
                        return response.status, json.load(response)
                except HTTPError as exc:
                    with exc:
                        return exc.code, json.load(exc)

            try:
                compose('run', '--rm', '--no-deps', '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
                        '--entrypoint', 'python', 'worker', '-c',
                        f"import os; [os.chown(p,{os.getuid()},{os.getgid()}) for p in ('/data','/queue')]; "
                        "[os.chmod(p,0o700) for p in ('/data','/queue')]")
                compose('run', '--rm', '--no-deps', '--volume', str(ROOT / 'backend/tests') + ':/checks:ro',
                        'worker', 'unittest', 'discover', '-s', '/checks', '-p', 'test_huey_runner.py', '-v')
                compose('run', '--rm', '--no-deps', '--volume', str(ROOT / 'backend/tests') + ':/checks:ro',
                        'worker', 'unittest', 'discover', '-s', '/checks', '-p', 'test_worker.py', '-v')
                compose('run', '--rm', '--no-deps', 'worker', 'freelance.bootstrap.store', '--migrate',
                        '--database', '/data/freelance-agent.sqlite3')
                compose('run', '--rm', '--no-deps', '--entrypoint', 'python', 'worker', '-c',
                        "from freelance.bootstrap.store import SQLiteStore; from datetime import datetime; "
                        "from zoneinfo import ZoneInfo; s=SQLiteStore('/data/freelance-agent.sqlite3'); "
                        "now=datetime.now(ZoneInfo('Asia/Taipei')); day=str(now.date()); "
                        "s.claim_daily_run(day,'synthetic@example.invalid',now); "
                        "s.finish_daily_run(day,'synthetic@example.invalid','complete',{'synthetic':True},now)")
                compose('up', '-d', '--wait', 'api', 'web', 'worker')
                deadline = time.monotonic() + 30
                while True:
                    try:
                        status, dashboard = request('dashboard')
                        if status == 200:
                            break
                    except (URLError, TimeoutError, ConnectionError):
                        pass
                    if time.monotonic() > deadline:
                        raise AssertionError('container Web → API did not become ready')
                    time.sleep(.2)
                self_settings = dashboard['preferences']
                self_settings['settings']['max_weekly_hours'] = 24
                assert request('preferences', self_settings)[0] == 200
                assert request('dashboard', host='evil.example')[0] == 403
                assert request('not-a-route')[0] == 404
                # Exercise the real Next.js proxy, not browser request interception.
                status, summary = request('applications/summary')
                assert status == 200
                body = dict(request_id='compose-synthetic', title='Synthetic referral', contact='', url=None,
                            applied_on=summary['today'], stage='applied', follow_up_on=summary['today'],
                            note='Synthetic only', versions={})
                status, application = request('applications', body)
                assert status == 200
                assert request('applications', body)[1]['id'] == application['id']
                assert request('applications?due=true')[1]['total'] == 1
                update = {key: application[key] for key in ('title','contact','url','applied_on','stage',
                                                          'follow_up_on','note','revision')}
                update['stage'] = 'negotiating'
                assert request('applications/' + application['id'], update, method='PATCH')[0] == 200
                assert request('applications/' + application['id'], update, method='PATCH')[0] == 409
                status, client = request('clients',dict(request_id='compose-client',name='Synthetic client',note=''))
                assert status==200
                status, contact=request('contacts',dict(request_id='compose-contact',client_id=client['id'],client_revision=1,name='Synthetic person',address='person@example.test',note=''))
                assert status==200
                status, draft=request('proposals',dict(request_id='compose-draft',title='Synthetic draft',body='First synthetic version',template_id=None,template_revision=None,values={},versions={},party=None))
                assert status==200
                assert request('proposals/'+draft['id']+'/versions',dict(revision=1,request_id='compose-edit',body='Second synthetic version'))[0]==200
                assert request('proposals/'+draft['id']+'/versions',dict(revision=1,request_id='compose-stale',body='Stale'))[0]==409
                status, intent=request('submissions',dict(request_id='compose-intent',draft_id=draft['id'],draft_version=1,provider='email',environment='live',account='sender@example.test',fields={'from':'sender@example.test','to':'recipient@example.test','subject':'Synthetic'}))
                assert status==200 and intent['snapshot']['body']=='First synthetic version'
                status, approved=request('submissions/'+intent['id']+'/approve',dict(revision=1,snapshot_hash=intent['snapshot_hash']))
                assert status==200
                assert request('submissions/'+intent['id']+'/dispatch',dict(revision=approved['revision']))[0]==409
                # Stage a synthetic pending task, then execute the rollback contract.
                compose('stop','worker')
                compose('run','--rm','--no-deps','--entrypoint','python','worker','-c',
                        "from freelance.bootstrap.queue import build_queue,register_submission_task; "
                        "from freelance.bootstrap.store import SQLiteStore; "
                        "q,_=build_queue('/queue/queue.sqlite',lambda day:None); "
                        "register_submission_task(q,lambda key:None)({'schema_version':1,'intent_id':"+repr(intent['id'])+"}); "
                        "s=SQLiteStore('/data/freelance-agent.sqlite3'); assert s.submissions.cancel_pending_for_rollback()==1; "
                        "old,_=build_queue('/queue/rollback.sqlite',lambda day:None); assert old.dequeue() is None")
                compose('up', '-d', '--force-recreate', '--wait', 'api', 'web', 'worker')
                deadline = time.monotonic() + 30
                while True:
                    try:
                        status, dashboard = request('dashboard')
                        if status == 200:
                            break
                    except (URLError, TimeoutError, ConnectionError):
                        pass
                    if time.monotonic() > deadline:
                        raise AssertionError('recreated Web did not become ready')
                    time.sleep(.2)
                assert dashboard['preferences']['settings']['max_weekly_hours'] == 24
                assert request('clients/'+client['id'])[1]['name']=='Synthetic client'
                assert request('clients/'+client['id']+'/contacts')[1]['items'][0]['id']==contact['id']
                assert [r['body'] for r in request('proposals/'+draft['id'])[1]['versions']]==['First synthetic version','Second synthetic version']
                assert request('submissions/'+intent['id'])[1]['status']=='cancelled'
                assert not request('submission-capabilities')[1]['email']['can_dispatch']
                status, persisted = request('applications/' + application['id'])
                assert status == 200 and persisted['stage'] == 'negotiating' and persisted['revision'] == 2
                assert request('applications?stage=closed')[1]['total'] == 0
                assert request('applications/' + application['id'], {'revision': 2}, method='DELETE')[0] == 200
                assert request('applications')[1]['total'] == 0
                print('PASS Compose: consumer recovery, real Web/API proxy, persistent applications/clients/contacts/draft revisions, exact consent, disabled adapters, pending-task rollback isolation and revision guards')
            finally:
                try:
                    result = subprocess.run(command + ['ps', '-a', '--format', 'json'], env=env,
                                            capture_output=True, text=True, timeout=30)
                    log.write(result.stdout)
                    ids = subprocess.run(command + ['ps', '-a', '-q'], env=env,
                                         capture_output=True, text=True, timeout=30).stdout.split()
                    if ids:
                        subprocess.run(['docker', 'inspect', '--format', '{{.Name}} {{json .State.Health}}', *ids],
                                       stdout=log, stderr=log, timeout=30)
                    subprocess.run(command + ['logs', '--no-color'], env=env, stdout=log, stderr=log, timeout=30)
                finally:
                    subprocess.run(command + ['down', '--remove-orphans', '--volumes'], env=env,
                                   stdout=log, stderr=log, timeout=60, check=True)

if __name__ == '__main__':
    main()
