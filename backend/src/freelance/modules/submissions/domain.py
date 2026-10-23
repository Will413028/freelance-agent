"""Immutable submission envelopes and evidence classification."""
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
from hashlib import sha256
import json
import math
import re
from freelance.platform.errors import InvalidAction, Conflict


def digest(snapshot):
    return sha256(json.dumps(snapshot,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def check_revision(value,expected):
    if type(value) is not int or value!=expected:raise Conflict('送出紀錄已更新，請重新核對')


def bounded(value,limit,required=True):
    if not isinstance(value,str) or len(value)>limit or (required and not value.strip()):raise InvalidAction('送出欄位格式不正確')
    return value


def email_address(value):
    bounded(value,254)
    if not re.fullmatch(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?',value):
        raise InvalidAction('Email需為單一完整地址，不含顯示名稱')
    return value


def snapshot(command,version,intent_id,now):
    provider=command['provider'];environment=command['environment'];fields=command['fields'];account=command['account']
    if provider not in ('email','freelancer') or environment not in ('live','sandbox'):raise InvalidAction('不支援的通道／環境')
    bounded(account,254);bounded(version['body'],20000)
    if version['missing'] or '【待填：' in version['body']:raise InvalidAction('請先填完提案待確認內容')
    result=dict(purpose='proposal_submission',schema_version=1,intent_id=intent_id,provider=provider,
                environment=environment,account=account,draft_id=command['draft_id'],draft_version=command['draft_version'],body=version['body'])
    if not isinstance(fields,dict):raise InvalidAction('送出欄位格式不正確')
    if provider=='email':
        if environment!='live' or set(fields)!={'from','to','subject'}:raise InvalidAction('Email欄位不完整')
        email_address(fields['from']);email_address(fields['to']);bounded(fields['subject'],200)
        if fields['from']!=account or any(c in fields['subject'] for c in '\r\n'):raise InvalidAction('Email寄件者或主旨不正確')
        result.update(fields);result['message_id']=f'<{intent_id}@freelance-agent.local>'
        message=EmailMessage(policy=SMTP);message['From']=fields['from'];message['To']=fields['to'];message['Subject']=fields['subject']
        message['Message-ID']=result['message_id'];message['Date']=format_datetime(now)
        message.set_content(version['body'],cte='base64')
        result['raw_message']=message.as_bytes().decode('ascii')
    else:
        expected={'project_id','bidder_id','currency_id','currency_code','amount','period','milestone_percentage','fees','eligibility_confirmed'}
        if set(fields)!=expected:raise InvalidAction('Freelancer投標欄位不完整')
        for key in ('project_id','bidder_id','currency_id','period'):
            if type(fields[key]) is not int or fields[key]<1:raise InvalidAction('Freelancer識別／天數格式不正確')
        for key in ('amount','milestone_percentage'):
            value=fields[key]
            if type(value) not in (int,float) or not math.isfinite(value) or value<=0:raise InvalidAction('Freelancer報價格式不正確')
        if fields['milestone_percentage']>100 or str(fields['bidder_id'])!=account:raise InvalidAction('Freelancer帳號或milestone不正確')
        if not re.fullmatch('[A-Z]{3}',fields['currency_code']):raise InvalidAction('幣別格式不正確')
        bounded(fields['fees'],1000)
        if fields['eligibility_confirmed'] is not True:raise InvalidAction('請由本人確認資格與費用')
        result.update(fields)
    return result


def accepted_receipt(snapshot,result):
    if not isinstance(result,dict) or result.get('status') not in ('accepted','rejected'):return ('unknown',None)
    receipt=result.get('receipt')
    if not isinstance(receipt,dict):return ('unknown',None)
    if result['status']=='rejected':
        expected='smtp_refused' if snapshot['provider']=='email' else 'freelancer_refused'
        if receipt.get('kind')!=expected:return ('unknown',None)
        return ('rejected',{'kind':receipt['kind']})
    if snapshot['provider']=='email':
        if receipt.get('kind')=='smtp_accepted' and receipt.get('message_id')==snapshot['message_id']:
            return ('accepted',dict(kind='smtp_accepted',message_id=snapshot['message_id']))
    elif receipt.get('kind')=='freelancer_bid' and type(receipt.get('bid_id')) is int and receipt['bid_id']>0:
        if (type(receipt.get('project_id')) is int and type(receipt.get('bidder_id')) is int
                and receipt['project_id']==snapshot['project_id'] and receipt['bidder_id']==snapshot['bidder_id']):
            return ('accepted',{k:receipt[k] for k in ('kind','bid_id','project_id','bidder_id')})
    return ('unknown',None)
