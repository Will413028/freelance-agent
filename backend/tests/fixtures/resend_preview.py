import io

import json

from pathlib import Path

import tempfile

import unittest

from unittest.mock import Mock

import freelance.modules.collection.resend_preview as rp

from fixtures.tasker import listing

MID='4ef9a417-02e9-4d39-ad75-9611e0fcc33c'

TARGET='test@inbox.resend.app'

def mail(**changes):
    return dict(id=MID,**{'from':'Tasker <deals@tasker.com.tw>'},to=['owner@gmail.com'],received_for=[TARGET],
                created_at='2026-09-18T10:00:00Z',subject='新案件【測試網站】',html=listing(),text=None) | changes
