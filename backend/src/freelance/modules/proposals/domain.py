"""Bounded pure-text rendering; no expression evaluation or inferred facts."""
from string import Formatter
from freelance.platform.errors import InvalidAction, Conflict

PLACEHOLDERS=('opportunity_title','client_name','approach','portfolio','quote')


def text(value,limit,*,required=False):
    if not isinstance(value,str) or len(value)>limit or (required and not value.strip()):
        raise InvalidAction('提案文字格式或長度不符限制')
    return value


def render(template,values):
    text(template,20000)
    if not isinstance(values,dict) or set(values)-set(PLACEHOLDERS):
        raise InvalidAction('不支援的模板變數')
    for value in values.values(): text(value,10000)
    missing=[];parts=[]
    try:
        tokens=list(Formatter().parse(template))
    except ValueError:
        raise InvalidAction('模板括號格式不正確') from None
    for literal,name,spec,conversion in tokens:
        parts.append(literal)
        if name is None: continue
        if name not in PLACEHOLDERS or spec or conversion:
            raise InvalidAction('模板只支援列出的純文字變數')
        value=values.get(name,'')
        if not value.strip():
            if name not in missing:missing.append(name)
            value=f'【待填：{name}】'
        parts.append(value)
    body=''.join(parts);text(body,20000)
    return dict(body=body,missing=missing)


def check_revision(value,expected):
    if type(value) is not int or value!=expected:
        raise Conflict('提案已更新，請核對最新版本；本人文字仍可保留')


def request_id(value):
    if not isinstance(value,str) or not value.strip() or len(value)>100:
        raise InvalidAction('建立請求識別格式不正確')
    return value
