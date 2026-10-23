"""Stable store/CLI facade composing focused product modules."""
from freelance.platform.sqlite import Database
from freelance.legacy.records import Records
from freelance.modules.collection.source_catalog import SOURCES
from freelance.modules.collection.store import Collection
from freelance.modules.discovery.service import Discovery
from freelance.modules.discovery.public import DiscoverySettings
from freelance.modules.preferences.store import Preferences
from freelance.modules.notifications.store import Notifications
from freelance.legacy.review_service import Legacy
from freelance.modules.applications.public import Applications
from freelance.modules.relationships.public import Relationships
from freelance.modules.proposals.public import Proposals
from freelance.modules.submissions.public import Submissions
from freelance.platform.errors import Conflict, InvalidAction

class SQLiteStore:
    def __init__(self, path, clock=None, *, database=None):
        self.database = Database(path, clock) if database is None else database
        self.path, self.clock = self.database.path, self.database.clock
        self.personal = Preferences(self.database)
        self.settings = DiscoverySettings(self.database)
        self.records = Records(self.database, self.settings)
        self.collection = Collection(self.database, self.records, self.settings, SOURCES)
        self.applications = Applications(self.database)
        self.relationships = Relationships(self.database)
        self.proposals = Proposals(self.database)
        self.submissions = Submissions(self.database)
        self.discovery = Discovery(self.database, self.records, self.personal, self.settings, self.collection, self.applications)
        self.notifications = Notifications(self.database, self.discovery, self.collection)
        self.legacy = Legacy(self.database, self.records, self.personal, self.settings, self.discovery)

    def migrate(self):
        return self.database.migrate()

    def create_application(self, command):
        with self.database.connect() as conn:
            replay = self.applications.replay_in(conn, command)
            if replay is not None:
                return replay
            versions = command.get('versions', {})
            if not isinstance(versions, dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in versions.items()):
                raise InvalidAction('職缺版本格式不正確')
            if versions:
                group = self.discovery.group_in(conn, next(iter(versions)))
                if versions != {m['id']:m['token'] for m in group['members']}:
                    raise Conflict('職缺或投案狀態已更新，請重新載入')
            party=self.relationships.selection_in(conn,command['party']) if command.get('party') is not None else None
            proposal=self.application_proposal_in(conn,command)
            return self.applications.create_in(conn,command,sorted(versions),party=party,proposal=proposal)

    def application_proposal_in(self,conn,command):
        draft_id=command.get('proposal_id');version=command.get('proposal_version');submission_id=command.get('submission_id');evidence=None
        if submission_id:
            intent=self.submissions.row_in(conn,submission_id)
            if intent['status']=='accepted':evidence=dict(kind='provider_accepted',receipt=intent['receipt'])
            elif intent['reconciliation'] is not None:evidence=dict(kind=intent['reconciliation']['outcome'],reconciliation=intent['reconciliation'])
            else:raise Conflict('送出結果尚未查證，不能關聯為已投案')
            if (draft_id is not None and draft_id!=intent['draft_id']) or (version is not None and version!=intent['draft_version']):
                raise Conflict('送出與草稿版本不相符')
            draft_id=intent['draft_id'];version=intent['draft_version']
        if draft_id is None:
            if version is not None:raise InvalidAction('未指定草稿')
            return None
        draft=self.proposals.row_in(conn,draft_id)
        self.proposals.version_in(conn,draft_id,version)
        if not set(draft['source_tokens']).issubset(command.get('versions',{})):
            raise Conflict('投案職缺與草稿原來源不相符，請核對原案件及目前來源群組')
        return dict(draft_id=draft_id,draft_version=version,title=draft['title'],submission_id=submission_id,evidence=evidence)

    def list_applications(self, **options):
        return self.applications.list(**options)

    def update_application(self, key, command):
        return self.applications.update(key,command)

    def get_application(self, key):
        return self.applications.get(key)

    def delete_application(self, key, revision):
        return self.applications.delete(key,revision)

    def application_summary(self):
        return self.applications.summary()

    def set_application_party(self,key,command):
        if not isinstance(command,dict) or set(command)!={'revision','client_id','client_revision','contact_id','contact_revision'}:
            raise InvalidAction('投案客戶關聯格式不正確')
        with self.database.connect() as conn:
            selection=self.relationships.selection_in(conn,{k:v for k,v in command.items() if k!='revision'})
            return self.applications.set_party_in(conn,key,command['revision'],selection)

    def create_proposal(self,command):
        required={'request_id','title','body','template_id','template_revision','values','versions','party'}
        if not isinstance(command,dict) or set(command)!=required:raise InvalidAction('草稿欄位不完整')
        with self.database.connect() as conn:
            replay=self.proposals.replay_in(conn,command)
            if replay:return replay
            versions=command['versions'];snapshot=None
            if not isinstance(versions,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in versions.items()):
                raise InvalidAction('職缺版本格式不正確')
            if versions:
                group=self.discovery.group_in(conn,next(iter(versions)))
                if versions!={m['id']:m['token'] for m in group['members']}:raise Conflict('職缺已更新，請重新載入')
                snapshot={'job':group['job'],'member_ids':group['member_ids']}
            party=self.relationships.selection_in(conn,command['party']) if command['party'] is not None else None
            return self.proposals.create_in(conn,command,snapshot,party)

    def prepare_submission(self,command):
        required={'request_id','draft_id','draft_version','provider','environment','account','fields'}
        if not isinstance(command,dict) or set(command)!=required:raise InvalidAction('送出欄位不完整')
        with self.database.connect() as conn:
            replay=self.submissions.replay_in(conn,command)
            if replay:return replay
            draft=self.proposals.row_in(conn,command['draft_id'])
            if draft['archived_at'] is not None:raise Conflict('此草稿已封存')
            version=self.proposals.version_in(conn,draft['id'],command['draft_version'])
            self.validate_source_tokens_in(conn,draft['source_tokens'])
            return self.submissions.prepare_in(conn,command,version,draft['source_tokens'])

    def validate_source_tokens_in(self,conn,tokens):
        if tokens:
            group=self.discovery.group_in(conn,next(iter(tokens)))
            if tokens!={m['id']:m['token'] for m in group['members']}:raise Conflict('來源或人工狀態已更新，請重新核對送出內容')

    def validate_submission_in(self,conn,intent):
        draft=self.proposals.row_in(conn,intent['draft_id'])
        version=self.proposals.version_in(conn,intent['draft_id'],intent['draft_version'])
        if draft['archived_at'] is not None or version['body']!=intent['snapshot']['body']:raise Conflict('所選草稿版本不再可送出')
        self.validate_source_tokens_in(conn,intent['snapshot']['source_tokens'])

    # Historical AI/approval validation only; never exposed by HTTP.
    def _connect(self, *, write=True):
        return self.database.connect(write=write)

    def _save(self, conn, item):
        return self.records.save(conn, item)

    def _list(self, conn, now):
        return self.discovery.list_in(conn, now)

    def ingest(self, job, receipt_id=None, *, _conn=None):
        return self.collection.ingest(job, receipt_id, _conn=_conn)

    def ingest_resend_batch(self, jobs):
        return self.collection.ingest_resend_batch(jobs)

    def set_source_health(self, source, status):
        return self.collection.set_source_health(source, status)

    def source_batch(self, source):
        return self.collection.source_batch(source)

    def existing_source_ids(self, source):
        return self.collection.existing_source_ids(source)

    def mail_state(self, source, recipient):
        return self.collection.mail_state(source, recipient)

    def save_mail_state(self, source, recipient, state):
        return self.collection.save_mail_state(source, recipient, state)

    def mail_records(self, source, recipient):
        return self.collection.mail_records(source, recipient)

    def record_mail(self, source, recipient, message_id, status, reason=None):
        return self.collection.record_mail(source, recipient, message_id, status, reason)

    def retry_mail(self, source, recipient, message_id):
        return self.collection.retry_mail(source, recipient, message_id)

    def sources(self):
        return self.collection.sources()

    def operations(self):
        return self.notifications.operations()

    def list(self):
        return self.discovery.list()

    def opportunity(self, key):
        return self.discovery.group(key)

    def feedback(self, key, versions, feedback):
        return self.discovery.feedback(key, versions, feedback)

    def preferences(self):
        return self.settings.current()

    def set_preferences(self, revision, settings):
        return self.settings.replace(revision, settings)

    def track(self, key, revision, *, feedback=None, stage=None, reason='', note='', evidence='', _conn=None):
        return self.discovery.track(key, revision, feedback=feedback, stage=stage, reason=reason, note=note, evidence=evidence, _conn=_conn)

    def create_digest(self, local_date, recipient, now):
        return self.notifications.create_digest(local_date, recipient, now)

    def find_digest(self, local_date, recipient):
        return self.notifications.find_digest(local_date, recipient)

    def get_digest(self, intent_id):
        return self.notifications.get_digest(intent_id)

    def claim_digest(self, intent_id):
        return self.notifications.claim_digest(intent_id)

    def finish_digest(self, intent_id, status, receipt=None):
        return self.notifications.finish_digest(intent_id, status, receipt)

    def claim_daily_run(self, local_date, recipient, now):
        return self.notifications.claim_daily_run(local_date, recipient, now)

    def get_daily_run(self, local_date, recipient):
        return self.notifications.get_daily_run(local_date, recipient)

    def finish_daily_run(self, local_date, recipient, status, result, now):
        return self.notifications.finish_daily_run(local_date, recipient, status, result, now)

    def review(self, key, action, version, text='', reason=''):
        return self.legacy.review(key, action, version, text, reason)

    def tracking_summary(self):
        return self.legacy.tracking_summary()

def main():
    import argparse
    import sqlite3
    parser = argparse.ArgumentParser(description='Explicit SQLite migration; no external connectors')
    parser.add_argument('--migrate', action='store_true', required=True)
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    try:
        SQLiteStore(args.database).migrate()
    except (sqlite3.Error, OSError, ValueError):
        parser.exit(1, 'SQLite migration failed; inspect the local database path.\n')
    print('migration complete')


if __name__ == '__main__':
    main()
