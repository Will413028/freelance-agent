"""CLI drafting with a verified external-tool deny hook; not an OS sandbox.

A synthetic read must be denied in the same process before listing input is sent.
The CLI owns authentication and may persist supplied conversation content.
"""
from hashlib import sha256
import json
import os
import re
from pathlib import Path
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import time
from uuid import uuid4

from freelance.legacy.antigravity import GenerationError, generate as generate_text

MAX_OUTPUT = 100000


def file_hash(path):
    h=sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()


def preflight(executable, certification, *, settings=None):
    try:
        settings=Path(settings) if settings else Path.home()/'.gemini/antigravity-cli/settings.json'
        config=json.loads(settings.read_text())
        proof_path=Path(certification)
        info=proof_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600:
            raise ValueError()
        proof=json.loads(proof_path.read_text())
        # The certified CLI omits false values when saving settings; the official default is false.
        if (config.get('useG1Credits',False) is not False or proof.get('passed') is not True
                or proof.get('cli_sha256')!=file_hash(executable)
                or proof.get('guard_sha256')!=file_hash(__file__)):
            raise ValueError()
    except (OSError,ValueError,TypeError,AttributeError):
        raise GenerationError('Antigravity guard certification or credit setting not verified') from None


def _guard_files(cwd):
    root=Path(cwd).resolve();directory=root/'.agents';directory.mkdir(exist_ok=True)
    nonce=uuid4().hex;secret=uuid4().hex
    canary=root/'canary';canary.write_text(secret);canary.chmod(0o600)
    audit=root/('gate-'+nonce+'.jsonl');audit.touch(mode=0o600)
    script=root/('deny-'+nonce+'.py')
    script.write_text('''import json,os,sys
try:
    data=json.loads(sys.stdin.read(100001))
    call=data.get('toolCall',{})
    record={'nonce':NONCE,'conversation':data.get('conversationId'),'tool':call.get('name'),
            'canary':call.get('args',{}).get('AbsolutePath')==CANARY}
    fd=os.open(AUDIT,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW)
    with os.fdopen(fd,'w') as f:f.write(json.dumps(record)+'\\n')
except Exception:
    pass
print(json.dumps({'decision':'allow' if locals().get('call',{}).get('name')=='finish' else 'deny','reason':'Only internal finish is permitted'}),flush=True)
'''.replace('NONCE',repr(nonce)).replace('CANARY',repr(str(canary))).replace('AUDIT',repr(str(audit))))
    script.chmod(0o400)
    config=directory/'hooks.json'
    config.write_text(json.dumps({'writer-deny':{'PreToolUse':[{'matcher':'*','hooks':[
        {'type':'command','command':shlex.join([sys.executable,str(script)]),'timeout':5}]}]}}))
    config.chmod(0o400)
    expected={p:file_hash(p) for p in (script,config,canary)}
    def records():
        with audit.open('rb') as f:raw=f.read(MAX_OUTPUT+1)
        if len(raw)>MAX_OUTPUT:raise GenerationError('Antigravity guard audit limit')
        try:
            values=[json.loads(line) for line in raw.splitlines()]
            if any(not isinstance(x,dict) for x in values):raise ValueError()
            return values
        except ValueError:raise GenerationError('Invalid guard evidence') from None
    def intact():
        if any(file_hash(p)!=digest for p,digest in expected.items()):
            raise GenerationError('Antigravity guard configuration changed')
    return canary,secret,nonce,records,intact


def guarded_run(args, *, input, cwd, timeout, **_ignored):
    canary,secret,nonce,records,intact=_guard_files(cwd)
    command=list(args)
    if '--agent' in command:
        i=command.index('--agent');del command[i:i+2]
    # CLI 1.2.7 reuses the first turn's structured_output on later turns.
    # Parse the fresh response locally instead of trusting that stale envelope.
    if '--json-schema' in command:
        i=command.index('--json-schema');del command[i:i+2]
    command+=['--new-project','--effort','low']
    bootstrap=json.dumps({'event':'user','message':{'content':
        'Synthetic permission check. Call view_file exactly once on '+str(canary)+
        '. If denied, do not call any other tool. Return JSON {"proposal":"READY","questions":[]}.'}})+'\n'
    proc=subprocess.Popen(command,cwd=cwd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL,start_new_session=True)
    selector=selectors.DefaultSelector()
    os.set_blocking(proc.stdout.fileno(),False);os.set_blocking(proc.stdin.fileno(),False)
    selector.register(proc.stdout,selectors.EVENT_READ)
    deadline=time.monotonic()+timeout
    pending=b'';buffer=b'';size=0;initialized=False;phase='init';conversation=None;baseline=None;answer=None;eof=False;tail=b''
    def evidence():
        values=records()
        if any(x.get('nonce')!=nonce or x.get('conversation')!=conversation for x in values):
            raise GenerationError('Invalid guard evidence identity')
        return [x for x in values if x.get('tool')!='finish']
    def enqueue(value):
        nonlocal pending
        if pending:raise GenerationError('Antigravity input overlap')
        pending=value.encode()
        selector.register(proc.stdin,selectors.EVENT_WRITE)
    try:
        while not eof:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise GenerationError('Antigravity timed out; no retry')
            events=selector.select(remaining)
            if not events:raise GenerationError('Antigravity timed out; no retry')
            for key,mask in events:
                if key.fileobj is proc.stdin:
                    count=os.write(proc.stdin.fileno(),pending[:65536]);pending=pending[count:]
                    if not pending:selector.unregister(proc.stdin)
                    continue
                chunk=os.read(proc.stdout.fileno(),65536)
                if not chunk:
                    if answer is None or buffer.strip():raise GenerationError('Antigravity ended before complete draft')
                    eof=True;break
                size+=len(chunk)
                if size>MAX_OUTPUT:raise GenerationError('Antigravity output exceeded limit')
                if secret.encode() in tail+chunk:raise GenerationError('Antigravity canary leaked; input withheld')
                tail=(tail+chunk)[-len(secret)+1:]
                buffer+=chunk
                while b'\n' in buffer:
                    line,buffer=buffer.split(b'\n',1)
                    try:
                        event=json.loads(line)
                        if not isinstance(event,dict):raise ValueError()
                    except ValueError:raise GenerationError('Invalid Antigravity stream') from None
                    name=event.get('event')
                    if name=='init':
                        info=event.get('init');conversation=event.get('conversation_id')
                        if initialized or not isinstance(info,dict) or info.get('permission_mode')!='request-review' or not isinstance(conversation,str) or not conversation:
                            raise GenerationError('Antigravity initialization not verified')
                        initialized=True;phase='bootstrap';enqueue(bootstrap)
                    elif name=='step_update' and phase in ('draft','complete'):
                        step=event.get('step_update')
                        if not isinstance(step,dict) or (step.get('step_type')=='tool' and step.get('tool_name')!='finish') or (step.get('tool_name') and step.get('tool_name')!='finish') or step.get('subagent_info'):
                            raise GenerationError('Antigravity attempted a tool; draft refused')
                    elif name=='result':
                        result=event.get('result')
                        if not initialized or not isinstance(result,dict) or result.get('status')!='SUCCESS':
                            raise GenerationError('Antigravity unsuccessful turn')
                        if result.get('conversation_id',conversation)!=conversation:
                            raise GenerationError('Antigravity conversation changed')
                        intact();observed=evidence()
                        if phase=='bootstrap':
                            if (not observed or any(x.get('tool')!='view_file' or x.get('canary') is not True for x in observed)
                                or secret in json.dumps(result)):
                                raise GenerationError('Antigravity deny hook not verified; input withheld')
                            baseline=observed;phase='draft';enqueue(input)
                        elif phase=='draft':
                            if observed!=baseline:raise GenerationError('Antigravity attempted a tool; draft refused')
                            answer=result;phase='complete'
                            if pending:raise GenerationError('Incomplete Antigravity request')
                            proc.stdin.close()
                        else:raise GenerationError('Unexpected Antigravity result')
            if phase in ('draft','complete') and evidence()!=baseline:
                raise GenerationError('Antigravity attempted a tool; draft refused')
        if pending:raise GenerationError('Incomplete Antigravity request')
        proc.wait(timeout=max(.01,deadline-time.monotonic()))
        intact()
        if proc.returncode!=0 or evidence()!=baseline:raise GenerationError('Antigravity guard final check failed')
        return subprocess.CompletedProcess(command,0,json.dumps(normalize_draft_result(answer)),'')
    except (OSError,subprocess.TimeoutExpired):
        raise GenerationError('Antigravity unavailable or timed out; no retry') from None
    finally:
        # Also kill descendants which can keep pipes open after the CLI exits.
        try:os.killpg(proc.pid,signal.SIGKILL)
        except (ProcessLookupError,PermissionError):
            if proc.poll() is None:proc.kill()
        proc.wait();selector.close()
        if not proc.stdin.closed:proc.stdin.close()
        proc.stdout.close()


def generate(job, *, executable, certification):
    preflight(executable,certification)
    result=generate_text(job,executable=executable,runner=guarded_run)
    result['method']='Antigravity CLI（外部工具執行已封鎖）'
    return result


def normalize_draft_result(result):
    try:
        raw=result.get('response')
        if not isinstance(raw,str) or len(raw)>20000:raise ValueError()
        raw=raw.strip()
        fenced=re.fullmatch(r'```(?:json)?\s*\n(.*?)\n```',raw,re.S)
        if fenced:raw=fenced[1]
        output=json.loads(raw)
        if (not isinstance(output,dict) or set(output)!={'proposal','questions'}
            or not isinstance(output['proposal'],str) or not 80<=len(output['proposal'].strip())<=10000
            or not isinstance(output['questions'],list) or len(output['questions'])>20
            or any(not isinstance(q,str) or not 1<=len(q)<=500 for q in output['questions'])):
            raise ValueError()
        return {'status':'SUCCESS','response':json.dumps(output,ensure_ascii=False)}
    except (ValueError,TypeError,AttributeError):
        raise GenerationError('Antigravity returned no substantive current-turn draft') from None
