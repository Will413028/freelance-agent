"""Application-owned persistence; caller transactions coordinate discovery links."""
import json
from uuid import uuid4
from freelance.platform.sqlite import encode
from freelance.platform.errors import Conflict, InvalidAction
from .domain import FIELDS, STAGES, validate, revision_check, local_day, week_start

class Applications:
    def __init__(self, database):
        self.database = database

    def row_in(self, conn, key):
        row = conn.execute('SELECT * FROM manual_applications WHERE id=?',(key,)).fetchone()
        if not row:
            raise KeyError(key)
        result = {k:v for k,v in row.items() if k not in ('request_id','request_payload')}
        result['opportunity_ids'] = [r['opportunity_id'] for r in conn.execute(
            'SELECT opportunity_id FROM manual_application_opportunities WHERE application_id=? ORDER BY opportunity_id',(key,))]
        party=conn.execute('SELECT snapshot FROM application_parties WHERE application_id=?',(key,)).fetchone()
        result['party']=json.loads(party['snapshot']) if party else None
        proposal=conn.execute('SELECT snapshot FROM application_proposals WHERE application_id=?',(key,)).fetchone()
        result['proposal']=json.loads(proposal['snapshot']) if proposal else None
        return result

    def set_party_in(self,conn,key,revision,selection):
        row=self.row_in(conn,key)
        if row['deleted_at'] is not None: raise KeyError(key)
        revision_check(revision,row['revision'])
        if selection is None:
            conn.execute('DELETE FROM application_parties WHERE application_id=?',(key,))
        else:
            conn.execute('''INSERT INTO application_parties(application_id,client_id,contact_id,snapshot)
                VALUES (?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET
                client_id=excluded.client_id,contact_id=excluded.contact_id,snapshot=excluded.snapshot''',
                (key,selection['client_id'],selection['contact_id'],encode(selection)))
        now=self.database.clock()
        conn.execute('UPDATE manual_applications SET revision=revision+1,updated_at=? WHERE id=?',(now.isoformat(),key))
        result=self.row_in(conn,key)
        self.event_in(conn,result,'updated',now)
        return result

    def replay_in(self, conn, command):
        request = command.get('request_id')
        if not isinstance(request,str) or not request.strip() or len(request)>100:
            raise InvalidAction('建立請求識別格式不正確')
        row = conn.execute('SELECT id,request_payload FROM manual_applications WHERE request_id=?',(request,)).fetchone()
        if row:
            if json.loads(row['request_payload']) != command:
                raise Conflict('建立請求已使用，請確認原紀錄')
            return self.row_in(conn,row['id'])
        return None

    def event_in(self,conn,row,action,now):
        conn.execute('INSERT INTO manual_application_events(application_id,revision,action,state,created_at) VALUES (?,?,?,?,?)',
                     (row['id'],row['revision'],action,encode(row),now.isoformat()))

    def create_in(self,conn,command,opportunity_ids,*,party=None,proposal=None):
        now=self.database.clock()
        data=validate(command,now)
        for key in opportunity_ids:
            if conn.execute('''SELECT 1 FROM manual_application_opportunities l JOIN manual_applications a
                ON a.id=l.application_id WHERE l.opportunity_id=? AND a.deleted_at IS NULL''',(key,)).fetchone():
                raise Conflict('這個職缺已有投案紀錄')
        key=str(uuid4())
        if proposal and proposal['submission_id'] and conn.execute('SELECT 1 FROM application_proposals WHERE submission_id=?',(proposal['submission_id'],)).fetchone():
            raise Conflict('這次送出已有投案紀錄，請查看原紀錄')
        conn.execute('''INSERT INTO manual_applications
            (id,title,contact,url,applied_on,stage,follow_up_on,note,revision,created_at,updated_at,request_id,request_payload)
            VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)''',
            (key,*(data[k] for k in FIELDS),now.isoformat(),now.isoformat(),command['request_id'],encode(command)))
        for member in opportunity_ids:
            conn.execute('INSERT INTO manual_application_opportunities(application_id,opportunity_id) VALUES (?,?)',(key,member))
        if party:
            conn.execute('INSERT INTO application_parties(application_id,client_id,contact_id,snapshot) VALUES (?,?,?,?)',
                         (key,party['client_id'],party['contact_id'],encode(party)))
        if proposal:
            conn.execute('INSERT INTO application_proposals(application_id,draft_id,draft_version,submission_id,snapshot) VALUES (?,?,?,?,?)',
                         (key,proposal['draft_id'],proposal['draft_version'],proposal['submission_id'],encode(proposal)))
        result=self.row_in(conn,key)
        self.event_in(conn,result,'created',now)
        return result

    def update(self,key,command):
        with self.database.connect() as conn:
            row=self.row_in(conn,key)
            if row['deleted_at'] is not None: raise KeyError(key)
            revision_check(command.get('revision'),row['revision'])
            now=self.database.clock(); data=validate(command,now)
            conn.execute('''UPDATE manual_applications SET title=?,contact=?,url=?,applied_on=?,stage=?,follow_up_on=?,note=?,
                revision=revision+1,updated_at=? WHERE id=?''',(*(data[k] for k in FIELDS),now.isoformat(),key))
            result=self.row_in(conn,key); self.event_in(conn,result,'updated',now)
            return result

    def get(self,key):
        with self.database.connect(write=False) as conn:
            row=self.row_in(conn,key)
            if row['deleted_at'] is not None: raise KeyError(key)
            return row

    def delete(self,key,revision):
        with self.database.connect() as conn:
            row=self.row_in(conn,key)
            if row['deleted_at'] is not None: raise KeyError(key)
            revision_check(revision,row['revision'])
            now=self.database.clock()
            conn.execute('UPDATE manual_applications SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?',
                         (now.isoformat(),now.isoformat(),key))
            self.event_in(conn,self.row_in(conn,key),'deleted',now)
            return {'status':'saved'}

    def projections_in(self,conn):
        result={}
        for row in conn.execute('''SELECT l.opportunity_id,a.id,a.revision,a.deleted_at FROM manual_application_opportunities l
                JOIN manual_applications a ON a.id=l.application_id ORDER BY a.id'''):
            view=result.setdefault(row['opportunity_id'],dict(ids=[],token=[]))
            if row['deleted_at'] is None: view['ids'].append(row['id'])
            view['token'].append(f"{row['id']}:{row['revision']}:{row['deleted_at'] or ''}")
        return result

    def list(self,*,stage=None,due=False,offset=0,limit=50,client_id=None):
        if stage is not None and stage not in STAGES: raise InvalidAction('不支援的投案階段')
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=100 or type(due) is not bool:
            raise InvalidAction('分頁格式不正確')
        where='deleted_at IS NULL'; args=[]
        if client_id is not None:
            if not isinstance(client_id,str) or not client_id: raise InvalidAction('客戶識別格式不正確')
            where+=' AND id IN (SELECT application_id FROM application_parties WHERE client_id=?)';args.append(client_id)
        if stage is not None: where+=' AND stage=?'; args.append(stage)
        if due:
            where+=" AND stage IN ('applied','negotiating') AND follow_up_on<=?"; args.append(local_day(self.database.clock()).isoformat())
        with self.database.connect(write=False) as conn:
            total=conn.execute('SELECT COUNT(*) AS n FROM manual_applications WHERE '+where,args).fetchone()['n']
            order='follow_up_on ASC,applied_on ASC,id' if due else 'applied_on DESC,created_at DESC,id'
            keys=conn.execute('SELECT id FROM manual_applications WHERE '+where+' ORDER BY '+order+' LIMIT ? OFFSET ?',(*args,limit,offset)).fetchall()
            return dict(items=[self.row_in(conn,r['id']) for r in keys],total=total,offset=offset,limit=limit)

    def summary(self):
        now=self.database.clock(); today=local_day(now).isoformat(); start=week_start(now).isoformat()
        with self.database.connect(write=False) as conn:
            row=conn.execute('''SELECT
                COALESCE(SUM(applied_on BETWEEN ? AND ?),0) AS weekly_count,
                COALESCE(SUM(stage IN ('applied','negotiating') AND follow_up_on<=?),0) AS due_count,
                COALESCE(SUM(stage IN ('applied','negotiating') AND follow_up_on<?),0) AS overdue_count
                FROM manual_applications WHERE deleted_at IS NULL''',(start,today,today,today)).fetchone()
            return dict(row,week_start=start,today=today)
