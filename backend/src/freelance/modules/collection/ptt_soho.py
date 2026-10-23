"""Bounded public SOHO discovery. No account, comments, external links or applications."""
from datetime import datetime, timezone, timedelta
from hashlib import sha256
from html.parser import HTMLParser
import json
import re
import time
from urllib.request import Request, build_opener
from freelance.modules.discovery.public import qualify
from freelance.modules.collection.resend_preview import NoRedirect

ORIGIN = 'https://www.ptt.cc'
ARTICLE = re.compile(r'/bbs/soho/(M\.(\d{10})\.A\.[A-Fa-f0-9]+\.html)\Z')
INDEX = re.compile(r'/bbs/soho/index(?:\d+)?\.html\Z')
TECH = re.compile(r'AI\s*agent|agentic|自動化|後端|前端|全端|網站|網頁|程式|系統開發|WordPress|(?<![a-z0-9])(?:API|LLM|RAG|backend|fullstack|Python|React|Flutter)(?![a-z0-9])', re.I)
CLOSED = re.compile(r'已徵到|已徵得|已找到|已結案|已結束|停止徵求|已額滿')
VOID = {'br','hr','img','input','meta','link','area','base','embed','source','wbr'}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack=[]; self.anchors=[]; self.anchor=None; self.body=[]
        self.index_found=False; self.article_found=False
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs); classes=attrs.get('class','').split()
        self.index_found |= 'r-list-container' in classes
        self.article_found |= attrs.get('id')=='main-content'
        parent=self.stack[-1] if self.stack else None
        main=attrs.get('id')=='main-content' or bool(parent and parent[2])
        skip=bool(parent and parent[3]) or tag in ('script','style') or bool(set(classes)&{'article-metaline','article-metaline-right','push','f2'})
        if tag=='a':
            in_title=any('title' in a.get('class','').split() for _,a,_,_ in self.stack)
            in_entry=any('r-ent' in a.get('class','').split() for _,a,_,_ in self.stack)
            self.anchor=[attrs.get('href',''),[],in_title and in_entry]
        if main and not skip and tag in ('br','p','div','hr'):self.body.append('\n')
        if tag not in VOID:self.stack.append((tag,attrs,main,skip))
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)
        if tag not in VOID:self.handle_endtag(tag)
    def handle_endtag(self,tag):
        if tag=='a' and self.anchor:
            self.anchors.append((self.anchor[0],''.join(self.anchor[1]),self.anchor[2]));self.anchor=None
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                del self.stack[i:];break
    def handle_data(self,data):
        if self.anchor:self.anchor[1].append(data)
        if self.stack and self.stack[-1][2] and not self.stack[-1][3]:self.body.append(data)


def page(raw):
    if not isinstance(raw,bytes) or len(raw)>2000000:raise ValueError('Response limit')
    parser=Page();parser.feed(raw.decode('utf-8'));parser.close()
    return parser


def parse_index(raw,now=None):
    now=now or datetime.now(timezone.utc)
    parsed=page(raw)
    if not parsed.index_found:raise ValueError('Missing SOHO index structure')
    result=[];previous=None;seen=set()
    for path,text,in_title in parsed.anchors:
        title=' '.join(text.split())
        if '上頁' in title and INDEX.fullmatch(path):previous=path
        match=ARTICLE.fullmatch(path)
        if not in_title or not match or path in seen:continue
        if not re.match(r'^\[徵才\]',title):continue
        published=datetime.fromtimestamp(int(match[2]),timezone.utc)
        if not now-timedelta(days=90)<=published<=now:continue
        closed=bool(CLOSED.search(title))
        if not closed and not TECH.search(title):continue
        result.append(dict(path=path,external_id=match[1],title=title,
                           published_at=published.isoformat(),closed=closed))
        seen.add(path)
    return result,previous


def receipt(job):
    content={k:v for k,v in job.items() if k not in {'receipt_id','received_at','evidence_ref','raw_evidence_ref'}}
    return job | {'receipt_id':'ptt_soho:'+sha256(json.dumps(content,sort_keys=True,ensure_ascii=False).encode()).hexdigest()}


def parse_article(raw,entry):
    if not ARTICLE.fullmatch(entry['path']):raise ValueError('Invalid article path')
    parsed=page(raw);body='\n'.join(line.strip() for line in ''.join(parsed.body).splitlines() if line.strip())
    if not parsed.article_found or len(body)<5 or len(body)>100000:raise ValueError('Missing article body')
    closed=entry['closed'] or bool(re.search(r'(?m)^\s*(?:[【\[(（]?更新[】\])）：:]?\s*)?(?:本案|此案)?\s*(?:已徵到|已徵得|已找到|已結案|已結束|停止徵求|已額滿)',body))
    return receipt(dict(source='ptt_soho',external_id=entry['external_id'],title=entry['title'],description=body,
                        url=ORIGIN+entry['path'],canonical_url=ORIGIN+entry['path'],published_at=entry['published_at'],
                        received_at=entry['published_at'],kind='contract',language='zh-TW',complete=True,
                        body_available=True,listing_closed=bool(closed),currency=None,budget_min=None,budget_max=None,
                        weekly_hours=None,taiwan_eligible=None,timezone_compatible=None,deadline=None))


def read_body(response,deadline):
    # read1 performs one buffered/socket read; read(n) may wait indefinitely
    # while a peer trickles bytes. Shrink the socket timeout on every chunk.
    chunks=[];size=0
    sock=response.fp.raw._sock
    while True:
        remaining=deadline-time.monotonic()
        if remaining<=0:raise ValueError('Source time budget exceeded')
        sock.settimeout(min(8,remaining))
        chunk=response.read1(min(65536,2000001-size))
        if time.monotonic()>deadline:raise ValueError('Source time budget exceeded')
        if not chunk:return b''.join(chunks)
        size+=len(chunk)
        if size>2000000:raise ValueError('Response limit')
        chunks.append(chunk)
        if response.fp is None:return b''.join(chunks)


def fetch():
    deadline=time.monotonic()+90;last_request=None
    def read(path):
        nonlocal last_request
        if not (ARTICLE.fullmatch(path) or INDEX.fullmatch(path)):raise ValueError('Invalid public path')
        if last_request is not None:
            time.sleep(max(0,1-(time.monotonic()-last_request)))
        remaining=deadline-time.monotonic()
        if remaining<=0:raise ValueError('Source time budget exceeded')
        last_request=time.monotonic()
        req=Request(ORIGIN+path,headers={'User-Agent':'freelance-agent/0.1 personal-job-discovery'})
        with build_opener(NoRedirect()).open(req,timeout=min(8,remaining)) as response:
            if response.status!=200:raise ValueError('PTT unavailable')
            raw=read_body(response,deadline)
        if len(raw)>2000000:raise ValueError('Response limit')
        return raw
    path='/bbs/soho/index.html';entries={};visited=set();now=datetime.now(timezone.utc)
    for _ in range(2):
        if not path or path in visited:break
        visited.add(path)
        current,path=parse_index(read(path),now)
        for entry in current:entries.setdefault(entry['external_id'],entry)
    jobs=[];articles=0
    for entry in sorted(entries.values(),key=lambda x:x['published_at'],reverse=True):
        if entry['closed']:
            jobs.append(entry|{'closure_only':True});continue
        if articles>=20:continue
        jobs.append(parse_article(read(entry['path']),entry));articles+=1
    return jobs


def sync(store,*,reader=fetch):
    store.set_source_health('ptt_soho','failed')
    try:
        jobs=reader()
        if not isinstance(jobs,list):raise ValueError('Expected bounded result')
        added=0;closed_updates=0
        with store.source_batch('ptt_soho') as batch:
            old=batch.existing_jobs()
            for job in jobs:
                if job.get('closure_only'):
                    previous=old.get(job['external_id'])
                    if previous is None:continue
                    job=receipt(previous|{'listing_closed':True})
                    closed_updates+=1
                elif job.get('source')!='ptt_soho':raise ValueError('Wrong source')
                elif qualify(job)['category']=='其他' and job['external_id'] not in old:continue
                else:added+=1
                batch.ingest(job, receipt_id=job['receipt_id'])
        store.set_source_health('ptt_soho','ok')
        return dict(status='ok',seen=len(jobs),jobs=added,closed_updates=closed_updates,
                    scope='two_index_pages_max_twenty_articles_90_days',complete_scan=False)
    except Exception:
        return dict(status='failed',reason='ptt_unavailable_or_unsupported')
