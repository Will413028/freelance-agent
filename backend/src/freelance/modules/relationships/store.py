"""Relationship-owned SQL; caller transactions preserve cross-module atomicity."""
import json
from uuid import uuid4
from freelance.platform.sqlite import encode
from freelance.platform.errors import Conflict, InvalidAction
from .domain import fields, request_id, check_revision, pagination


class Relationships:
    def __init__(self,database):
        self.database=database

    def _row_in(self,conn,table,key):
        row=conn.execute(f'SELECT * FROM {table} WHERE id=?',(key,)).fetchone()
        if row is None: raise KeyError(key)
        return {k:v for k,v in row.items() if k not in ('request_id','request_payload')}

    def _replay_in(self,conn,table,command):
        request=request_id(command.get('request_id'))
        row=conn.execute(f'SELECT id,request_payload FROM {table} WHERE request_id=?',(request,)).fetchone()
        if row is None: return None
        if json.loads(row['request_payload'])!=command:
            raise Conflict('建立請求已使用，請確認原紀錄')
        return self._row_in(conn,table,row['id'])

    def get_client(self,key):
        with self.database.connect(write=False) as conn:
            return self._row_in(conn,'clients',key)

    def get_contact(self,key):
        with self.database.connect(write=False) as conn:
            return self._row_in(conn,'client_contacts',key)

    def create_client(self,command):
        data=fields(command,('name','note'),extra=('request_id',))
        with self.database.connect() as conn:
            replay=self._replay_in(conn,'clients',command)
            if replay is not None: return replay
            key=str(uuid4());now=self.database.clock().isoformat()
            conn.execute('''INSERT INTO clients
                (id,name,note,revision,created_at,updated_at,request_id,request_payload)
                VALUES (?,?,?,1,?,?,?,?)''',(key,data['name'],data['note'],now,now,command['request_id'],encode(command)))
            return self._row_in(conn,'clients',key)

    def create_contact(self,command):
        data=fields(command,('name','address','note'),extra=('request_id','client_id','client_revision'))
        with self.database.connect() as conn:
            replay=self._replay_in(conn,'client_contacts',command)
            if replay is not None: return replay
            client=self._row_in(conn,'clients',command['client_id'])
            self._active(client,command['client_revision'])
            key=str(uuid4());now=self.database.clock().isoformat()
            conn.execute('''INSERT INTO client_contacts
                (id,client_id,name,address,note,revision,created_at,updated_at,request_id,request_payload)
                VALUES (?,?,?,?,?,1,?,?,?,?)''',
                (key,client['id'],data['name'],data['address'],data['note'],now,now,command['request_id'],encode(command)))
            return self._row_in(conn,'client_contacts',key)

    def _active(self,row,revision):
        check_revision(revision,row['revision'])
        if row['archived_at'] is not None: raise Conflict('此客戶／聯絡人已封存')

    def update_client(self,key,command):
        data=fields(command,('name','note'),extra=('revision',))
        with self.database.connect() as conn:
            self._active(self._row_in(conn,'clients',key),command['revision'])
            conn.execute('UPDATE clients SET name=?,note=?,revision=revision+1,updated_at=? WHERE id=?',
                         (data['name'],data['note'],self.database.clock().isoformat(),key))
            return self._row_in(conn,'clients',key)

    def update_contact(self,key,command):
        data=fields(command,('name','address','note'),extra=('revision',))
        with self.database.connect() as conn:
            self._active(self._row_in(conn,'client_contacts',key),command['revision'])
            conn.execute('UPDATE client_contacts SET name=?,address=?,note=?,revision=revision+1,updated_at=? WHERE id=?',
                         (data['name'],data['address'],data['note'],self.database.clock().isoformat(),key))
            return self._row_in(conn,'client_contacts',key)

    def _archive(self,table,key,revision):
        with self.database.connect() as conn:
            row=self._row_in(conn,table,key)
            self._active(row,revision)
            now=self.database.clock().isoformat()
            conn.execute(f'UPDATE {table} SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=?',(now,now,key))
            return self._row_in(conn,table,key)

    def archive_client(self,key,revision):
        return self._archive('clients',key,revision)

    def archive_contact(self,key,revision):
        return self._archive('client_contacts',key,revision)

    def _list_in(self,conn,table,where,args,offset,limit):
        total=conn.execute(f'SELECT COUNT(*) AS n FROM {table} WHERE {where}',args).fetchone()['n']
        keys=conn.execute(f'SELECT id FROM {table} WHERE {where} ORDER BY name,id LIMIT ? OFFSET ?',(*args,limit,offset))
        return dict(items=[self._row_in(conn,table,r['id']) for r in keys],total=total,offset=offset,limit=limit)

    def list_clients(self,*,offset=0,limit=50,include_archived=False):
        pagination(offset,limit,include_archived)
        with self.database.connect(write=False) as conn:
            return self._list_in(conn,'clients','1=1' if include_archived else 'archived_at IS NULL',(),offset,limit)

    def list_contacts(self,client_id,*,offset=0,limit=50,include_archived=False):
        pagination(offset,limit,include_archived)
        with self.database.connect(write=False) as conn:
            self._row_in(conn,'clients',client_id)
            where='client_id=?'+('' if include_archived else ' AND archived_at IS NULL')
            return self._list_in(conn,'client_contacts',where,(client_id,),offset,limit)

    def selection_in(self,conn,command):
        """Verify current explicit selection and return a historical snapshot."""
        allowed={'client_id','client_revision','contact_id','contact_revision'}
        if not isinstance(command,dict) or set(command)-allowed:
            raise InvalidAction('客戶關聯格式不正確')
        if command.get('client_id') is None:
            if any(command.get(k) is not None for k in allowed):
                raise InvalidAction('聯絡人須有客戶')
            return None
        client=self._row_in(conn,'clients',command['client_id'])
        self._active(client,command.get('client_revision'))
        contact=None
        if command.get('contact_id') is not None:
            contact=self._row_in(conn,'client_contacts',command['contact_id'])
            self._active(contact,command.get('contact_revision'))
            if contact['client_id']!=client['id']: raise Conflict('聯絡人不屬於此客戶')
        elif command.get('contact_revision') is not None:
            raise InvalidAction('未指定聯絡人')
        return dict(client_id=client['id'],client_name=client['name'],
                    contact_id=contact['id'] if contact else None,
                    contact_name=contact['name'] if contact else None,
                    contact_address=contact['address'] if contact else None)
