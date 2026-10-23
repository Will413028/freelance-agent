from unittest import TestCase
from unittest.mock import Mock, patch
from importlib import import_module
from freelance.modules.collection import source_catalog


class SourceRegistryTests(TestCase):
    def test_explicit_sources_are_validated_and_do_not_enable_other_sources(self):
        self.assertEqual(source_catalog.enabled_sources(sources=('talent',)), ('talent',))
        for ids in (('missing',), ('guru',), ('talent', 'talent')):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                source_catalog.enabled_sources(sources=ids)

    def test_legacy_flags_keep_the_same_execution_order(self):
        result = source_catalog.enabled_sources(freelancer=True, free_boards=True,
            linkedin=True, cake=True, jobbank104=True, talent=True)
        self.assertEqual(result[:6], ('tasker','linkedin','cake','jobbank104','talent','freelancer'))
        self.assertEqual(len(result), 26)
        self.assertEqual(result[-1], 'chickpt')
        self.assertEqual(source_catalog.enabled_sources(), ('tasker',))

    def test_names_ids_and_runners_share_one_registry(self):
        self.assertEqual(tuple(source_catalog.PLATFORMS), source_catalog.SOURCES)
        for source in source_catalog.enabled_sources(free_boards=True):
            self.assertIsNotNone(source_catalog.REGISTRY[source].runner)

    def test_registered_runners_exist_without_calling_providers(self):
        for spec in source_catalog.REGISTRY.values():
            if spec.runner:
                module = import_module('freelance.modules.collection.' + spec.runner)
                self.assertTrue(callable(getattr(module, spec.function)))

    def test_public_only_selection_does_not_read_mail(self):
        from freelance.modules.collection.service import collect_sources
        with patch('freelance.modules.collection.free_jobs.sync', return_value={'status': 'ok'}) as public:
            with patch('freelance.modules.collection.resend_sync.sync_tasker', side_effect=AssertionError('mail')):
                result = collect_sources(None, Mock(), inbox='synthetic@example.invalid', sources=('remotive',))
        self.assertEqual(set(result), {'status', 'reason', 'remotive'})
        public.assert_called_once()
