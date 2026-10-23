import unittest

import freelance.modules.collection.tasker as tasker

from fixtures.mail import message

def listing(extra='', description='串接 API 與建立網站。'):
    return f'''<html><style>HIDDEN STYLE</style><script>HIDDEN SCRIPT</script>
    <img src="https://tracking.example/pixel?private=fake">
    <p>2026/09/17 最新案件，限時搶先提案！</p><h2>測試網站</h2>
    <p>$100,000</p><p>台北市</p><h3>需求說明</h3><p>{description}</p>
    <a href="https://www.tasker.com.tw/cases/Ab123?private=fake">查看完整資訊</a>
    <a href="https://www.tasker.com.tw/cases/Ab123">同案件</a>{extra}
    <p>其它需求</p><p>FOOTER MUST NOT SURVIVE</p>
    <a href="https://www.tasker.com.tw/login?private=fake">登入</a></html>'''
