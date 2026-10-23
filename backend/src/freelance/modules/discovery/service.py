"""Discovery queries and atomic group feedback shared by all entry points."""
import json
from freelance.modules.discovery.rules import PUBLIC_JOB_FIELDS, project, evaluate, group_items
from freelance.platform.errors import Conflict, InvalidAction
from freelance.platform.sqlite import encode
from freelance.modules.discovery.ranking import rank_items, recommendation
from freelance.modules.preferences.public import empty_tracking

class Discovery:
    def __init__(self, database, records, preferences, settings, collection, applications):
        self.database, self.records = database, records
        self.preferences, self.settings, self.collection = preferences, settings, collection
        self.applications = applications

    def list_in(self, conn, now):
        rows = self.records.all(conn)
        settings = self.settings.read(conn)['settings']
        items = [project(row, settings, now) for row in rows]
        versions = {}
        for row in self.collection.content_versions(conn):
            versions.setdefault(row['opportunity_id'], []).append(row)
        states = self.preferences.states(conn)
        applications = self.applications.projections_in(conn)
        for item in items:
            item['tracking'] = states.get(item['id'], empty_tracking())
            application = applications.get(item['id'], dict(ids=[],token=[]))
            item['application_ids'] = application['ids']
            item['application_token'] = application['token']
            observed = versions.get(item['id'], [])
            if any(row['fingerprint'] != item['fingerprint'] for row in observed):
                choices = [dict(fingerprint=item['fingerprint'], job=item['job'],
                                evaluation=item['evaluation'], original=True)]
                choices.extend(dict(fingerprint=row['fingerprint'], job=json.loads(row['job']),
                                    evaluation=evaluate(json.loads(row['job']), settings, now), original=False)
                               for row in observed if row['fingerprint'] != item['fingerprint'])
                excluded = {'received_at', 'receipt_id', 'evidence_ref', 'raw_evidence_ref'}
                fields = sorted((set().union(*(choice['job'] for choice in choices)) - excluded) & PUBLIC_JOB_FIELDS)
                changed = [field for field in fields if len({encode(choice['job'].get(field)) for choice in choices}) > 1]
                item['content_conflicts'] = [dict(source=item['job']['source'], external_id=item['job']['external_id'],
                                                  versions=choices, changed_fields=changed)]
        return rank_items(items, now)


    def list(self):
        with self.database.connect(write=False) as conn:
            return self.list_in(conn, self.database.clock())

    def group_in(self, conn, key):
        group = next((item for item in group_items(self.list_in(conn,self.database.clock())) if key in item['member_ids']),None)
        if group is None:
            raise KeyError(key)
        return group

    def group(self, key):
        with self.database.connect(write=False) as conn:
            return self.group_in(conn, key)


    def feedback(self, key, versions, feedback):
        if feedback not in ('neutral', 'interested', 'skipped'):
            raise InvalidAction('不支援的職缺狀態')
        with self.database.connect() as conn:
            items = self.list_in(conn, self.database.clock())
            group = next((item for item in group_items(items) if key in item['member_ids']), None)
            if group is None:
                raise KeyError(key)
            expected = {member['id']: member['token'] for member in group['members']}
            if (not isinstance(versions, dict) or any(not isinstance(value, str) for value in versions.values())
                    or versions != expected):
                raise Conflict('職缺或收藏狀態已更新，請重新載入')
            by_id = {item['id']: item for item in items}
            for member in group['members']:
                state = by_id[member['id']]['tracking']
                self.preferences.track(member['id'], member['revision'], feedback=feedback,
                           note=state.get('note', ''), evidence=state.get('evidence', ''), _conn=conn, records=self.records)
            return {'status': 'saved'}

    def track(self, key, revision, *, feedback=None, stage=None, reason='', note='', evidence='', _conn=None):
        """Record tracking through preferences, then assemble the recommendation, which belongs to discovery."""
        now = self.database.clock()
        item = self.preferences.track(key, revision, feedback=feedback, stage=stage, reason=reason, note=note,
                                      evidence=evidence, _conn=_conn, records=self.records, now=now)
        item['recommendation'] = recommendation(item, now)
        return item
