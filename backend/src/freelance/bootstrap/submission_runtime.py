"""Explicit opt-in runtime; API queues, sole worker reads credentials and sends."""
from freelance.platform.private_json import read_private_json
from freelance.platform.gmail_smtp import open_client
from freelance.platform.errors import Conflict
from freelance.modules.submissions.email import EmailSender
from freelance.modules.submissions.freelancer import FreelancerSender,FreelancerHTTP
from freelance.modules.submissions.domain import check_revision
from .queue import build_queue,register_submission_task
from .submissions import execute


class SubmissionRuntime:
    def __init__(self,store,config_path=None,*,enqueue=None):
        self.store=store
        self.config=read_private_json(config_path) if config_path is not None else {}
        if set(self.config)-{'email','freelancer'}:raise ValueError('Unknown submission runtime provider')
        self.submit_task=enqueue

    def capabilities(self):
        result={}
        for provider in ('email','freelancer'):
            config=self.config.get(provider)
            status='not_configured';account=None;environment=None
            if config:
                account=config.get('account');environment=config.get('environment');status='configured_unverified'
                verified=config.get('verification',{})
                expected='live_ready' if environment=='live' else 'sandbox_verified'
                if (config.get('enabled') is True and verified.get('status')==expected
                        and verified.get('account')==account and verified.get('environment')==environment
                        and isinstance(verified.get('evidence'),str) and verified['evidence'].strip()
                        and isinstance(verified.get('checked_at'),str) and verified['checked_at'].strip()):status=expected
            result[provider]=dict(status=status,account=account,environment=environment,can_dispatch=status in ('sandbox_verified','live_ready'))
        return result

    def bind_queue(self,path):
        queue,_=build_queue(path,lambda day:None)
        self.submit_task=register_submission_task(queue,self.dispatch)
        return queue

    def enqueue(self,key,revision):
        with self.store.database.connect() as conn:
            row=self.store.submissions.row_in(conn,key);check_revision(revision,row['revision'])
            capability=self.capabilities()[row['snapshot']['provider']]
            if (not capability['can_dispatch'] or row['status']!='approved' or self.submit_task is None
                    or (capability['account'],capability['environment'])!=(row['snapshot']['account'],row['snapshot']['environment'])):
                raise Conflict('此通道尚未配置或核准已失效，未入列或送出')
            self.store.validate_submission_in(conn,row)
        self.submit_task({'schema_version':1,'intent_id':key})
        return dict(intent_id=key,queued=True)

    def dispatch(self,key):
        row=self.store.submissions.get(key);snapshot=row['snapshot'];provider=snapshot['provider']
        capability=self.capabilities()[provider]
        if not capability['can_dispatch']:return {'status':'not_configured'}
        config=self.config[provider];account=config['account'];environment=config['environment']
        def send(envelope):
            if provider=='email':
                return EmailSender(account,lambda:open_client(config['credential_path'],account))(envelope)
            secret=read_private_json(config['credential_path'])
            if secret.get('account')!=account or secret.get('environment')!=environment:raise ValueError('Freelancer credential binding mismatch')
            return FreelancerSender(account,environment,FreelancerHTTP(environment,secret.get('oauth_token')))(envelope)
        return execute(self.store,key,provider=provider,environment=environment,account=account,send=send)

    def verify_bid(self,key,revision,bid_id):
        row=self.store.submissions.get(key);check_revision(revision,row['revision']);snapshot=row['snapshot']
        capability=self.capabilities()['freelancer']
        if (snapshot['provider']!='freelancer' or row['status'] not in ('attempted','unknown') or not capability['can_dispatch']
                or (snapshot['account'],snapshot['environment'])!=(capability['account'],capability['environment'])):
            raise Conflict('此投標尚不可查證或帳號／環境不符')
        config=self.config['freelancer'];secret=read_private_json(config['credential_path'])
        if (secret.get('account'),secret.get('environment'))!=(snapshot['account'],snapshot['environment']):raise ValueError('Freelancer credential binding mismatch')
        sender=FreelancerSender(snapshot['account'],snapshot['environment'],FreelancerHTTP(snapshot['environment'],secret.get('oauth_token')))
        receipt=sender.lookup(snapshot,bid_id)
        return self.store.submissions.reconcile_verified(key,revision,receipt)
