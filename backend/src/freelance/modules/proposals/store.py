"""Proposal-owned persistence, append-only body revisions."""
import json
from uuid import uuid4
from freelance.platform.sqlite import encode
from freelance.platform.errors import InvalidAction, Conflict
from .domain import text, render, check_revision, request_id


class Proposals:
    def __init__(self,database):self.database=database

    def _template_in(self,conn,key):
        row=conn.execute('SELECT * FROM proposal_templates WHERE id=?',(key,)).fetchone()
        if not row:raise KeyError(key)
        return {k:v for k,v in row.items() if k not in ('request_id','request_payload')}

    def _replay_in(self,conn,table,command):
        key=request_id(command.get('request_id'))
        row=conn.execute(f'SELECT id,request_payload FROM {table} WHERE request_id=?',(key,)).fetchone()
        if row and json.loads(row['request_payload'])!=command:raise Conflict('建立請求已使用，請確認原紀錄')
        return row['id'] if row else None

    def _template_fields(self,command,extra):
        if not isinstance(command,dict) or set(command)!={'name','body',extra}:raise InvalidAction('模板欄位不完整')
        text(command['name'],200,required=True);render(command['body'],{})

    def create_template(self,command):
        self._template_fields(command,'request_id')
        with self.database.connect() as conn:
            replay=self._replay_in(conn,'proposal_templates',command)
            if replay:return self._template_in(conn,replay)
            key=str(uuid4());now=self.database.clock().isoformat()
            conn.execute('''INSERT INTO proposal_templates(id,name,body,revision,created_at,updated_at,request_id,request_payload)
                VALUES (?,?,?,1,?,?,?,?)''',(key,command['name'].strip(),command['body'],now,now,command['request_id'],encode(command)))
            return self._template_in(conn,key)

    def update_template(self,key,command):
        self._template_fields(command,'revision')
        with self.database.connect() as conn:
            row=self._template_in(conn,key);self._active(row,command['revision'])
            conn.execute('UPDATE proposal_templates SET name=?,body=?,revision=revision+1,updated_at=? WHERE id=?',
                (command['name'].strip(),command['body'],self.database.clock().isoformat(),key))
            return self._template_in(conn,key)

    def _active(self,row,revision):
        check_revision(revision,row['revision'])
        if row['archived_at'] is not None:raise Conflict('此提案／模板已封存')

    def _archive(self,table,key,revision):
        with self.database.connect() as conn:
            row=self._template_in(conn,key) if table=='proposal_templates' else self.row_in(conn,key)
            self._active(row,revision);now=self.database.clock().isoformat()
            conn.execute(f'UPDATE {table} SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=?',(now,now,key))
            return self._template_in(conn,key) if table=='proposal_templates' else self.row_in(conn,key)

    def archive_template(self,key,revision):return self._archive('proposal_templates',key,revision)
    def archive(self,key,revision):return self._archive('proposal_drafts',key,revision)

    def get_template(self,key):
        with self.database.connect(write=False) as conn:return self._template_in(conn,key)

    def _list(self,table,offset,limit,include_archived):
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=100 or type(include_archived) is not bool:
            raise InvalidAction('分頁格式不正確')
        where='1=1' if include_archived else 'archived_at IS NULL'
        with self.database.connect(write=False) as conn:
            total=conn.execute(f'SELECT COUNT(*) AS n FROM {table} WHERE {where}').fetchone()['n']
            keys=conn.execute(f'SELECT id FROM {table} WHERE {where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?',(limit,offset))
            items=[self._template_in(conn,r['id']) if table=='proposal_templates' else self.row_in(conn,r['id'],history=False) for r in keys]
            return dict(items=items,total=total,offset=offset,limit=limit)

    def list_templates(self,*,offset=0,limit=50,include_archived=False):return self._list('proposal_templates',offset,limit,include_archived)
    def list(self,*,offset=0,limit=50,include_archived=False):return self._list('proposal_drafts',offset,limit,include_archived)

    def replay_in(self,conn,command):
        replay=self._replay_in(conn,'proposal_drafts',command)
        return self.row_in(conn,replay) if replay else None

    def row_in(self,conn,key,*,history=True):
        row=conn.execute('SELECT * FROM proposal_drafts WHERE id=?',(key,)).fetchone()
        if not row:raise KeyError(key)
        result={k:v for k,v in row.items() if k not in ('request_id','request_payload')}
        for field in ('source_snapshot','party','source_tokens'):result[field]=json.loads(result[field])
        if history:
            result['versions']=[self._version_row(r) for r in conn.execute('SELECT * FROM proposal_draft_revisions WHERE draft_id=? ORDER BY version',(key,))]
        return result

    def _version_row(self,row):
        result={k:v for k,v in row.items() if k not in ('request_id','request_payload')}
        for field in ('values_json','missing','template_snapshot'):result[field]=json.loads(result[field])
        result['values']=result.pop('values_json')
        return result

    def version_in(self,conn,key,version):
        if type(version) is not int or version<1:raise InvalidAction('草稿版本格式不正確')
        row=conn.execute('SELECT * FROM proposal_draft_revisions WHERE draft_id=? AND version=?',(key,version)).fetchone()
        if not row:raise KeyError(key)
        return self._version_row(row)

    def get(self,key):
        with self.database.connect(write=False) as conn:return self.row_in(conn,key)

    def create_in(self,conn,command,source_snapshot,party):
        text(command['title'],200,required=True)
        template=None
        if command['template_id'] is not None:
            template=self._template_in(conn,command['template_id']);self._active(template,command['template_revision'])
            if command['body'] is not None:raise InvalidAction('模板建立請先預覽，勿同時提供正文')
            output=render(template['body'],command['values'])
        else:
            if command['template_revision'] is not None or command['values']:raise InvalidAction('未指定模板')
            text(command['body'],20000,required=True);output=dict(body=command['body'],missing=[])
        key=str(uuid4());now=self.database.clock().isoformat()
        conn.execute('''INSERT INTO proposal_drafts
            (id,title,revision,source_tokens,source_snapshot,party,created_at,updated_at,request_id,request_payload)
            VALUES (?,?,1,?,?,?,?,?,?,?)''',(key,command['title'].strip(),encode(command['versions']),encode(source_snapshot),encode(party),now,now,command['request_id'],encode(command)))
        self._insert_version(conn,key,1,output['body'],command['values'],output['missing'],template,command['request_id'],command,now)
        return self.row_in(conn,key)

    def _insert_version(self,conn,key,version,body,values,missing,template,request,payload,now):
        conn.execute('''INSERT INTO proposal_draft_revisions
            (draft_id,version,body,values_json,missing,template_snapshot,request_id,request_payload,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)''',(key,version,body,encode(values),encode(missing),encode(template),request,encode(payload),now))

    def append(self,key,command):
        if not isinstance(command,dict) or set(command)!={'revision','request_id','body'}:raise InvalidAction('草稿欄位不完整')
        request_id(command['request_id']);text(command['body'],20000,required=True)
        with self.database.connect() as conn:
            row=self.row_in(conn,key)
            replay=conn.execute('SELECT request_payload FROM proposal_draft_revisions WHERE draft_id=? AND request_id=?',(key,command['request_id'])).fetchone()
            if replay:
                if json.loads(replay['request_payload'])!=command:raise Conflict('儲存請求已使用，請確認原版本')
                return row
            self._active(row,command['revision']);now=self.database.clock().isoformat();version=row['revision']+1
            self._insert_version(conn,key,version,command['body'],{},[],None,command['request_id'],command,now)
            conn.execute('UPDATE proposal_drafts SET revision=?,updated_at=? WHERE id=?',(version,now,key))
            return self.row_in(conn,key)

    def apply_template(self,key,command):
        if not isinstance(command,dict) or set(command)!={'revision','request_id','template_id','template_revision','values'}:
            raise InvalidAction('模板套用欄位不完整')
        request_id(command['request_id'])
        with self.database.connect() as conn:
            row=self.row_in(conn,key)
            replay=conn.execute('SELECT request_payload FROM proposal_draft_revisions WHERE draft_id=? AND request_id=?',(key,command['request_id'])).fetchone()
            if replay:
                if json.loads(replay['request_payload'])!=command:raise Conflict('儲存請求已使用，請核對原版本')
                return row
            self._active(row,command['revision'])
            template=self._template_in(conn,command['template_id']);self._active(template,command['template_revision'])
            output=render(template['body'],command['values']);now=self.database.clock().isoformat();version=row['revision']+1
            self._insert_version(conn,key,version,output['body'],command['values'],output['missing'],template,command['request_id'],command,now)
            conn.execute('UPDATE proposal_drafts SET revision=?,updated_at=? WHERE id=?',(version,now,key))
            return self.row_in(conn,key)
