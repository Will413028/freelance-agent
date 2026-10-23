import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from freelance.legacy.antigravity import GenerationError
from freelance.legacy.antigravity_guard import guarded_run, preflight, file_hash, normalize_draft_result
import freelance.legacy.antigravity_guard as guard_module

FAKE='''import sys,json,subprocess,shlex
from pathlib import Path
mode=sys.argv[1]
print(json.dumps({'event':'init','conversation_id':'test-conversation','init':{'tools':['view_file','write_to_file'],'permission_mode':'request-review'}}),flush=True)
bootstrap=json.loads(sys.stdin.readline())
if mode=='flood':
 sys.stdout.write('x'*110000);sys.stdout.flush();sys.exit()
if mode!='nohook':
 config=json.loads(Path('.agents/hooks.json').read_text())
 cmd=config['writer-deny']['PreToolUse'][0]['hooks'][0]['command']
 canary=str(Path('canary').resolve())
 call={'conversationId':'test-conversation','toolCall':{'name':'view_file','args':{'AbsolutePath':canary}}}
 subprocess.run(shlex.split(cmd),input=json.dumps(call),text=True,capture_output=True,check=True)
if mode=='leak':
 print(json.dumps({'event':'step_update','step_update':{'step_type':'agent_response','text_delta':Path('canary').read_text()}}),flush=True)
if mode=='finish':
 call['toolCall']={'name':'finish','args':{}}
 r=subprocess.run(shlex.split(cmd),input=json.dumps(call),text=True,capture_output=True,check=True)
 assert json.loads(r.stdout)['decision']=='allow'
print(json.dumps({'event':'result','result':{'status':'SUCCESS','response':'ready'}}),flush=True)
line=sys.stdin.readline()
if line:
 Path('received').write_text(line)
 if mode=='finish':
  subprocess.run(shlex.split(cmd),input=json.dumps(call),text=True,capture_output=True,check=True)
  print(json.dumps({'event':'step_update','step_update':{'step_type':'tool','tool_name':'finish'}}),flush=True)
 if mode=='audit':subprocess.run(shlex.split(cmd),input=json.dumps(call),text=True,capture_output=True,check=True)
 if mode=='tamper':
  Path('.agents/hooks.json').chmod(0o600);Path('.agents/hooks.json').write_text('{}')
 if mode=='tool':
  print(json.dumps({'event':'step_update','step_update':{'step_type':'tool','tool_name':'view_file'}}),flush=True)
 else:
  print(json.dumps({'event':'result','result':{'status':'SUCCESS','response':json.dumps({'proposal':'Draft '+('specific project details '*5),'questions':[]})}}),flush=True)
 sys.stdin.read()
 if mode=='late':print(json.dumps({'event':'step_update','step_update':{'step_type':'tool','tool_name':'run_command'}}),flush=True)
'''

class GuardTests(unittest.TestCase):
    def run_fake(self,mode,d):
        return guarded_run([sys.executable,'-c',FAKE,mode],input='PRIVATE JOB\n',cwd=d,timeout=2)
    def test_bootstrap_real_hook_then_second_turn(self):
        with tempfile.TemporaryDirectory() as d:
            result=self.run_fake('ok',d)
            self.assertTrue(json.loads(json.loads(result.stdout)['response'])['proposal'].startswith('Draft '))
            self.assertEqual(Path(d,'received').read_text(),'PRIVATE JOB\n')
    def test_missing_hook_evidence_never_sends_job(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(GenerationError):self.run_fake('nohook',d)
            self.assertFalse(Path(d,'received').exists())
    def test_generation_tool_attempt_rejects_output(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(GenerationError):self.run_fake('tool',d)
    def test_no_newline_flood_is_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            start=time.monotonic()
            with self.assertRaises(GenerationError):self.run_fake('flood',d)
            self.assertLess(time.monotonic()-start,1.8)
            self.assertFalse(Path(d,'received').exists())
    def test_leaked_canary_step_and_late_tool_event_are_refused(self):
        for mode in ('leak','late'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d:
                with self.assertRaises(GenerationError):self.run_fake(mode,d)
    def test_silent_tool_audit_and_guard_tamper_reject_output(self):
        for mode in ('audit','tamper'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d:
                with self.assertRaises(GenerationError):self.run_fake(mode,d)
    def test_internal_finish_tool_can_return_text(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.run_fake('finish',d).returncode,0)
    def test_credit_fallback_requires_effective_false_and_valid_certification(self):
        with tempfile.TemporaryDirectory() as d:
            config=Path(d,'settings.json');cert=Path(d,'verified.json')
            cert.write_text(json.dumps({'passed':True,'cli_sha256':file_hash(sys.executable),'guard_sha256':file_hash(guard_module.__file__)}));cert.chmod(0o600)
            config.write_text('{"useG1Credits":false}');preflight(sys.executable,cert,settings=config)
            for value in (None,True,'false',0):
                config.write_text(json.dumps({'useG1Credits':value}))
                with self.assertRaises(GenerationError):preflight(sys.executable,cert,settings=config)
            config.write_text('{}');preflight(sys.executable,cert,settings=config)
            config.write_text('{"useG1Credits":false}');cert.write_text('{}')
            with self.assertRaises(GenerationError):preflight(sys.executable,cert,settings=config)

    def test_fresh_response_used_instead_of_previous_structured_result(self):
        payload={'proposal':'A specific tailored proposal. '*5,'questions':['Scope?']}
        value=normalize_draft_result({'status':'SUCCESS','structured_output':{'proposal':'READY','questions':[]},'response':'```json\n'+json.dumps(payload)+'\n```'})
        self.assertNotIn('structured_output',value)
        self.assertEqual(json.loads(value['response']),payload)
        for response in ('READY',json.dumps({'proposal':'READY','questions':[]}), 'prefix '+json.dumps(payload)):
            with self.assertRaises(GenerationError):normalize_draft_result({'status':'SUCCESS','response':response})

    def test_certification_hash_mode_and_symlink_are_enforced(self):
        with tempfile.TemporaryDirectory() as d:
            config=Path(d,'settings.json');config.write_text('{"useG1Credits":false}')
            cert=Path(d,'cert.json')
            proof={'passed':True,'cli_sha256':file_hash(sys.executable),'guard_sha256':file_hash(guard_module.__file__)}
            for field in ('cli_sha256','guard_sha256','passed'):
                cert.write_text(json.dumps(proof|{field:False}));cert.chmod(0o600)
                with self.assertRaises(GenerationError):preflight(sys.executable,cert,settings=config)
            cert.write_text(json.dumps(proof));cert.chmod(0o644)
            with self.assertRaises(GenerationError):preflight(sys.executable,cert,settings=config)
            cert.chmod(0o600);link=Path(d,'link.json');link.symlink_to(cert)
            with self.assertRaises(GenerationError):preflight(sys.executable,link,settings=config)
