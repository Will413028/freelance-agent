import json
import subprocess
import unittest
from pathlib import Path
import tempfile
import sys
import time
from freelance.legacy.antigravity import generate, GenerationError


class AntigravityTests(unittest.TestCase):
    def test_success_uses_only_allowlisted_redacted_input_and_no_tools(self):
        captured = {}
        def runner(args, **kw):
            captured.update(kw)
            self.assertNotIn('--dangerously-skip-permissions', args)
            self.assertIn('--agent', args)
            spec = Path(kw['cwd'], '.agents/agents/freelance-writer/agent.md').read_text()
            self.assertIn('tools: []', spec)
            self.assertIn('commandExecutionPolicy: "off"', spec)
            self.assertNotIn('PRIVATE-RAW', kw['input'])
            self.assertNotIn('test@example.com', kw['input'])
            self.assertNotIn('https://secret.invalid/login', kw['input'])
            self.assertIn('共同', kw['input'])
            return subprocess.CompletedProcess(args, 0, json.dumps({'status':'SUCCESS','response':json.dumps({'proposal':'待確認需求的提案','questions':['請提供工期']}),'usage':{'total_tokens':8}}), '')
        job = {'title':'AI agent', 'description':'test@example.com https://secret.invalid/login?token=abc', 'raw':'PRIVATE-RAW'}
        result = generate(job, runner=runner)
        self.assertEqual(result['proposal'], '待確認需求的提案')
        self.assertTrue(result['requires_review'])
        self.assertNotIn('approved', result)
        self.assertEqual(job['raw'], 'PRIVATE-RAW')
        self.assertFalse(captured.get('shell', False))

    def test_invalid_or_unsuccessful_outputs_fail_without_leaking_logs(self):
        for code, output in [(1,'PRIVATE'), (0,''), (0,'not json'), (0,json.dumps({'status':'ERROR','error':'PRIVATE'})),
                             (0,json.dumps({'status':'SUCCESS','response':'{}'})),
                             (0,json.dumps({'status':'SUCCESS','response':json.dumps({'proposal':'x','questions':[],'approved':True})}))]:
            with self.subTest(output=output):
                def runner(*a, **kw):
                    return subprocess.CompletedProcess(a[0], code, output, 'PRIVATE')
                with self.assertRaises(GenerationError) as e:
                    generate({'title':'AI agent'}, runner=runner)
                self.assertNotIn('PRIVATE', str(e.exception))

    def test_timeout_is_not_retried(self):
        calls=[]
        def runner(*args, **kw):
            calls.append(1)
            raise subprocess.TimeoutExpired(args[0], 1)
        with self.assertRaises(GenerationError):
            generate({'title':'AI agent'}, runner=runner)
        self.assertEqual(len(calls), 1)

    def test_oversized_input_rejected_before_model(self):
        with self.assertRaises(ValueError):
            generate({'title':'x','description':'x'*20001}, runner=lambda *a,**kw: self.fail('must not call model'))

    def test_stream_refuses_tools_before_sending_input(self):
        from freelance.legacy.antigravity import _run
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory,'received')
            script='import json,sys; from pathlib import Path; print(json.dumps({"event":"init","init":{"tools":["run_command"]}}),flush=True); s=sys.stdin.readline(); Path("received").write_text(s) if s else None'
            with self.assertRaises(GenerationError):
                _run([sys.executable,'-c',script],input='PRIVATE',cwd=directory,timeout=3)
            self.assertFalse(marker.exists())

    def test_stream_sends_request_only_after_empty_tool_init(self):
        from freelance.legacy.antigravity import _run
        script='import json,sys; print(json.dumps({"event":"init","init":{"tools":[]}}),flush=True); x=json.loads(sys.stdin.readline()); print(json.dumps({"event":"result","result":{"status":"SUCCESS","response":x["message"]["content"]}}),flush=True)'
        r=_run([sys.executable,'-c',script],input=json.dumps({'event':'user','message':{'content':'safe'}})+'\n',cwd='.',timeout=3)
        self.assertEqual(json.loads(r.stdout)['response'],'safe')

    def test_malformed_init_fails_as_generation_error(self):
        from freelance.legacy.antigravity import _run
        for value in ('null','[]','"bad"'):
            script=f'import time; print(\'{{"event":"init","init":{value}}}\',flush=True); time.sleep(1)'
            with self.assertRaises(GenerationError):
                _run([sys.executable,'-c',script],input='private',cwd='.',timeout=.2)

    def test_nonreading_child_cannot_block_stdin_past_timeout(self):
        from freelance.legacy.antigravity import _run
        script='import json,time; print(json.dumps({"event":"init","init":{"tools":[]}}),flush=True); time.sleep(1)'
        start=time.monotonic()
        with self.assertRaises(GenerationError):
            _run([sys.executable,'-c',script],input='x'*90000,cwd='.',timeout=.2)
        self.assertLess(time.monotonic()-start,.8)
