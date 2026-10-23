import unittest
import freelance.modules.notifications.digest as digest; import freelance.legacy.review as review
from fixtures.domain import job


class DigestTests(unittest.TestCase):
    def test_all_candidates_and_escaped_untrusted_content(self):
        store = review.ReviewStore()
        for n in range(8):
            store.ingest(job(external_id=str(n), title="AI agent <script>alert(1)</script>"))
        html = digest.render(store.list(), {"gmail": "not_connected"})
        self.assertEqual(html.count('class="opportunity"'), 8)
        self.assertNotIn("<script>", html)
        self.assertIn("尚未接通", html)

    def test_failed_source_is_not_successful_empty_day(self):
        html = digest.render([], {"freelancer": "failed"})
        self.assertIn("失敗", html)
        self.assertNotIn("所有來源正常", html)

    def test_skipped_items_absent(self):
        store = review.ReviewStore()
        item = store.ingest(job(title="AI agent hidden opportunity"))
        store.review(item["id"], "skip", 1, reason="略過")
        self.assertNotIn("hidden opportunity", digest.render(store.list(), {}))

    def test_persistent_preview_does_not_mislabel_real_jobs_as_synthetic(self):
        html=digest.render([], {'tasker':'failed'}, mode='postgres')
        self.assertIn('尚未寄出',html)
        self.assertNotIn('合成案件',html)
        self.assertNotIn('Demo',html)
        self.assertIn('讀取失敗',html)

    def test_sqlite_preview_is_persistent_and_unsent(self):
        html=digest.render([], {}, mode='sqlite')
        self.assertIn('尚未寄出',html)
        self.assertNotIn('合成案件',html)

class OptimizedDigestTests(unittest.TestCase):
    def test_manual_applied_excluded_and_ranking_is_explained(self):
        store=review.ReviewStore(); active=store.ingest(job(external_id='active'))
        applied=store.ingest(job(external_id='applied',title='AI agent already applied'))
        applied['tracking']={'stage':'applied'}
        active['recommendation']={'score':80,'completeness':50,'reasons':['<script>bad</script>']}
        html=digest.render([active,applied],{},mode='sqlite')
        self.assertNotIn('already applied',html)
        self.assertIn('匹配理由',html)
        self.assertIn('TWD 4000–8000',html)
        self.assertIn('10 小時／週',html)
        self.assertNotIn('<script>',html)


class ProposalDigestTests(unittest.TestCase):
    def test_legacy_proposal_and_ai_questions_are_not_in_discovery_digest(self):
        store=review.ReviewStore();item=store.ingest(job())
        item.update(proposal='AI draft <script>bad</script>',draft_method='Antigravity CLI',ai_questions=['Need <scope>?'])
        html=digest.render([item],{},mode='sqlite',email=True)
        self.assertNotIn('AI draft',html)
        self.assertNotIn('Antigravity CLI',html)
        self.assertNotIn('Need &lt;scope&gt;?',html)
        self.assertNotIn('<script>',html)
