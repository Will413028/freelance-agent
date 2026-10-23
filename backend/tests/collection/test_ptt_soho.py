from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from freelance.bootstrap.store import SQLiteStore
from freelance.modules.discovery.domain import qualify
from fixtures.domain import job, legacy_proposal
import freelance.modules.collection.ptt_soho as ptt_soho

NOW=datetime(2026,9,19,tzinfo=timezone.utc)
PATH='/bbs/soho/M.1789626499.A.2F9.html'

def index(title='[徵才] AI agent 後端 API',path=PATH):
    return f'<div class="r-list-container"><div class="r-ent"><div class="title"><a href="{path}">{title}</a></div></div></div><a class="btn wide" href="/bbs/soho/index1442.html">上頁</a>'.encode()
def article(body='工作內容：開發AI agent與後端API。\n案件預算：詳談',extra=''):
    return f'<div id="main-content"><div class="article-metaline"><span>作者 SECRET_AUTHOR</span></div>{body}<span class="f2">※ 發信站：SECRET_IP</span><div class="push">已徵到 SECRET_COMMENT</div>{extra}</div>'.encode()

class PTTTests(unittest.TestCase):
    def entry(self):return ptt_soho.parse_index(index(),NOW)[0][0]
    def test_only_hiring_and_canonical_recent_paths(self):
        entries,previous=ptt_soho.parse_index(index(),NOW)
        self.assertEqual(len(entries),1);self.assertEqual(previous,'/bbs/soho/index1442.html')
        for title in ('[自介] AI agent後端','Re: [徵才] API','[公告] API','[合作] 找AI合夥人'):
            self.assertEqual(ptt_soho.parse_index(index(title),NOW)[0],[])
        for path in ('https://evil.invalid/case','/bbs/other/M.1789626499.A.2F9.html','/bbs/soho/M.1789626499.A.2F9.html?q=bad','/bbs/soho/M.1471033318.A.3B2.html'):
            self.assertEqual(ptt_soho.parse_index(index(path=path),NOW)[0],[])
    def test_title_closure_kept_as_update_signal_and_not_demand(self):
        entries,_=ptt_soho.parse_index(index('[徵才] 已徵到'),NOW)
        self.assertTrue(entries[0]['closed'])
    def test_article_excludes_metadata_pushes_scripts_keeps_unknowns(self):
        parsed=ptt_soho.parse_article(article(extra='<script>SECRET_SCRIPT</script>'),self.entry())
        self.assertIn('後端API',parsed['description']);self.assertNotIn('SECRET',parsed['description'])
        self.assertFalse(parsed['listing_closed'])
        for field in ('weekly_hours','budget_min','budget_max','taiwan_eligible','timezone_compatible'):
            self.assertIsNone(parsed[field])
        self.assertEqual(parsed['language'],'zh-TW');self.assertEqual(qualify(parsed)['status'],'needs_info')
        self.assertIn('+00:00',parsed['published_at'])
    def test_invalid_or_empty_article_and_challenge_fail(self):
        for raw in (b'<html>challenge</html>',article(''),b'\xff'):
            with self.assertRaises(ValueError):ptt_soho.parse_article(raw,self.entry())
        with self.assertRaises(ValueError):ptt_soho.parse_index(b'captcha',NOW)
    def test_body_closure_hard_excluded_but_until_filled_is_not_closed(self):
        closed=ptt_soho.parse_article(article('已徵到\n開發後端 API'),self.entry())
        self.assertEqual(qualify(closed)['status'],'excluded')
        open_job=ptt_soho.parse_article(article('徵求期限：徵到為止\n開發 API'),self.entry())
        self.assertFalse(open_job['listing_closed'])
    def test_sync_replay_and_closure_preserve_tracking_without_stale_recommendation(self):
        with tempfile.TemporaryDirectory() as directory:
            store=SQLiteStore(Path(directory)/'db',clock=lambda:NOW);store.migrate()
            parsed=ptt_soho.parse_article(article(),self.entry())
            first=ptt_soho.sync(store,reader=lambda:[parsed])
            self.assertEqual(first['status'],'ok');self.assertEqual(first['jobs'],1)
            item=store.list()[0];store.review(item['id'],'edit',1,text='Manual proposal')
            store.track(item['id'],0,feedback='interested')
            ptt_soho.sync(store,reader=lambda:[parsed])
            self.assertEqual(store.list()[0]['proposal'],'Manual proposal')
            closed=dict(self.entry(),closed=True,title='[徵才] 已徵到',closure_only=True)
            result=ptt_soho.sync(store,reader=lambda:[closed])
            self.assertEqual(result['closed_updates'],1)
            latest=store.list()[0]
            self.assertEqual(latest['evaluation']['status'],'excluded')
            self.assertEqual(latest['tracking']['feedback'],'interested')
            self.assertEqual(store.create_digest(NOW.date(),'test@example.invalid',NOW)['snapshot']['items'],[])
            self.assertEqual(store.sources()['ptt_soho'],'ok')
    def test_unknown_closed_listing_not_added_and_failure_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            store=SQLiteStore(Path(directory)/'db');store.migrate()
            closed=dict(self.entry(),closed=True,closure_only=True)
            ptt_soho.sync(store,reader=lambda:[closed]);self.assertEqual(store.list(),[])
            def fail():raise ValueError('unavailable')
            self.assertEqual(ptt_soho.sync(store,reader=fail)['status'],'failed')
            self.assertEqual(store.sources()['ptt_soho'],'failed')

    def test_transaction_rolls_back_if_any_listing_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            store=SQLiteStore(Path(directory)/'db');store.migrate()
            parsed=ptt_soho.parse_article(article(),self.entry())
            result=ptt_soho.sync(store,reader=lambda:[parsed,{'source':'evil'}])
            self.assertEqual(result['status'],'failed');self.assertEqual(store.list(),[])

    def test_closure_revokes_previously_approved_case(self):
        with tempfile.TemporaryDirectory() as directory:
            store=SQLiteStore(Path(directory)/'db',clock=lambda:NOW);store.migrate()
            item=store.ingest(job(source='ptt_soho',external_id=self.entry()['external_id']))
            legacy_proposal(store, item)
            store.review(item['id'],'approve',1)
            ptt_soho.sync(store,reader=lambda:[self.entry()|{'closed':True,'closure_only':True}])
            updated=store.list()[0]
            self.assertEqual(updated['evaluation']['status'],'excluded')
            self.assertIsNone(updated['approved_hash'])

    def test_fetch_fixed_host_two_pages_and_max_twenty_bodies(self):
        from unittest.mock import patch, Mock
        class Response:
            status=200
            def __init__(self,raw):self.raw=raw;self.fp=Mock()
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read1(self,_):
                raw,self.raw=self.raw,b""
                return raw
        calls=[]
        many='<div class="r-list-container">'+''.join(f'<div class="r-ent"><div class="title"><a href="/bbs/soho/M.{1789626499+i}.A.ABC.html">[徵才] API工程師</a></div></div>' for i in range(30))+'</div><a href="/bbs/soho/index1442.html">上頁</a>'
        class Opener:
            def open(self,req,timeout):
                calls.append(req.full_url)
                return Response(many.encode() if '/index' in req.full_url else article())
        with patch('freelance.modules.collection.ptt_soho.build_opener',return_value=Opener()),patch('freelance.modules.collection.ptt_soho.time.sleep'),patch('freelance.modules.collection.ptt_soho.datetime') as dates:
            dates.now.return_value=NOW
            dates.fromtimestamp.side_effect=datetime.fromtimestamp
            results=ptt_soho.fetch()
        self.assertEqual(len(results),20);self.assertEqual(len(calls),22)
        self.assertTrue(all(url.startswith('https://www.ptt.cc/bbs/soho/') for url in calls))

    def test_body_deadline_checked_during_stream_and_socket_timeout_shrinks(self):
        from unittest.mock import Mock, patch
        response=Mock()
        ticks=[0.0]
        chunks=iter([b'partial',b'late'])
        def read1(size):
            chunk=next(chunks)
            ticks[0]+=6
            return chunk
        response.read1.side_effect=read1
        with patch('freelance.modules.collection.ptt_soho.time.monotonic',side_effect=lambda:ticks[0]):
            with self.assertRaises(ValueError):ptt_soho.read_body(response,10)
        self.assertEqual(response.read1.call_count,2)
        self.assertEqual([c.args[0] for c in response.fp.raw._sock.settimeout.call_args_list],[8,4])

    def test_body_size_limit_and_normal_eof(self):
        from unittest.mock import Mock, patch
        response=Mock();response.read1.side_effect=[b'body',b'']
        with patch('freelance.modules.collection.ptt_soho.time.monotonic',return_value=0):
            self.assertEqual(ptt_soho.read_body(response,10),b'body')
            response.read1.side_effect=[b'x'*2000001]
            with self.assertRaises(ValueError):ptt_soho.read_body(response,10)

    def test_real_http_response_content_length_closes_at_last_chunk(self):
        import socket
        from http.client import HTTPResponse
        from unittest.mock import patch
        reader,writer=socket.socketpair()
        try:
            writer.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody')
            response=HTTPResponse(reader);response.begin();reader.close()
            with response,patch('freelance.modules.collection.ptt_soho.time.monotonic',return_value=0):
                self.assertEqual(ptt_soho.read_body(response,10),b'body')
        finally:
            reader.close();writer.close()
