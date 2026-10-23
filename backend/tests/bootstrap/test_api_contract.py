from fixtures.paths import ROOT
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from freelance.bootstrap.http import create_app
from freelance.bootstrap.contracts import Dashboard
from freelance.bootstrap.store import SQLiteStore
from fixtures.domain import job


class ContractTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = SQLiteStore(Path(directory.name) / 'test.db')
        self.store.migrate()
        self.store.ingest(job())
        self.app = create_app(self.store, mode='sqlite')
        self.client = TestClient(self.app, base_url='http://127.0.0.1:8327', raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.headers = {'Origin': 'http://127.0.0.1:3327'}

    def test_dashboard_and_candidate_are_validated_contracts(self):
        response = self.client.get('/dashboard')
        self.assertEqual(response.status_code, 200)
        dashboard = Dashboard.model_validate(response.json())
        self.assertTrue(dashboard.items[0].candidate)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        item = response.json()['items'][0]
        body = {'versions': {member['id']: member['token'] for member in item['members']}, 'feedback': 'skipped'}
        self.assertEqual(self.client.post('/feedback/' + item['id'], json=body, headers=self.headers).status_code, 200)
        self.assertFalse(self.client.get('/dashboard').json()['items'][0]['candidate'])
        self.assertEqual(self.client.post('/feedback/' + item['id'], json=body, headers=self.headers).status_code, 409)

    def test_single_opportunity_preserves_group_and_avoids_operations(self):
        item = self.client.get('/dashboard').json()['items'][0]
        with patch.object(self.store, 'operations', side_effect=AssertionError('unneeded operations')):
            for member in item['member_ids']:
                response = self.client.get('/opportunities/' + member)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), item)
        self.assertEqual(self.client.get('/opportunities/' + '0' * 64).status_code, 404)

    def test_dashboard_preserves_structured_location_evidence(self):
        for evidence in ('Taiwan', ['Taiwan', 'Japan'],
                         {'@type': 'Place', 'address': {'addressCountry': 'TW'}},
                         [{'@type': 'Country', 'name': 'Taiwan'}], None):
            with self.subTest(evidence=evidence):
                self.store.ingest(job() | {'location_evidence': evidence})
                response = self.client.get('/dashboard')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['items'][0]['job']['location_evidence'], evidence)

    def test_strict_commands_reject_coercion_extra_fields_and_oversized_chunks(self):
        settings = self.store.preferences()['settings']
        for body in ({'revision': True, 'settings': settings}, {'revision': '0', 'settings': settings},
                     {'revision': 0, 'settings': settings | {'max_weekly_hours': True}},
                     {'revision': 0, 'settings': settings, 'send': True}):
            self.assertEqual(self.client.post('/preferences', json=body, headers=self.headers).status_code, 400)
        self.assertEqual(self.store.preferences()['revision'], 0)
        large = self.client.post('/preferences', content=iter([b'{' + b' ' * 40000, b' ' * 40000 + b'}']),
                                 headers=self.headers | {'Content-Type': 'application/json'})
        self.assertEqual(large.status_code, 413)

    def test_origin_host_and_exception_details_are_not_exposed(self):
        self.assertEqual(self.client.get('/dashboard', headers={'Host': 'evil.example'}).status_code, 403)
        self.assertEqual(self.client.post('/preferences', json={}, headers={'Origin': 'https://evil.example'}).status_code, 403)
        with patch.object(self.store, 'list', side_effect=RuntimeError('private body TOKEN')):
            response = self.client.get('/dashboard')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('TOKEN', response.text)

    def test_invalid_response_is_rejected_instead_of_leaking_internal_fields(self):
        with patch('freelance.bootstrap.http.public_item', return_value={'proposal': 'PRIVATE'}):
            response = self.client.get('/dashboard')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('PRIVATE', response.text)

    def test_exported_schema_matches_running_app_and_explicit_workbench_routes(self):
        path = ROOT / 'contracts/openapi.json'
        self.assertEqual(json.loads(path.read_text()), self.app.openapi())
        self.assertEqual(set(self.app.openapi()['paths']), {'/dashboard', '/opportunities/{key}', '/digest', '/preferences', '/feedback/{key}',
            '/applications','/applications/summary','/applications/{key}','/applications/{key}/party',
            '/clients','/clients/{key}','/clients/{key}/archive','/clients/{key}/contacts',
            '/contacts','/contacts/{key}','/contacts/{key}/archive',
            '/proposal-templates','/proposal-templates/preview','/proposal-templates/{key}','/proposal-templates/{key}/archive',
            '/proposals','/proposals/{key}','/proposals/{key}/versions','/proposals/{key}/template','/proposals/{key}/archive',
            '/submission-capabilities','/submissions','/submissions/{key}','/submissions/{key}/approve',
            '/submissions/{key}/dispatch','/submissions/{key}/cancel','/submissions/{key}/reconcile'})

    def test_demo_uses_same_rules_without_runtime_files_or_external_calls(self):
        with patch('freelance.platform.sqlite.Database._validate', side_effect=AssertionError('runtime DB forbidden')), \
             patch('socket.create_connection', side_effect=AssertionError('external I/O forbidden')):
            client = TestClient(create_app(), base_url='http://127.0.0.1:8327')
            with client:
                response = client.get('/dashboard')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['mode'], 'demo')
