from fixtures.domain import job, legacy_proposal
import unittest
from copy import deepcopy
from datetime import datetime, timezone

import freelance.modules.discovery.domain as domain
from freelance.legacy.proposals import draft






class QualificationTests(unittest.TestCase):
    def evaluate(self, **kw):
        return domain.qualify(job(**kw), now=datetime(2026, 9, 17, tzinfo=timezone.utc))

    def test_low_budget_is_excluded(self):
        self.assertEqual(self.evaluate(budget_min=2000, budget_max=2999)["status"], "excluded")

    def test_unknown_country_never_passes(self):
        result = self.evaluate(taiwan_eligible=None)
        self.assertEqual(result["status"], "needs_info")
        self.assertIn("台灣接案資格", " ".join(result["questions"]))

    def test_over_capacity_and_fulltime_excluded(self):
        self.assertEqual(self.evaluate(weekly_hours=40)["status"], "excluded")
        self.assertEqual(self.evaluate(kind="full_time")["status"], "excluded")

    def test_hourly_not_subject_to_total_budget_floor(self):
        result = self.evaluate(kind="hourly", currency="USD", budget_min=30, budget_max=50)
        self.assertEqual(result["status"], "needs_info")
        self.assertNotIn("低於單案底價", " ".join(result["reasons"]))

    def test_foreign_budget_without_rate_is_unknown(self):
        self.assertEqual(self.evaluate(currency="USD", budget_max=1000)["status"], "needs_info")

    def test_expired_and_incomplete_do_not_pass(self):
        self.assertEqual(self.evaluate(deadline="2026-09-16")["status"], "excluded")
        self.assertEqual(self.evaluate(complete=False)["status"], "needs_info")

    def test_agent_priority_and_portfolio_truth(self):
        agent = self.evaluate()
        backend = self.evaluate(title="Backend API", description="REST API integration")
        self.assertGreater(agent["score"], backend["score"])
        self.assertIn("agent-project", agent["portfolio_ids"])
        proposal = draft(job(title="Fullstack MVP", description="Build membership website", language="zh-TW"),
                                self.evaluate(title="Fullstack MVP", description="Build membership website"))
        self.assertIn("開發中", proposal)
        self.assertIn("測試", proposal)

    def test_unrelated_role_not_recommended(self):
        self.assertEqual(self.evaluate(title="Graphic designer", description="Draw a logo")["status"], "excluded")

    def test_storage_word_does_not_match_rag(self):
        self.assertEqual(self.evaluate(title="Storage unit manager", description="Manage warehouse inventory")["status"], "excluded")

    def test_intraday_expiry_uses_timestamp_not_just_date(self):
        result = domain.qualify(job(deadline="2026-09-17T08:00:00Z"), now=datetime(2026, 9, 17, 10, tzinfo=timezone.utc))
        self.assertEqual(result["status"], "excluded")

    def test_naive_datetime_with_space_is_unknown(self):
        self.assertEqual(self.evaluate(deadline="2026-09-17 08:00:00")["status"], "needs_info")

    def test_invalid_budget_is_not_qualified(self):
        self.assertEqual(self.evaluate(budget_min=9000, budget_max=3000)["status"], "needs_info")


if __name__ == "__main__":
    unittest.main()
