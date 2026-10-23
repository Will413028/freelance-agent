import unittest
from unittest.mock import patch
from freelance.modules.collection.intake import preview
from fixtures.mail import message
from fixtures.tasker import listing


class IntakeTests(unittest.TestCase):
    def test_offline_preview_keeps_unknowns_without_proposals(self):
        item, = preview(message(listing()))
        self.assertEqual(item['evaluation']['status'], 'needs_info')
        self.assertEqual(set(item), {'job', 'evaluation'})

    def test_intake_does_not_start_a_model(self):
        with patch('subprocess.run', side_effect=AssertionError('model must not run')):
            self.assertEqual(len(preview(message(listing()))), 1)

    def test_retired_timer_exits_before_accessing_database_or_model(self):
        from freelance.legacy.ai_worker import main
        with patch('builtins.open', side_effect=AssertionError('no runtime data')), \
             patch('subprocess.run', side_effect=AssertionError('no model')), \
             patch('builtins.print'):
            self.assertEqual(main(['--database', '/missing', '--live-generate']), 2)
