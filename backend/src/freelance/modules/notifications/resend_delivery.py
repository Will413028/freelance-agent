"""Production digest delivery requires an explicitly configured verified sending domain."""
from datetime import date
import json
import re
import time
from urllib.request import Request
from freelance.modules.notifications.digest import render
from freelance.modules.notifications.scheduler import dispatch
from freelance.modules.notifications.resend_send import SendingClient, SendError


def sender_domain(sender):
    if not isinstance(sender,str) or not re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',sender):
        raise ValueError('Explicit sender address required')
    domain=sender.rsplit('@',1)[1].lower()
    if domain in ('resend.dev','resend.app') or domain.endswith(('.resend.dev','.resend.app')):
        raise ValueError('Production delivery requires a verified custom domain')
    return domain


def build_payload(snapshot,recipient,sender):
    sender_domain(sender)
    if (not isinstance(recipient,str) or not re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',recipient)
            or snapshot['recipient'].casefold()!=recipient.casefold()):
        raise ValueError('Recipient must match snapshot')
    payload={'from':sender,'to':[recipient],
             'subject':'接案摘要 · '+date.fromisoformat(snapshot['local_date']).isoformat(),
             'html':render(snapshot['items'],snapshot['sources'],mode='sqlite',email=True)}
    return json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()


class DeliveryClient(SendingClient):
    def __init__(self,key,*,opener=None,pause=time.sleep):
        super().__init__(key,opener=opener)
        self._pause=pause

    def verify_sender(self,sender):
        domain=sender_domain(sender)
        try:
            request=Request('https://api.resend.com/domains?limit=100',headers={
                'Authorization':'Bearer '+self._key,'User-Agent':'freelance-agent/0.1','Accept':'application/json'})
            with self._opener.open(request,timeout=20) as response:
                if response.status!=200:raise ValueError()
                raw=response.read(65537)
            if len(raw)>65536:raise ValueError()
            domains=json.loads(raw)['data']
            if not isinstance(domains,list) or len(domains)>100:raise ValueError()
            if not any(d.get('name')==domain and d.get('status')=='verified' and
                       d.get('capabilities',{}).get('sending')=='enabled' for d in domains):
                raise ValueError()
            self._pause(0.6)
        except Exception:
            raise SendError('Verified sending domain unavailable') from None


def deliver(store,intent_id,recipient,sender,client_factory):
    intent=store.get_digest(intent_id)
    if intent['status']!='pending':return intent
    raw=build_payload(intent['snapshot'],recipient,sender)
    client=client_factory()
    client.verify_sender(sender)
    def send(snapshot):
        if build_payload(snapshot,recipient,sender)!=raw:raise ValueError('Snapshot changed')
        return client.send(raw,intent_id)
    return dispatch(store,intent_id,send)
