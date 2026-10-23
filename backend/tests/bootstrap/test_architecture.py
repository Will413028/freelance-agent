"""Import boundary gate with mutations proving forbidden dependencies fail."""
import ast
from pathlib import Path
import unittest
import sqlite3
import tempfile
import importlib.util
import re
from datetime import datetime, timezone
from freelance.bootstrap.store import SQLiteStore

from fixtures.paths import ROOT
PACKAGE = ROOT / 'backend/src/freelance'
spec = importlib.util.spec_from_file_location('boundaries', ROOT / 'scripts/check_boundaries.py')
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)


class ArchitectureTests(unittest.TestCase):
    def test_collection_adapters_do_not_open_connections_or_execute_sql(self):
        for path in (PACKAGE / 'modules/collection').glob('*.py'):
            if path.name == 'store.py':
                continue
            tree = ast.parse(path.read_text())
            forbidden = [node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
                         and node.attr in ('_connect', 'execute', 'executemany', 'executescript')]
            self.assertEqual(forbidden, [], str(path))
    def test_notification_and_history_queries_can_read_while_a_writer_is_active(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteStore(Path(directory) / 'cases.db')
            store.migrate()
            now = datetime(2026, 9, 28, 1, tzinfo=timezone.utc)
            intent = store.create_digest('2026-09-28', 'owner@example.test', now)
            store.claim_daily_run('2026-09-28', 'owner@example.test', now)
            blocker = sqlite3.connect(store.path)
            try:
                blocker.execute('BEGIN IMMEDIATE')
                self.assertEqual(store.find_digest('2026-09-28', 'owner@example.test')['id'], intent['id'])
                self.assertEqual(store.get_digest(intent['id'])['status'], 'pending')
                self.assertEqual(store.get_daily_run('2026-09-28', 'owner@example.test')['status'], 'running')
                self.assertEqual(store.tracking_summary()['sources'], {})
            finally:
                blocker.rollback()
                blocker.close()

    def test_domain_and_modules_do_not_depend_on_framework_or_composition(self):
        self.assertEqual(boundaries.violations(PACKAGE), [])

    def test_gate_rejects_dependency_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'modules/discovery/domain.py'
            path.parent.mkdir(parents=True)
            for mutation in ('from fastapi import FastAPI', 'import freelance.bootstrap.api',
                             'from ..collection import store', 'from freelance.modules.collection.store import Collection',
                             'from freelance.legacy import review'):
                path.write_text(mutation)
                self.assertTrue(boundaries.violations(root), mutation)
            path.write_text('from ..preferences.public import empty_tracking')
            self.assertEqual(boundaries.violations(root), [])

    def test_gate_rejects_reverse_dependency_from_leaf_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'modules/preferences/store.py'
            path.parent.mkdir(parents=True)
            for mutation in ('from freelance.modules.discovery.public import DEFAULTS', 'from ..discovery.public import recommendation'):
                path.write_text(mutation)
                self.assertTrue(boundaries.violations(root), mutation)
            path.write_text('from freelance.modules.preferences.domain import empty_tracking')
            self.assertEqual(boundaries.violations(root), [])

    def test_gate_rejects_platform_product_codec_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'platform/sqlite.py'; path.parent.mkdir()
            for mutation in ('json.loads(row["item"])', 'fields = ("snapshot", "result")'):
                path.write_text(mutation)
                self.assertTrue(boundaries.violations(root), mutation)
            path.write_text('return dict(zip(columns, values))')
            self.assertEqual(boundaries.violations(root), [])

    def test_gate_rejects_connector_storage_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'modules/collection/feed.py'; path.parent.mkdir(parents=True)
            for mutation in ('store._connect()', 'conn.execute("SELECT 1")'):
                path.write_text(mutation)
                self.assertTrue(boundaries.violations(root), mutation)
            path.write_text('batch.ingest(job)')
            self.assertEqual(boundaries.violations(root), [])

    def test_query_and_legacy_use_public_data_contracts(self):
        for name in ('modules/discovery/service.py', 'legacy/review_service.py'):
            tree = ast.parse((PACKAGE / name).read_text())
            self.assertFalse(any(isinstance(node, ast.Attribute) and node.attr in
                                 ('execute', 'executemany', 'executescript') for node in ast.walk(tree)))

    def test_frontend_shared_has_no_feature_dependency(self):
        source = ROOT / 'frontend/src/shared'
        self.assertTrue(source.is_dir(), source)
        for path in source.rglob('*.ts'):
            self.assertNotIn('features/', path.read_text())

    def test_frontend_cross_feature_imports_use_public_entry(self):
        source = ROOT / 'frontend/src'
        self.assertTrue((source / 'app').is_dir(), source)
        for path in source.rglob('*'):
            if path.suffix not in ('.ts', '.tsx'):
                continue
            owner = path.relative_to(source).parts[:2]
            for target in re.findall(r"from\s+['\"]([^'\"]+)['\"]", path.read_text()):
                if not target.startswith('.'):
                    continue
                resolved = (path.parent / target).resolve()
                if not resolved.is_relative_to(source):
                    continue
                parts = resolved.relative_to(source).parts
                if parts[:1] == ('features',) and parts[:2] != owner:
                    self.assertTrue(len(parts) == 2 or parts[2:] == ('index',), (path, target))
