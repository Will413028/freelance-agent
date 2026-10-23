"""Verified Gmail TLS connection; no message, purpose or delivery policy."""
import json
import os
import re
import smtplib
import ssl
import stat

def open_client(path,email):
    client=None
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as f:
            info=os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>4096:raise ValueError()
            config=json.loads(f.read(4097))
        password=config['app_password']
        if config['email']!=email or not re.fullmatch(r'[A-Za-z0-9._+-]+@gmail\.com',email) or not isinstance(password,str) or not re.fullmatch('[a-z]{16}',password):raise ValueError()
        client=smtplib.SMTP_SSL('smtp.gmail.com',465,timeout=20,context=ssl.create_default_context())
        client.login(email,password)
        return client
    except Exception:
        if client is not None:
            try:client.close()
            except Exception:pass
        raise ValueError('Gmail SMTP configuration or authentication unavailable') from None
