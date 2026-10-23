"""Framework-free validation for user-reported applications."""
from datetime import date, timedelta
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
from freelance.platform.errors import InvalidAction, Conflict

FIELDS = ('title', 'contact', 'url', 'applied_on', 'stage', 'follow_up_on', 'note')
STAGES = ('applied', 'negotiating', 'won', 'closed')

def local_day(now):
    return now.astimezone(ZoneInfo('Asia/Taipei')).date()

def week_start(now):
    today = local_day(now)
    return today - timedelta(days=today.weekday())

def revision_check(value, expected):
    if type(value) is not int or value != expected:
        raise Conflict('投案紀錄已更新，請重新載入')

def validate(command, now):
    if not isinstance(command, dict) or not set(FIELDS).issubset(command):
        raise InvalidAction('投案欄位不完整')
    result = {key: command[key] for key in FIELDS}
    for key, limit in (('title',200),('contact',200),('note',2000)):
        value = result[key]
        if not isinstance(value,str) or len(value)>limit or (key=='title' and not value.strip()):
            raise InvalidAction('投案欄位格式或長度不符限制')
        result[key] = value.strip()
    if result['stage'] not in STAGES:
        raise InvalidAction('不支援的投案階段')
    url = result['url']
    if url is not None:
        try:
            parsed = urlsplit(url)
            valid = (isinstance(url,str) and len(url)<=2048 and not any(c.isspace() for c in url)
                     and parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password)
            parsed.port
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise InvalidAction('原文連結需為 HTTPS 網址')
    try:
        applied = date.fromisoformat(result['applied_on'])
        follow = date.fromisoformat(result['follow_up_on']) if result['follow_up_on'] is not None else None
        if applied.isoformat()!=result['applied_on'] or (follow and follow.isoformat()!=result['follow_up_on']):
            raise ValueError()
        if applied>local_day(now) or (follow and follow<applied):
            raise ValueError()
    except (TypeError,ValueError):
        raise InvalidAction('投案日期不可在未來，跟進日期不可早於投案日期') from None
    return result
