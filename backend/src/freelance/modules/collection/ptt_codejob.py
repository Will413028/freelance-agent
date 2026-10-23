"""Bounded public CodeJob discovery. No account, comments, external links or applications."""
from datetime import datetime, timezone, timedelta
from hashlib import sha256
import json
import re
import time
from urllib.request import Request, build_opener
from freelance.modules.collection.ptt_soho import page, read_body
from freelance.modules.discovery.public import qualify
from freelance.modules.collection.resend_preview import NoRedirect

ORIGIN = 'https://www.ptt.cc'
ARTICLE = re.compile(r'/bbs/CodeJob/(M\.(\d{10})\.A\.[A-Fa-f0-9]+\.html)\Z')
INDEX = re.compile(r'/bbs/CodeJob/index(?:\d+)?\.html\Z')
CLOSED = re.compile(r'已徵到|已徵得|已找到|已結案|已結束|停止徵求|已額滿|已解決|[\[（(【](?:結案|解決)[\]）)】]')
DEMAND = re.compile(r'^\[(?:發案|發包|徵才|已解決|解決|已結案|結案)\]')
BODY_CLOSED = re.compile(r'(?m)^\s*(?:[【\[(（]?更新[】\])）：:]?\s*)?(?:本案|此案)?\s*(?:已徵到|已徵得|已找到|已結案|已結束|停止徵求|已額滿|已解決|結案(?:$|[。！!]))')
FULL_TIME = re.compile(r'全職|\bfull[ -]?time\b', re.I)
NEGATED_FULL_TIME = re.compile(r'(?:非|不是|不用|不需(?:要)?|無需)\s*全職|\b(?:not|non)(?:[ -]+a)?[ -]+full[ -]?time\b', re.I)
OPTIONAL_EMPLOYMENT = re.compile(r'全職\s*(?:亦可|也可)|兼職\s*(?:亦可|也可|皆可|可)|全職\s*(?:或|/|／)\s*兼職|\b(?:full[ -]?time\s*(?:or|/)\s*part[ -]?time|part[ -]?time\s*(?:or|/)\s*full[ -]?time)\b', re.I)
BODY_EMPLOYMENT = re.compile(r'(?:職務性質|工作性質|合作型態)[：:]\s*全職|(?:這是|本職缺為|招聘|徵求|招募|徵聘)\s*(?:一位|一名)?\s*全職|\bfull[ -]?time\s+(?:role|position|job|employment)\b', re.I)


def employment_kind(title, body):
    # Interpret explicit employment evidence within a clause; incidental mentions
    # of the customer's staff do not describe this contract's employment type.
    for text, is_title in ((title, True), (body, False)):
        for clause in re.split(r'[\n。；;，,]', text):
            clause = NEGATED_FULL_TIME.sub('', clause)
            if OPTIONAL_EMPLOYMENT.search(clause):
                continue
            if (FULL_TIME if is_title else BODY_EMPLOYMENT).search(clause):
                return 'full_time'
    return 'contract'




def parse_index(raw,now=None):
    now=now or datetime.now(timezone.utc)
    parsed=page(raw)
    if not parsed.index_found:raise ValueError('Missing CodeJob index structure')
    result=[];previous=None;seen=set()
    for path,text,in_title in parsed.anchors:
        title=' '.join(text.split())
        if '上頁' in title and INDEX.fullmatch(path):previous=path
        match=ARTICLE.fullmatch(path)
        if not in_title or not match or path in seen:continue
        if not DEMAND.match(title):continue
        published=datetime.fromtimestamp(int(match[2]),timezone.utc)
        if not now-timedelta(days=90)<=published<=now:continue
        closed=bool(CLOSED.search(title))
        result.append(dict(path=path,external_id=match[1],title=title,
                           published_at=published.isoformat(),closed=closed))
        seen.add(path)
    return result,previous


def receipt(job):
    content={k:v for k,v in job.items() if k not in {'receipt_id','received_at','evidence_ref','raw_evidence_ref'}}
    return job | {'receipt_id':'ptt_codejob:'+sha256(json.dumps(content,sort_keys=True,ensure_ascii=False).encode()).hexdigest()}


def parse_article(raw,entry):
    if not ARTICLE.fullmatch(entry['path']):raise ValueError('Invalid article path')
    parsed=page(raw);body='\n'.join(line.strip() for line in ''.join(parsed.body).splitlines() if line.strip())
    if not parsed.article_found or len(body)<5 or len(body)>100000:raise ValueError('Missing article body')
    closed=entry['closed'] or bool(BODY_CLOSED.search(body))
    kind=employment_kind(entry['title'],body)
    return receipt(dict(source='ptt_codejob',external_id=entry['external_id'],title=entry['title'],description=body,
                        url=ORIGIN+entry['path'],canonical_url=ORIGIN+entry['path'],published_at=entry['published_at'],
                        received_at=entry['published_at'],kind=kind,language='zh-TW',complete=True,
                        body_available=True,listing_closed=bool(closed),currency=None,budget_min=None,budget_max=None,
                        weekly_hours=None,taiwan_eligible=None,timezone_compatible=None,deadline=None))


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
    path='/bbs/CodeJob/index.html';entries={};visited=set();now=datetime.now(timezone.utc)
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
    store.set_source_health('ptt_codejob','failed')
    try:
        jobs=reader()
        if not isinstance(jobs,list):raise ValueError('Expected bounded result')
        added=0;closed_updates=0
        with store.source_batch('ptt_codejob') as batch:
            old=batch.existing_jobs()
            for job in jobs:
                if job.get('closure_only'):
                    previous=old.get(job['external_id'])
                    if previous is None:continue
                    job=receipt(previous|{'listing_closed':True})
                    closed_updates+=1
                elif job.get('source')!='ptt_codejob':raise ValueError('Wrong source')
                elif qualify(job)['category']=='其他' and job['external_id'] not in old:continue
                else:added+=1
                batch.ingest(job, receipt_id=job['receipt_id'])
        store.set_source_health('ptt_codejob','ok')
        return dict(status='ok',seen=len(jobs),jobs=added,closed_updates=closed_updates,
                    scope='two_index_pages_max_twenty_articles_90_days',complete_scan=False)
    except Exception:
        return dict(status='failed',reason='ptt_unavailable_or_unsupported')
