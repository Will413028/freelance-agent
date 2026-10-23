"""Public official Freelancer active-project search; bounded discovery, never bids."""
from datetime import datetime,timezone
from math import isfinite
import json
import re
import time
from urllib.parse import urlencode
from urllib.request import Request,build_opener
from freelance.modules.collection.resend_preview import NoRedirect
from freelance.modules.discovery.public import qualify_for_intake

QUERIES=('AI agent','API integration','MVP web development')
TITLE_SIGNAL=re.compile(r'\b(?:ai|agent|api|backend|back.end|full.stack|mvp|website|web\s+app|web\s+development|software\s+development|app\s+development|automation|integration|chatbot|bot)\b',re.I)
OUT_OF_SCOPE=re.compile(r'\b(?:copywriting|seo|link\s+building|lead\s+generation|sales|commission|testing|vapt|scraping|data\s+entry|logo|graphic\s+design)\b',re.I)


def normalize(p):
    if (type(p.get('id')) is not int or p['id']<=0 or p.get('status')!='active'
            or p.get('deleted') or p.get('nonpublic')):raise ValueError('Non-public or inactive project')
    title,description=p.get('title'),p.get('description')
    if not isinstance(title,str) or not 1<=len(title)<=500 or not isinstance(description,str) or not 1<=len(description)<=50000:
        raise ValueError('Full description required')
    stamp=p.get('time_updated')
    if type(stamp) not in (int,float) or not isfinite(stamp) or stamp<=0:raise ValueError('Invalid timestamp')
    timestamp=datetime.fromtimestamp(stamp,timezone.utc).isoformat()
    currency=p.get('currency',{}).get('code');budget=p.get('budget',{})
    if not isinstance(currency,str) or not re.fullmatch('[A-Z]{3}',currency) or not isinstance(budget,dict):raise ValueError('Invalid budget')
    amounts=[budget.get(k) for k in ('minimum','maximum')]
    if any(v is not None and (type(v) not in (int,float) or not isfinite(v) or v<0) for v in amounts):raise ValueError('Invalid amount')
    if all(v is not None for v in amounts) and amounts[0]>amounts[1]:raise ValueError('Invalid range')
    slug=p.get('seo_url')
    if not isinstance(slug,str) or not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_-]+',slug):raise ValueError('Invalid project URL')
    if p.get('type') not in ('fixed','hourly'):raise ValueError('Unknown project type')
    url='https://www.freelancer.com/projects/'+slug
    return dict(source='freelancer',external_id=str(p['id']),title=title,description=description,
                received_at=timestamp,receipt_id=f"freelancer:{p['id']}:{stamp}",url=url,canonical_url=url,
                kind=p['type'],currency=currency,budget_min=amounts[0],budget_max=amounts[1],
                weekly_hours=None,taiwan_eligible=None,timezone_compatible=None,deadline=None,
                language='en',complete=False)


def search(query,*,limit=20,opener=None,max_pages=20,max_seconds=30,
           pause=time.sleep,monotonic=time.monotonic):
    if (query not in QUERIES or type(limit) is not int or not 1<=limit<=100
            or type(max_pages) is not int or not 1<=max_pages<=100
            or type(max_seconds) not in (int,float) or not isfinite(max_seconds)
            or not 0<max_seconds<=120):
        raise ValueError('Unsupported search bounds')
    client=opener or build_opener(NoRedirect())
    deadline=monotonic()+max_seconds
    jobs={};offset=0;pages=0;total=None;limited=True;rejected=0
    try:
        for _ in range(max_pages):
            if pages:
                remaining=deadline-monotonic()
                if remaining<=0.6:break
                pause(0.6)
            remaining=deadline-monotonic()
            if remaining<=0:break
            url='https://www.freelancer.com/api/projects/0.1/projects/active/?'+urlencode(
                {'query':query,'limit':limit,'offset':offset,'full_description':'true'})
            with client.open(Request(url,method='GET',headers={
                    'User-Agent':'freelance-agent/0.1','Accept':'application/json'}),
                    timeout=min(20,remaining)) as response:
                if response.status!=200:raise ValueError()
                raw=response.read(2000001)
            if len(raw)>2000000:raise ValueError()
            data=json.loads(raw)
            if data['status']!='success':raise ValueError()
            projects=data['result']['projects'];total=data['result']['total_count']
            if not isinstance(projects,list) or len(projects)>limit or type(total) is not int or total<len(projects):
                raise ValueError()
            page_jobs=[]
            for project in projects:
                try:page_jobs.append(normalize(project))
                except (ValueError,TypeError,AttributeError,OverflowError):rejected+=1
            pages+=1
            new_ids=0
            for job in page_jobs:
                prior=jobs.get(job['external_id'])
                if prior is None:new_ids+=1
                elif prior['received_at']==job['received_at'] and prior!=job:
                    raise ValueError('Conflicting project version')
                if prior is None or job['received_at']>prior['received_at']:
                    jobs[job['external_id']]=job
            # The API may return fewer rows than requested before the end of
            # the result set. Its offset still advances by the requested page.
            offset+=limit
            if offset>=total:
                # Offset results can move while a query runs. Duplicates must not
                # be counted as coverage of projects we never actually received.
                limited=len(jobs)<total
                break
            if not projects or (page_jobs and not new_ids):break
        return {'jobs':list(jobs.values()),'limited':limited,'pages':pages,
                'reported_total':total,'rejected_count':rejected,'scope':'active_query_results'}
    except Exception:
        raise ValueError('Freelancer search unavailable or unsupported') from None


def sync(store,*,searcher=search,pause=time.sleep):
    try:
        store.set_source_health('freelancer','failed')
        jobs={};limited=False;rejected=0;pages=0
        for index,query in enumerate(QUERIES):
            if index:pause(0.6)
            result=searcher(query,limit=100);limited|=result['limited']
            rejected+=result.get('rejected_count',0);pages+=result.get('pages',0)
            for job in result['jobs']:
                prior=jobs.get(job['external_id'])
                if prior is None or job['received_at']>prior['received_at']:jobs[job['external_id']]=job
        selected=[job for job in jobs.values() if TITLE_SIGNAL.search(job['title']) and
                  not OUT_OF_SCOPE.search(job['title']) and
                  (evaluation:=qualify_for_intake(job))['status']!='excluded' and evaluation['score']>0]
        for job in selected:store.ingest(job,receipt_id=job['receipt_id'])
        partial=limited or rejected>0
        store.set_source_health('freelancer','failed' if partial else 'ok')
        return {'status':'partial' if partial else 'ok','seen':len(jobs),'jobs':len(selected),
                'limited':limited,'rejected_count':rejected,'pages':pages,'scope':'3_active_queries_paginated'}
    except Exception:
        return {'status':'failed','reason':'freelancer_source_failed'}
