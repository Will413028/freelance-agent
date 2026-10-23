"""Public community hiring leads. No accounts, messaging, or employer-link fetching."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from hashlib import sha256
import json
import re
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
import xml.etree.ElementTree as ET
from freelance.modules.collection.free_jobs import Text
from freelance.modules.collection.resend_preview import NoRedirect
from freelance.modules.discovery.public import qualify_for_intake


def plain(body):
    text=Text();text.feed(body)
    return ' '.join(''.join(text.parts).split())


def job(source, external_id, title, body, url, published, **evidence):
    if not title.strip() or len(body)>100000:
        raise ValueError('Invalid listing')
    result=dict(source=source,external_id=str(external_id),title=title[:500],description=body,
                url=url,canonical_url=url,kind='contract',taiwan_eligible=None,
                timezone_compatible=None,weekly_hours=None,deadline=None,currency=None,
                budget_min=None,budget_max=None,complete=False,language='zh-TW' if source=='v2ex' else 'en')
    result.update(evidence)
    digest=sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()
    return result|dict(received_at=published,receipt_id=source+':'+digest)


def hn_job(p,parent):
    if not isinstance(p,dict):raise ValueError('Missing comment')
    if p.get('deleted') or p.get('dead'):return None
    if p.get('type')!='comment' or p.get('parent')!=parent:return None
    body=p.get('text')
    if not isinstance(body,str):raise ValueError('Missing comment text')
    text=plain(body)
    if text.startswith('Location:') and 'Willing to relocate:' in text:return None
    if re.search(r'^(seeking work|for hire|looking for work)\b',text,re.I):return None
    if re.search(r'\b(no contractors?|no freelance|full[ -]?time only|part[ -]?time not available)\b',text,re.I):return None
    if not re.search(r'\b(part[ -]?time|contract(?:or|ing)?|freelance|fractional)\b',text,re.I):return None
    if type(p.get('id')) is not int or type(p.get('time')) is not int:raise ValueError('Invalid comment metadata')
    restricted=bool(re.search(r'\b(?:USA?|UK|EU|Europe|Canada|Australia)\s+only\b|REMOTE\s*\((?:EU|US|USA|UK|Europe)\)|\b(?:Poland|Romania|Romanian)(?: or (?:Poland|Romania|Romanian))? residents only',text,re.I))
    return job('hackernews',p['id'],text[:160],text,'https://news.ycombinator.com/item?id='+str(p['id']),
               datetime.fromtimestamp(p['time'],timezone.utc).isoformat(),thread_id=parent,body_available=True,
               taiwan_eligible=False if restricted else None)


def v2ex_jobs(raw):
    if len(raw)>2000000 or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():raise ValueError('Unsupported XML')
    try:r=ET.fromstring(raw)
    except ET.ParseError:raise ValueError('Invalid feed') from None
    ns='{http://www.w3.org/2005/Atom}'
    if r.tag!=ns+'feed':raise ValueError('Expected Atom')
    entries=r.findall(ns+'entry')
    if len(entries)>100:raise ValueError('Feed limit')
    jobs=[]
    for e in entries:
        title=e.findtext(ns+'title') or ''
        if re.search(r'承接|接单|接單|接活|自荐|自薦|作品展示|出售|广告联盟|廣告聯盟|假如|如果',title):continue
        if not re.search(r'招聘|寻找|尋找|求助|需求|外包|找.{0,20}(开发|開發|工程师|工程師|大佬)|有.{0,20}项目',title):continue
        links=[x.get('href') for x in e.findall(ns+'link') if x.get('rel')=='alternate']
        if len(links)!=1:raise ValueError('Missing canonical link')
        u=urlsplit(links[0]);match=re.fullmatch(r'/t/(\d+)',u.path)
        if u.scheme!='https' or u.netloc!='www.v2ex.com' or not match:raise ValueError('Invalid canonical link')
        published=datetime.fromisoformat((e.findtext(ns+'published') or '').replace('Z','+00:00'))
        if published.tzinfo is None:raise ValueError('Missing timezone')
        if published<datetime.now(timezone.utc)-timedelta(days=90):continue
        body=plain(e.findtext(ns+'content') or '')
        jobs.append(job('v2ex',match[1],title,body or title,u._replace(query='',fragment='').geturl(),
                        published.isoformat(),body_available=bool(body),feed_evidence='outsourcing'))
    return jobs


def fetch(source):
    deadline=time.monotonic()+90
    def read(url):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise ValueError('Source time budget exceeded')
        request=Request(url,headers={'User-Agent':'freelance-agent/0.1 personal-job-discovery'})
        with build_opener(NoRedirect()).open(request,timeout=min(8,remaining)) as response:
            if response.status!=200:raise ValueError('Feed unavailable')
            raw=response.read(2000001)
        if len(raw)>2000000:raise ValueError('Response limit')
        return raw
    if source=='v2ex':return v2ex_jobs(read('https://www.v2ex.com/feed/outsourcing.xml'))
    if source!='hackernews':raise ValueError('Unsupported source')
    def get(path):return json.loads(read('https://hacker-news.firebaseio.com/v0/'+path+'.json'))
    def item(i):
        if type(i) is not int or i<=0:raise ValueError('Invalid id')
        return get('item/'+str(i))
    ids=get('user/whoishiring').get('submitted')
    if not isinstance(ids,list):raise ValueError('Missing submissions')
    cutoff=datetime.now(timezone.utc)-timedelta(days=62)
    with ThreadPoolExecutor(max_workers=8) as pool:
        threads=list(pool.map(item,ids[:6]))
        selected=[t for t in threads if isinstance(t,dict) and t.get('by')=='whoishiring'
                  and t.get('type')=='story' and not t.get('deleted') and not t.get('dead')
                  and (t.get('title','').startswith('Ask HN: Who is hiring?') or t.get('title','').startswith('Ask HN: Freelancer?'))
                  and datetime.fromtimestamp(t['time'],timezone.utc)>=cutoff][:2]
        if not selected:raise ValueError('No recent hiring thread')
        result=[]
        for thread in selected:
            children=thread.get('kids',[])
            if not isinstance(children,list):raise ValueError('Invalid comments')
            for p in pool.map(item,children[:100]):
                j=hn_job(p,thread['id'])
                if j:result.append(j)
        return result


def sync(source,store,*,reader=fetch):
    store.set_source_health(source,'failed')
    try:
        jobs=reader(source)
        selected=[j for j in jobs if qualify_for_intake(j)['status']!='excluded']
        for j in selected:store.ingest(j,receipt_id=j['receipt_id'])
        store.set_source_health(source,'ok')
        return dict(status='ok',seen=len(jobs),jobs=len(selected),scope='bounded_public_hiring_leads',complete_scan=False)
    except Exception:
        return dict(status='failed',reason='community_feed_unavailable_or_unsupported')
