import json
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import freelance.bootstrap.api as server


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.httpd = server.create_server(port=0)
        self.thread = Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()

    def request(self, path, body=None, origin="http://127.0.0.1:3327"):
        headers = {"Origin": origin, "Content-Type": "application/json"}
        req = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with urlopen(req, timeout=3) as response:
                return response.status, response.read()
        except HTTPError as e:
            with e:
                return e.code, e.read()

    def test_demo_dashboard_and_feedback_roundtrip(self):
        status, raw = self.request("/dashboard")
        data = json.loads(raw)
        self.assertEqual(status, 200)
        self.assertEqual(data["mode"], "demo")
        item = next(x for x in data["items"] if x["evaluation"]["status"] == "qualified")
        versions = {member['id']: member['token'] for member in item['members']}
        status, raw = self.request("/feedback/" + item["id"], {"feedback": "interested", "versions": versions})
        self.assertEqual(status, 200)
        status, _ = self.request("/feedback/" + item["id"], {"feedback": "neutral", "versions": versions})
        self.assertEqual(status, 409)

    def test_persistent_mode_requires_store_and_rejects_unknown_mode(self):
        for kwargs in ({'mode':'postgres'}, {'mode':'sqlite'}, {'mode':'unknown'}):
            with self.assertRaises(ValueError):
                server.create_server(port=0, **kwargs)

    def test_store_failure_returns_sanitized_503_without_demo_fallback(self):
        class FailedStore:
            def list(self): raise RuntimeError('SECRET DSN')
            def sources(self): raise RuntimeError('SECRET DSN')
            def feedback(self,*args,**kwargs): raise RuntimeError('SECRET DSN')
        httpd=server.create_server(port=0,store=FailedStore(),mode='sqlite')
        thread=Thread(target=httpd.serve_forever,daemon=True);thread.start()
        previous=self.base; self.base=f'http://127.0.0.1:{httpd.server_port}'
        try:
            for path,body in [('/dashboard',None),('/digest',None),('/feedback/any',{'feedback':'interested','versions':{}})]:
                status,raw=self.request(path,body)
                self.assertEqual(status,503)
                self.assertNotIn('SECRET',raw.decode())
        finally:
            self.base=previous;httpd.shutdown();httpd.server_close();thread.join()

    def test_cross_origin_review_rejected(self):
        status, _ = self.request("/feedback/anything", {}, origin="https://attacker.example")
        self.assertEqual(status, 403)

    def test_missing_route_and_bad_json_shape(self):
        self.assertEqual(self.request("/absent")[0], 404)
        self.assertEqual(self.request("/review/anything", [1, 2])[0], 400)

    def test_digest_is_explicitly_unsent_preview(self):
        status, html = self.request("/digest")
        self.assertEqual(status, 200)
        self.assertIn("尚未寄出", html.decode())
