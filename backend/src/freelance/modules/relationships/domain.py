"""Framework-free validation for user-maintained contact information."""
from freelance.platform.errors import Conflict, InvalidAction


def fields(command, names, *, extra=()):
    if not isinstance(command,dict) or set(command) != set(names) | set(extra):
        raise InvalidAction('客戶／聯絡人欄位不完整或不支援')
    result={}
    for name in names:
        value=command[name]
        limit=2000 if name=='note' else 200
        if not isinstance(value,str) or len(value)>limit or (name=='name' and not value.strip()):
            raise InvalidAction('客戶／聯絡人格式或長度不符限制')
        result[name]=value.strip()
    return result


def request_id(value):
    if not isinstance(value,str) or not value.strip() or len(value)>100:
        raise InvalidAction('建立請求識別格式不正確')
    return value


def check_revision(value, expected):
    if type(value) is not int or value!=expected:
        raise Conflict('客戶／聯絡人已更新，請重新載入')


def pagination(offset,limit,include_archived):
    if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=100 or type(include_archived) is not bool:
        raise InvalidAction('分頁格式不正確')
