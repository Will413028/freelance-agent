"""Free public job-board discovery, preserving attribution and manual application links."""
from datetime import datetime,timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
from urllib.parse import urlsplit
from urllib.request import Request,build_opener
from freelance.modules.collection.resend_preview import NoRedirect
from freelance.modules.discovery.public import qualify_for_intake

ENDPOINTS={'remotive':'https://remotive.com/api/remote-jobs?category=software-dev&limit=200',
           'jobicy':'https://jobicy.com/api/v2/remote-jobs?count=200'}
class Text(HTMLParser):
    def __init__(self):super().__init__();self.parts=[];self.hidden=0
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style'):self.hidden+=1
        if tag in ('p','div','br','li'):self.parts.append(' ')
    def handle_endtag(self,tag):
        if tag in ('script','style'):self.hidden=max(0,self.hidden-1)
        if tag in ('p','div','li'):self.parts.append(' ')
    def handle_data(self,data):
        if not self.hidden:self.parts.append(data)


def normalize(source,p):
    if source not in ENDPOINTS or type(p.get('id')) is not int or p['id']<=0:raise ValueError('Invalid source/id')
    title=p.get('title' if source=='remotive' else 'jobTitle')
    description=p.get('description' if source=='remotive' else 'jobDescription')
    if not isinstance(title,str) or not 1<=len(title)<=500 or not isinstance(description,str) or not 1<=len(description)<=100000:raise ValueError('Full description required')
    text=Text();text.feed(description);description=' '.join(''.join(text.parts).split())
    if not description:raise ValueError('Empty description')
    url=p.get('url');u=urlsplit(url)
    if u.scheme!='https' or u.netloc!=source+'.com' or not u.path.startswith('/remote-jobs/' if source=='remotive' else '/jobs/'):raise ValueError('Invalid job URL')
    url=u._replace(query='',fragment='').geturl()
    types=[p.get('job_type','')] if source=='remotive' else p.get('jobType',[])
    if not isinstance(types,list) or any(not isinstance(t,str) for t in types):raise ValueError('Invalid employment type')
    types={t.lower().replace('-','_').replace(' ','_') for t in types}
    kind='full_time' if 'full_time' in types else 'contract' if types & {'contract','part_time','freelance'} else None
    geo=p.get('candidate_required_location' if source=='remotive' else 'jobGeo') or ''
    if not isinstance(geo,str):raise ValueError('Invalid geography')
    # Generic worldwide labels do not establish citizenship, payroll or timezone eligibility.
    excluded={'usa','us','united states','uk','united kingdom','canada','europe','eu','australia'}
    taiwan=False if geo.strip().lower() in excluded else None
    published=p.get('publication_date' if source=='remotive' else 'pubDate')
    if not isinstance(published,str):raise ValueError('Publication evidence required')
    parsed=datetime.fromisoformat(published.replace('Z','+00:00'))
    received=parsed if parsed.tzinfo else datetime.now(timezone.utc)
    job=dict(source=source,external_id=str(p['id']),title=title,description=description,url=url,canonical_url=url,
             kind=kind,employment_types=sorted(types),location_evidence=geo,publication_evidence=published,
             taiwan_eligible=taiwan,timezone_compatible=None,weekly_hours=None,deadline=None,
             currency=None,budget_min=None,budget_max=None,language='en',complete=False)
    receipt=sha256(json.dumps(job,sort_keys=True).encode()).hexdigest()
    return job|{'received_at':received.isoformat(),'receipt_id':source+':'+str(p['id'])+':'+receipt}


def fetch(source):
    if source not in ENDPOINTS:raise ValueError('Unsupported source')
    try:
        request=Request(ENDPOINTS[source],headers={'User-Agent':'freelance-agent/0.1 personal-job-discovery','Accept':'application/json'},method='GET')
        with build_opener(NoRedirect()).open(request,timeout=25) as r:
            if r.status!=200:raise ValueError()
            raw=r.read(8000001)
        if len(raw)>8000000:raise ValueError()
        d=json.loads(raw)
        if not isinstance(d.get('jobs'),list) or len(d['jobs'])>200:raise ValueError()
        return d
    except Exception:
        raise ValueError('Public job feed unavailable') from None


def sync(source,store,*,reader=fetch):
    try:
        store.set_source_health(source,'failed')
        data=reader(source);jobs=[normalize(source,p) for p in data['jobs']]
        selected=[j for j in jobs if j['kind']=='contract' and qualify_for_intake(j)['status']!='excluded']
        for job in selected:store.ingest(job,receipt_id=job['receipt_id'])
        store.set_source_health(source,'ok')
        return {'status':'ok','seen':len(jobs),'jobs':len(selected),'scope':'latest_200_public_listings'}
    except Exception:
        return {'status':'failed','reason':'public_feed_unavailable_or_unsupported'}
