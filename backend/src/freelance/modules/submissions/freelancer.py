"""Official Freelancer bid API, fixed hosts and no redirects/retries."""
import json
import re
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

HOSTS={'sandbox':'https://www.freelancer-sandbox.com','live':'https://www.freelancer.com'}


class ProviderRefused(Exception):pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


class FreelancerHTTP:
    def __init__(self,environment,token,*,opener=None):
        if environment not in HOSTS or not isinstance(token,str) or not token or '\r' in token or '\n' in token:
            raise ValueError('Freelancer configuration unavailable')
        self.host=HOSTS[environment];self.token=token;self.opener=opener or build_opener(NoRedirect())

    def __call__(self,method,path,payload=None):
        valid=(method=='GET' and (path=='/api/users/0.1/self/' or re.fullmatch(r'/api/projects/0\.1/projects/[1-9][0-9]*/',path)
               or re.fullmatch(r'/api/projects/0\.1/bids/\?bids%5B%5D=[1-9][0-9]*&limit=1',path))) or (method=='POST' and path=='/api/projects/0.1/bids/')
        if not valid:raise ValueError('Freelancer endpoint unavailable')
        raw=json.dumps(payload,allow_nan=False).encode() if payload is not None else None
        request=Request(self.host+path,data=raw,method=method,headers={
            'Freelancer-OAuth-V1':self.token,'Content-Type':'application/json','User-Agent':'Freelance-Agent/0.2'})
        try:
            with self.opener.open(request,timeout=20) as response:
                if response.geturl()!=self.host+path or response.status!=200:raise ValueError('Freelancer response unavailable')
                body=response.read(2000001)
        except HTTPError as error:
            if error.code in (400,401,403,404,409,422):raise ProviderRefused('Freelancer refused request') from None
            raise ValueError('Freelancer response unavailable') from None
        if len(body)>2000000:raise ValueError('Freelancer response unavailable')
        result=json.loads(body)
        if not isinstance(result,dict) or result.get('status')!='success' or not isinstance(result.get('result'),dict):
            raise ValueError('Freelancer response unavailable')
        return result['result']


class FreelancerSender:
    def __init__(self,account,environment,request):self.account,self.environment,self.request=account,environment,request

    def __call__(self,snapshot):
        if (snapshot.get('account')!=self.account or snapshot.get('environment')!=self.environment
                or snapshot.get('purpose')!='proposal_submission' or snapshot.get('provider')!='freelancer'):
            raise ValueError('Freelancer account/environment mismatch')
        try:
            user=self.request('GET','/api/users/0.1/self/')
            project=self.request('GET',f"/api/projects/0.1/projects/{snapshot['project_id']}/")
            currency=project.get('currency',{})
            if (str(user.get('id'))!=self.account or project.get('id')!=snapshot['project_id'] or project.get('status')!='active'
                    or currency.get('id')!=snapshot['currency_id'] or currency.get('code')!=snapshot['currency_code']):
                raise ValueError('Freelancer project/account/currency changed')
            payload={k:snapshot[k] for k in ('project_id','bidder_id','amount','period','milestone_percentage')}
            payload['description']=snapshot['body']
            result=self.request('POST','/api/projects/0.1/bids/',payload)
        except ProviderRefused:
            return dict(status='rejected',receipt=dict(kind='freelancer_refused'))
        if (type(result.get('id')) is not int or result['id']<1 or result.get('project_id')!=snapshot['project_id']
                or result.get('bidder_id')!=snapshot['bidder_id']):return dict(status='unknown',receipt=None)
        return dict(status='accepted',receipt=dict(kind='freelancer_bid',bid_id=result['id'],
                    project_id=result['project_id'],bidder_id=result['bidder_id']))

    def lookup(self,snapshot,bid_id):
        if (type(bid_id) is not int or bid_id<1 or snapshot.get('account')!=self.account
                or snapshot.get('environment')!=self.environment or snapshot.get('provider')!='freelancer'):
            raise ValueError('Freelancer lookup binding mismatch')
        user=self.request('GET','/api/users/0.1/self/')
        if str(user.get('id'))!=self.account:raise ValueError('Freelancer lookup account mismatch')
        result=self.request('GET',f'/api/projects/0.1/bids/?bids%5B%5D={bid_id}&limit=1')
        bids=result.get('bids')
        if not isinstance(bids,list) or len(bids)!=1 or not isinstance(bids[0],dict):raise ValueError('Freelancer lookup unavailable')
        bid=bids[0]
        expected={k:snapshot[k] for k in ('project_id','bidder_id','amount','period','milestone_percentage')}
        expected.update(id=bid_id,description=snapshot['body'])
        if any(bid.get(k)!=v for k,v in expected.items()):raise ValueError('Freelancer lookup bid mismatch')
        return dict(kind='freelancer_bid',bid_id=bid_id,project_id=bid['project_id'],bidder_id=bid['bidder_id'])
