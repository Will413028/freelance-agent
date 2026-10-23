"""Submission-owned immutable envelopes and append-only evidence events."""
import json
from uuid import uuid4
from freelance.platform.sqlite import encode
from freelance.platform.errors import Conflict, InvalidAction
from .domain import digest, snapshot, check_revision, accepted_receipt, bounded


class Submissions:
    def __init__(self,database):self.database=database

    def row_in(self,conn,key):
        row=conn.execute('SELECT * FROM submission_intents WHERE id=?',(key,)).fetchone()
        if not row:raise KeyError(key)
        result={k:v for k,v in row.items() if k not in ('request_id','request_payload')}
        for field in ('snapshot','receipt','reconciliation'):result[field]=json.loads(result[field]) if result[field] is not None else None
        return result

    def get(self,key):
        with self.database.connect(write=False) as conn:return self.row_in(conn,key)

    def list(self,*,offset=0,limit=50):
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=100:raise InvalidAction('分頁格式不正確')
        with self.database.connect(write=False) as conn:
            total=conn.execute('SELECT COUNT(*) AS n FROM submission_intents').fetchone()['n']
            keys=conn.execute('SELECT id FROM submission_intents ORDER BY created_at DESC,id LIMIT ? OFFSET ?',(limit,offset))
            return dict(items=[self.row_in(conn,r['id']) for r in keys],total=total,offset=offset,limit=limit)

    def _event_in(self,conn,key,action,evidence=None):
        row=self.row_in(conn,key)
        conn.execute('INSERT INTO submission_events(intent_id,revision,action,evidence,created_at) VALUES (?,?,?,?,?)',
            (key,row['revision'],action,encode(evidence),self.database.clock().isoformat()))
        return row

    def replay_in(self,conn,command):
        bounded(command.get('request_id'),100)
        row=conn.execute('SELECT id,request_payload FROM submission_intents WHERE request_id=?',(command['request_id'],)).fetchone()
        if row and json.loads(row['request_payload'])!=command:raise Conflict('建立請求已使用，請核對原送出紀錄')
        return self.row_in(conn,row['id']) if row else None

    def prepare_in(self,conn,command,version,source_tokens):
        key=str(uuid4());now=self.database.clock();envelope=snapshot(command,version,key,now)
        envelope['source_tokens']=source_tokens
        conn.execute('''INSERT INTO submission_intents
            (id,draft_id,draft_version,snapshot,snapshot_hash,status,revision,created_at,updated_at,request_id,request_payload)
            VALUES (?,?,?,?,?,'prepared',1,?,?,?,?)''',
            (key,command['draft_id'],command['draft_version'],encode(envelope),digest(envelope),now.isoformat(),now.isoformat(),command['request_id'],encode(command)))
        return self._event_in(conn,key,'prepared')

    def approve(self,key,command):
        if not isinstance(command,dict) or set(command)!={'revision','snapshot_hash'}:raise InvalidAction('核准欄位不完整')
        with self.database.connect() as conn:
            row=self.row_in(conn,key);check_revision(command['revision'],row['revision'])
            if row['status']!='prepared' or command['snapshot_hash']!=row['snapshot_hash'] or digest(row['snapshot'])!=row['snapshot_hash']:
                raise Conflict('內容或送出狀態已更新，請重新核准')
            conn.execute("UPDATE submission_intents SET status='approved',approval_hash=?,revision=revision+1,updated_at=? WHERE id=?",
                         (row['snapshot_hash'],self.database.clock().isoformat(),key))
            return self._event_in(conn,key,'approved')

    def claim_in(self,conn,key,provider,environment,account):
        row=self.row_in(conn,key)
        if row['status'] in ('attempted','accepted','rejected','unknown','cancelled'):return row,False
        if row['status']!='approved':raise Conflict('尚未核准完整送出內容')
        envelope=row['snapshot']
        if (envelope['provider'],envelope['environment'],envelope['account'])!=(provider,environment,account):raise Conflict('送出帳號／通道／環境已變更')
        if row['approval_hash']!=row['snapshot_hash'] or digest(envelope)!=row['snapshot_hash']:raise Conflict('內容核准不相符')
        now=self.database.clock().isoformat()
        conn.execute("UPDATE submission_intents SET status='attempted',attempted_at=?,updated_at=?,revision=revision+1 WHERE id=?",(now,now,key))
        return self._event_in(conn,key,'attempted'),True

    def finish(self,key,result):
        with self.database.connect() as conn:
            row=self.row_in(conn,key)
            if row['status']!='attempted':return row
            status,receipt=accepted_receipt(row['snapshot'],result);now=self.database.clock().isoformat()
            conn.execute('UPDATE submission_intents SET status=?,receipt=?,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?',
                         (status,encode(receipt),now,now,key))
            return self._event_in(conn,key,status,receipt)

    def cancel(self,key,revision):
        with self.database.connect() as conn:
            row=self.row_in(conn,key);check_revision(revision,row['revision'])
            if row['status'] not in ('prepared','approved'):raise Conflict('已attempt的送出不可取消或重試')
            conn.execute("UPDATE submission_intents SET status='cancelled',revision=revision+1,updated_at=? WHERE id=?",(self.database.clock().isoformat(),key))
            return self._event_in(conn,key,'cancelled')

    def cancel_pending_for_rollback(self):
        with self.database.connect() as conn:
            keys=[r['id'] for r in conn.execute("SELECT id FROM submission_intents WHERE status='approved'")]
            for key in keys:
                conn.execute("UPDATE submission_intents SET status='cancelled',revision=revision+1,updated_at=? WHERE id=?",(self.database.clock().isoformat(),key))
                self._event_in(conn,key,'rollback_cancelled')
            return len(keys)

    def reconcile(self,key,command):
        if not isinstance(command,dict) or set(command)!={'revision','outcome','note','reference'} or command['outcome']!='user_reported':
            raise InvalidAction('人工核對只能記為本人陳述，不能偽造provider證據')
        bounded(command['note'],2000);bounded(command['reference'],500)
        with self.database.connect() as conn:
            row=self.row_in(conn,key);check_revision(command['revision'],row['revision'])
            if row['status'] not in ('attempted','unknown'):raise Conflict('此送出不需不確定結果核對')
            evidence={k:command[k] for k in ('outcome','note','reference')}
            evidence['checked_at']=self.database.clock().isoformat()
            conn.execute('UPDATE submission_intents SET reconciliation=?,revision=revision+1,updated_at=? WHERE id=?',
                         (encode(evidence),evidence['checked_at'],key))
            return self._event_in(conn,key,'reconciled',evidence)

    def reconcile_verified(self,key,revision,receipt):
        """Worker/operator lookup evidence, never accepted from a browser receipt."""
        with self.database.connect() as conn:
            row=self.row_in(conn,key);check_revision(revision,row['revision'])
            if row['status'] not in ('attempted','unknown'):raise Conflict('此紀錄不需不確定結果核對')
            status,verified=accepted_receipt(row['snapshot'],dict(status='accepted',receipt=receipt))
            if status!='accepted' or row['snapshot']['provider']!='freelancer':raise InvalidAction('缺少相符provider證據')
            evidence=dict(outcome='provider_verified_accepted',receipt=verified,checked_at=self.database.clock().isoformat())
            conn.execute('UPDATE submission_intents SET reconciliation=?,revision=revision+1,updated_at=? WHERE id=?',
                         (encode(evidence),evidence['checked_at'],key))
            return self._event_in(conn,key,'provider_reconciled',evidence)
