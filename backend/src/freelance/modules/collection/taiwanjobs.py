"""Bounded official TaiwanJobs open data; no login or application submission."""
from datetime import datetime, timezone, timedelta
from hashlib import sha256
import json
import re
import time
from urllib.parse import urlsplit, parse_qs, urlencode
from urllib.request import Request, build_opener
import xml.etree.ElementTree as ET
from freelance.modules.collection.resend_preview import NoRedirect
from freelance.modules.discovery.public import qualify_for_intake

ENDPOINT='https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx?count=1000'
LABELS=dict(OCCU_DESC='職務名稱',WK_TYPE='職務性質',CJOB1_COUNT='職務大類別代碼',CJOB_NAME1='職務大類別名稱',CJOB2_COUNT='職務小類別代碼',CJOB_NAME2='職務小類別名稱',JOB_PERSON='雇用人數',STOP_DATE='應徵截止日期',JOB_DETAIL='工作內容',CITYNAME='工作地點',EXPERIENCE='工作經驗',WKTIME='工作時間',SALARYCD='核薪方式',NT_L='薪資範圍下限',NT_U='薪資範圍上限',EDGRDESC='最低學歷要求',URL_QUERY='職缺資料URL',COMPNAME='公司名稱',TRANDATE='職缺更新日期')
TAIPEI=timezone(timedelta(hours=8))


def date(value):
    if not re.fullmatch(r'\d{8}',value):raise ValueError('Invalid source date')
    return datetime.strptime(value,'%Y%m%d').replace(tzinfo=TAIPEI)


def parse(raw,*,now=None):
    return parse_batch(raw,now=now,strict=True)['jobs']


def parse_batch(raw,*,now=None,strict=False):
    now=now or datetime.now(timezone.utc)
    if not isinstance(raw,bytes) or len(raw)>8000000:raise ValueError('Response limit')
    text=raw.decode('utf-8-sig')
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():raise ValueError('XML declarations not supported')
    # The documented endpoint emits illegal XML name suffixes such as
    # OCCU_DESC（職務名稱）. Rewrite only known tags OUTSIDE CDATA.
    pieces=re.split(r'(<!\[CDATA\[.*?\]\]>)',text,flags=re.S)
    for i in range(0,len(pieces),2):
        for key,label in LABELS.items():
            pieces[i]=pieces[i].replace('<'+key+'（'+label+'）>','<'+key+'>').replace('</'+key+'（'+label+'）>','</'+key+'>')
    try:root=ET.fromstring(''.join(pieces))
    except ET.ParseError:raise ValueError('Unsupported XML format') from None
    if root.tag!='DataList' or len(root)>1000 or (root.text or '').strip():raise ValueError('Unsupported data list')
    result=[];seen=set();rejected=0
    for record in root:
        if record.tag!='Data' or record.attrib:raise ValueError('Invalid record')
        fields={}
        for child in record:
            if child.tag not in LABELS or child.tag in fields or len(child) or child.attrib:raise ValueError('Unsupported field')
            fields[child.tag]=(child.text or '').strip()
        try:
            job=normalize(fields,now)
        except (ValueError,TypeError):
            if strict:raise
            rejected+=1
            continue
        if job['external_id'] in seen:raise ValueError('Duplicate identity')
        seen.add(job['external_id']);result.append(job)
    return dict(jobs=result,rejected_count=rejected,seen=len(root))


def normalize(fields,now):
    title=fields.get('OCCU_DESC','');body=fields.get('JOB_DETAIL','')
    if not 1<=len(title)<=500 or not 0<=len(body)<=100000:raise ValueError('Missing requirement')
    u=urlsplit(fields.get('URL_QUERY',''))
    if u.scheme!='https' or u.netloc!='job.taiwanjobs.gov.tw' or u.path.lower() not in ('/internet/jobwanted/jobdetail.aspx','/internet/index/jobdetail.aspx'):raise ValueError('Invalid canonical URL')
    q=parse_qs(u.query,keep_blank_values=True)
    if any(len(q.get(k,[]))!=1 or not re.fullmatch(r'[1-9]\d{0,19}',q[k][0]) for k in ('EMPLOYER_ID','HIRE_ID')):raise ValueError('Invalid identity')
    key=q['EMPLOYER_ID'][0]+':'+q['HIRE_ID'][0]
    url=u._replace(query=urlencode({k:q[k][0] for k in ('EMPLOYER_ID','HIRE_ID')}),fragment='').geturl()
    updated=date(fields.get('TRANDATE',''))
    if updated>now+timedelta(days=1):raise ValueError('Future source date')
    stop=fields.get('STOP_DATE','')
    deadline=date(stop).date().isoformat() if re.fullmatch(r'\d{8}',stop) else None
    type_text=fields.get('WK_TYPE','')
    kind='full_time' if '全職' in type_text else 'contract' if re.search(r'兼職|部分工時|接案|承攬',type_text) else None
    job=dict(source='taiwanjobs',external_id=key,title=title,description=body,url=url,canonical_url=url,kind=kind,
             source_updated_at=updated.isoformat(),received_at=updated.isoformat(),deadline=deadline,
             deadline_evidence=stop,employment_type_evidence=type_text,location_evidence=fields.get('CITYNAME',''),
             schedule_evidence=fields.get('WKTIME',''),salary_evidence=dict(period=fields.get('SALARYCD',''),low=fields.get('NT_L',''),high=fields.get('NT_U','')),
             taiwan_eligible=None,timezone_compatible=None,weekly_hours=None,currency=None,budget_min=None,budget_max=None,
             language='zh-TW',complete=bool(body),body_available=bool(body))
    receipt=sha256(json.dumps({k:v for k,v in job.items() if k!='received_at'},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return job|{'receipt_id':'taiwanjobs:'+receipt}



def fetch():
    deadline=time.monotonic()+45
    req=Request(ENDPOINT,headers={'User-Agent':'freelance-agent/0.1 personal-job-discovery','Accept':'application/xml'})
    with build_opener(NoRedirect()).open(req,timeout=8) as response:
        if response.status!=200:raise ValueError('Source unavailable')
        sock=response.fp.raw._sock;parts=[];size=0
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise ValueError('Source deadline')
            sock.settimeout(min(8,remaining))
            chunk=response.read1(min(65536,8000001-size))
            if time.monotonic()>deadline:raise ValueError('Source deadline')
            size+=len(chunk)
            if size>8000000:raise ValueError('Response limit')
            parts.append(chunk)
            if not chunk or response.fp is None:break
    return parse_batch(b''.join(parts))


def sync(store,*,reader=fetch):
    store.set_source_health('taiwanjobs','failed')
    try:
        batch=reader()
        jobs=batch['jobs'] if isinstance(batch,dict) else batch
        rejected=batch.get('rejected_count',0) if isinstance(batch,dict) else 0
        if not isinstance(rejected,int) or rejected<0:raise ValueError('Invalid rejected count')
        if not isinstance(jobs,list) or len(jobs)>1000:raise ValueError('Invalid result')
        added=0
        with store.source_batch('taiwanjobs') as batch:
            known=batch.existing_ids()
            for job in jobs:
                if job.get('source')!='taiwanjobs':raise ValueError('Wrong source')
                if job['external_id'] not in known:
                    updated=datetime.fromisoformat(job['source_updated_at'])
                    if updated<store.clock()-timedelta(days=90) or job['kind']!='contract' or qualify_for_intake(job,now=store.clock())['status']=='excluded':continue
                batch.ingest(job, receipt_id=job['receipt_id']);added+=1
            if not rejected:
                batch.finish('ok')
        return dict(status='partial' if rejected else 'ok',seen=len(jobs)+rejected,rejected_count=rejected,jobs=added,scope='first_1000_official_open_data_recent_updates',complete_scan=False)
    except Exception:
        return dict(status='failed',reason='taiwanjobs_unavailable_or_unsupported')
