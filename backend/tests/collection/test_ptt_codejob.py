from datetime import datetime, timezone
import importlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from freelance.bootstrap.store import SQLiteStore
from freelance.modules.discovery.domain import qualify
from fixtures.domain import job, legacy_proposal

NOW = datetime(2026, 9, 19, tzinfo=timezone.utc)
PATH = '/bbs/CodeJob/M.1789626499.A.2F9.html'

def index(title='[發案] AI agent 後端 API', path=PATH):
    return (f'<div class="r-list-container"><div class="r-ent"><div class="title"><a href="{path}">{title}</a></div></div></div>'
            '<a href="/bbs/CodeJob/index521.html">上頁</a>').encode()

def article(body='工作內容：開發 AI agent 與後端 API。\n案件預算：詳談'):
    return f'<div id="main-content"><div class="article-metaline">SECRET_AUTHOR</div>{body}<span class="f2">SECRET_IP</span><div class="push">已解決 SECRET_COMMENT</div><script>SECRET_SCRIPT</script></div>'.encode()

class CodeJobTests(unittest.TestCase):
    def connector(self):
        self.assertIsNotNone(importlib.util.find_spec('freelance.modules.collection.ptt_codejob'), 'CodeJob connector is missing')
        return importlib.import_module('freelance.modules.collection.ptt_codejob')

    def test_classifies_demand_self_promotion_and_closed_threads(self):
        c = self.connector()
        for title in ('[發案] API', '[發包] 網站', '[徵才] 後端', '[發案] 近期專案需求'):
            self.assertEqual(len(c.parse_index(index(title), NOW)[0]), 1)
        for title in ('[個人] API', '[自介] 網站', '[自介] API 已結案', 'Re: [發案] API', '[問題] API', '[公告] API'):
            self.assertEqual(c.parse_index(index(title), NOW)[0], [])
        for title in ('[已解決] API', '[結案] API', '[解決] API', '[發案] 已徵到', '[發案] API（結案）'):
            self.assertTrue(c.parse_index(index(title), NOW)[0][0]['closed'])
        for path in ('https://evil.invalid/case', '/bbs/soho/M.1789626499.A.2F9.html', PATH+'?x=1', '/bbs/CodeJob/M.1471033318.A.3B2.html'):
            self.assertEqual(c.parse_index(index(path=path), NOW)[0], [])

    def test_article_unknowns_metadata_closure_and_full_time(self):
        c = self.connector(); entry = c.parse_index(index(), NOW)[0][0]
        parsed = c.parse_article(article(), entry)
        self.assertEqual(parsed['source'], 'ptt_codejob')
        self.assertTrue(parsed['receipt_id'].startswith('ptt_codejob:'))
        self.assertNotIn('SECRET', parsed['description'])
        self.assertFalse(parsed['listing_closed'])
        for key in ('budget_min', 'budget_max', 'weekly_hours', 'taiwan_eligible', 'timezone_compatible'):
            self.assertIsNone(parsed[key])
        for body in ('已解決\n後端 API 開發', '更新：本案已結案\n後端 API 開發'):
            self.assertEqual(qualify(c.parse_article(article(body), entry))['status'], 'excluded')
        self.assertFalse(c.parse_article(article('徵到為止\n後端 API 開發'), entry)['listing_closed'])
        hired = c.parse_index(index('[徵才] 全職後端 API 工程師'), NOW)[0][0]
        self.assertEqual(c.parse_article(article(), hired)['kind'], 'full_time')
        for raw in (b'captcha', article(''), b'\xff'):
            with self.assertRaises(ValueError): c.parse_article(raw, entry)
        with self.assertRaises(ValueError): c.parse_index(b'captcha', NOW)

    def test_body_employment_evidence_excludes_full_time_but_not_optional_or_negated(self):
        c = self.connector(); entry = c.parse_index(index(), NOW)[0][0]
        for body in ('職務性質：全職', '這是全職職缺', 'This is a full-time role',
                     '工作性質：全職', '招聘全職後端工程師'):
            with self.subTest(body=body):
                parsed = c.parse_article(article(body+'\n開發後端 API'), entry)
                self.assertEqual(parsed['kind'], 'full_time')
                self.assertEqual(qualify(parsed)['status'], 'excluded')
        for note in ('非全職', '不用全職', '不需要全職', '全職亦可/兼職亦可',
                     '全職或兼職皆可', 'not a full-time role', 'full-time or part-time'):
            with self.subTest(note=note):
                parsed = c.parse_article(article(note+'\n開發後端 API'), entry)
                self.assertEqual(parsed['kind'], 'contract')
                titled = c.parse_index(index('[徵才] API '+note), NOW)[0][0]
                self.assertEqual(c.parse_article(article(), titled)['kind'], 'contract')
        # A customer's staff role is not the contractor's employment type.
        incidental = c.parse_article(article('客戶已有全職工程師，需求為後端 API 串接'), entry)
        self.assertEqual(incidental['kind'], 'contract')

    def test_atomic_replay_closure_revokes_approval_preserves_tracking(self):
        c = self.connector(); entry = c.parse_index(index(), NOW)[0][0]
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteStore(Path(directory)/'db', clock=lambda: NOW); store.migrate()
            parsed = c.parse_article(article(), entry)
            self.assertEqual(c.sync(store, reader=lambda:[parsed, {'source':'evil'}])['status'], 'failed')
            self.assertEqual(store.list(), [])
            self.assertEqual(c.sync(store, reader=lambda:[parsed])['status'], 'ok')
            item = store.list()[0]; store.review(item['id'], 'edit', 1, text='Manual proposal')
            store.track(item['id'], 0, feedback='interested')
            c.sync(store, reader=lambda:[parsed])
            self.assertEqual(store.list()[0]['proposal'], 'Manual proposal')
            # A complete prior listing can have an approval before closure arrives.
            item = store.ingest(job(source='ptt_codejob', external_id=entry['external_id']))
            legacy_proposal(store, item)
            store.review(item['id'], 'approve', item['version'])
            result = c.sync(store, reader=lambda:[entry | {'closed':True, 'closure_only':True}])
            self.assertEqual(result['closed_updates'], 1)
            latest = store.list()[0]
            self.assertIsNone(latest['approved_hash'])
            self.assertEqual(latest['evaluation']['status'], 'excluded')
            self.assertEqual(latest['tracking']['feedback'], 'interested')
            self.assertEqual(store.sources()['ptt_codejob'], 'ok')
            self.assertEqual(store.create_digest(NOW.date(), 'test@example.invalid', NOW)['snapshot']['items'], [])

    def test_unknown_closed_and_nontechnical_not_added_and_failure_visible(self):
        c = self.connector(); entry = c.parse_index(index(), NOW)[0][0]
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteStore(Path(directory)/'db', clock=lambda:NOW); store.migrate()
            plain = c.parse_index(index('[發案] 海報設計'), NOW)[0][0]
            result = c.sync(store, reader=lambda:[entry|{'closed':True,'closure_only':True}, c.parse_article(article('製作平面海報一張'), plain)])
            self.assertEqual(result['status'], 'ok'); self.assertEqual(store.list(), [])
            self.assertEqual(c.sync(store, reader=lambda:None)['status'], 'failed')
            self.assertEqual(store.sources()['ptt_codejob'], 'failed')

    def test_fetch_caps_requests_and_never_follows_external_or_other_board_links(self):
        c = self.connector(); calls = []
        many = '<div class="r-list-container">'+''.join(f'<div class="r-ent"><div class="title"><a href="/bbs/CodeJob/M.{1789626499+i}.A.ABC.html">[發案] API工程師</a></div></div>' for i in range(30))+'</div><a href="/bbs/CodeJob/index521.html">上頁</a><a href="https://evil.invalid">上頁</a>'
        class Response:
            status = 200
            def __init__(self, raw): self.raw=raw; self.fp=Mock()
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read1(self, _): raw,self.raw=self.raw,b''; return raw
        class Opener:
            def open(self, req, timeout):
                calls.append(req.full_url)
                return Response(many.encode() if '/index' in req.full_url else article('<a href="https://evil.invalid">API需求</a>'))
        with patch.object(c, 'build_opener', return_value=Opener()), patch.object(c.time, 'sleep'), patch.object(c, 'datetime') as dates:
            dates.now.return_value=NOW; dates.fromtimestamp.side_effect=datetime.fromtimestamp
            result = c.fetch()
        self.assertEqual(len(result), 20); self.assertEqual(len(calls), 22)
        self.assertTrue(all(url.startswith('https://www.ptt.cc/bbs/CodeJob/') for url in calls))
