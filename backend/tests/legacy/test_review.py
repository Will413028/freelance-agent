import unittest
from datetime import datetime, timezone
import freelance.legacy.review as review
import freelance.modules.notifications.digest as digest
from fixtures.domain import job, legacy_proposal


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.store = review.ReviewStore()
        self.item = legacy_proposal(self.store, self.store.ingest(job()))

    def test_duplicate_keeps_review_and_one_record(self):
        self.store.review(self.item["id"], "skip", 1, reason="不適合")
        again = self.store.ingest(job())
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(again["review_status"], "skipped")
        self.assertEqual(again["skip_reason"], "不適合")

    def test_edit_invalidates_approval_and_stale_edit_rejected(self):
        self.store.review(self.item["id"], "approve", 1)
        changed = self.store.review(self.item["id"], "edit", 1, text="New proposal")
        self.assertEqual(changed["review_status"], "draft")
        self.assertEqual(changed["version"], 2)
        with self.assertRaises(review.Conflict):
            self.store.review(self.item["id"], "approve", 1)

    def test_listing_update_invalidates_approval(self):
        self.store.review(self.item["id"], "approve", 1)
        changed = self.store.ingest(job(weekly_hours=40))
        self.assertEqual(changed["review_status"], "draft")
        self.assertEqual(changed["evaluation"]["status"], "excluded")

    def test_unknown_cannot_approve_and_no_fake_send(self):
        item = self.store.ingest(job(external_id="102", taiwan_eligible=None))
        with self.assertRaises(review.InvalidAction):
            self.store.review(item["id"], "approve", 1)
        with self.assertRaises(review.InvalidAction):
            self.store.review(self.item["id"], "send", 1)

    def test_outward_mutation_cannot_change_store(self):
        self.item["review_status"] = "sent"
        self.assertEqual(self.store.list()[0]["review_status"], "draft")

    def test_skip_requires_reason(self):
        with self.assertRaises(review.InvalidAction):
            self.store.review(self.item["id"], "skip", 1)

    def test_notification_identity_does_not_replace_manual_draft(self):
        item = self.store.ingest(job(receipt_id='mail1:case'))
        edited = self.store.review(item['id'], 'edit', item['version'], text='Keep this draft')
        newer = self.store.ingest(job(receipt_id='mail2:case'))
        self.assertEqual((newer['proposal'], newer['version']), ('Keep this draft', edited['version']))

    def test_delayed_notification_does_not_regress_current_listing(self):
        item = self.store.ingest(job(receipt_id='new:case', received_at='2026-09-17T10:00:00Z', title='Current agent'))
        self.store.review(item['id'], 'edit', item['version'], text='Current proposal')
        stale = self.store.ingest(job(receipt_id='old:case', received_at='2026-09-17T09:00:00Z', title='Old agent'))
        self.assertEqual(stale['job']['title'], 'Current agent')
        self.assertEqual(stale['proposal'], 'Current proposal')

    def test_new_receipt_retains_manual_draft_and_skip(self):
        original = self.store.ingest(job(received_at="2026-09-17T07:00:00Z", evidence_ref="mail1"))
        edited = self.store.review(original["id"], "edit", original["version"], text="My manually edited proposal")
        self.store.review(edited["id"], "skip", edited["version"], reason="等待下季")
        latest = self.store.ingest(job(received_at="2026-09-17T09:00:00Z", evidence_ref="mail2"))
        self.assertEqual(latest["proposal"], "My manually edited proposal")
        self.assertEqual(latest["review_status"], "skipped")
        self.assertEqual(latest["skip_reason"], "等待下季")
        self.assertEqual(latest["version"], edited["version"])

    def test_expired_listing_removed_from_digest_and_approval_invalidated(self):
        clock = [datetime(2026, 9, 17, 7, tzinfo=timezone.utc)]
        store = review.ReviewStore(clock=lambda: clock[0])
        item = store.ingest(job(title="AI agent expiring project", deadline="2026-09-17T08:00:00Z"))
        legacy_proposal(store, item)
        store.review(item["id"], "approve", 1)
        clock[0] = datetime(2026, 9, 17, 9, tzinfo=timezone.utc)
        items = store.list()
        self.assertEqual(items[0]["evaluation"]["status"], "excluded")
        self.assertIsNone(items[0]["approved_hash"])
        self.assertNotIn("expiring project", digest.render(items, {}))

    def test_listing_update_preserves_skip_until_manual_edit(self):
        self.store.review(self.item['id'], 'skip', 1, reason='Not interested in client')
        updated = self.store.ingest(job(budget_max=9000))
        self.assertEqual(updated['version'], 2)
        self.assertEqual(updated['review_status'], 'skipped')
        self.assertEqual(updated['skip_reason'], 'Not interested in client')
        self.assertNotIn('<article', digest.render(self.store.list(), {}))
        reopened = self.store.review(self.item['id'], 'edit', 2, text='Reconsidered draft')
        self.assertEqual(reopened['review_status'], 'draft')
        self.assertIn('<article', digest.render(self.store.list(), {}))


if __name__ == "__main__":
    unittest.main()
