"""Bounded owner-only runtime JSON, never exposed by public DTOs."""
import json
import os
import stat


def read_private_json(path):
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    with os.fdopen(fd,'rb') as source:
        info=os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>16384:
            raise ValueError('Private runtime configuration unavailable')
        result=json.loads(source.read(16385))
    if not isinstance(result,dict):raise ValueError('Private runtime configuration unavailable')
    return result
