import freelance.bootstrap.daily_cli as daily_command

import contextlib

from concurrent.futures import ThreadPoolExecutor

from datetime import datetime, timezone

import io

import json

from pathlib import Path

import tempfile

import unittest

from unittest.mock import patch

from freelance.bootstrap.store import SQLiteStore

import freelance.modules.notifications.daily as daily

from fixtures.gmail import Client, mail

NOW=datetime(2026,9,17,1,tzinfo=timezone.utc)
