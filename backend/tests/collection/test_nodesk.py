import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch

from freelance.modules.collection.nodesk import parse_feed, parse_article, sync
from freelance.bootstrap.store import SQLiteStore

URL = 'https://nodesk.co/remote-jobs/acme-ai-agent/'


def feed(description='AI &ndash; agent &rsquo; work', url=URL):
    date = datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')
    return f'<rss><channel><item><title>AI agent</title><description>{description}</description><link>{url}</link><pubDate>{date}</pubDate></item></channel></rss>'.encode()


def article(**changes):
    data = {'@type': 'JobPosting', 'title': 'AI agent developer',
            'description': '<p>Build an AI agent and API.</p>', 'employmentType': ['CONTRACTOR'],
            'jobLocationType': 'TELECOMMUTE', 'datePosted': '2026-09-26',
            'applicantLocationRequirements': {'@type': 'Country', 'name': 'Anywhere'}} | changes
    return ('<html><script type="application/ld+json">' + json.dumps(data) + '</script></html>').encode()


class NoDeskTests(TestCase):
    def setUp(self):
        tmp = TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.store = SQLiteStore(Path(tmp.name) / 'jobs.sqlite3'); self.store.migrate()

    def job(self, **changes):
        entries, rejected, truncated = parse_feed(feed())
        self.assertEqual((len(entries), rejected, truncated), (1, 0, False))
        return parse_article(article(**changes), entries[0])

    def run_job(self, job, rejected=0):
        return sync(self.store, reader=lambda: {'jobs': [job], 'seen': 1 + rejected,
                                               'rejected_count': rejected, 'truncated': False})

    def test_advertised_feed_repairs_observed_entities_but_rejects_unknown_and_dtd(self):
        self.assertEqual(len(parse_feed(feed())[0]), 1)
        for raw in (feed('&unknown;'), feed().replace(b'<rss>', b'<!DOCTYPE rss><rss>')):
            with self.assertRaises(ValueError): parse_feed(raw)

    def test_canonical_host_is_pinned_and_bad_entries_are_visible(self):
        self.assertEqual(parse_feed(feed(url='https://evil.example/remote-jobs/acme-ai-agent/'))[1], 1)
        with self.assertRaises(ValueError):
            parse_article(article(), {'url': 'https://nodesk.co.evil/remote-jobs/acme-ai-agent/'})

    def test_real_job_metadata_preserves_unknowns_attribution_and_replay(self):
        job = self.job()
        self.assertIsNone(job['taiwan_eligible']); self.assertIsNone(job['weekly_hours'])
        self.assertEqual(job['attribution'], 'NoDesk'); self.assertEqual(job['kind'], 'contract')
        self.assertEqual(self.run_job(job)['jobs'], 1)
        item = self.store.list()[0]
        self.store.review(item['id'], 'edit', item['version'], text='My proposal')
        self.run_job(job)
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(self.store.list()[0]['proposal'], 'My proposal')

    def test_fulltime_wins_over_contract_and_existing_case_is_updated(self):
        self.run_job(self.job())
        job = self.job(employmentType=['FULL_TIME', 'CONTRACTOR'])
        self.assertEqual(job['kind'], 'full_time')
        self.run_job(job)
        self.assertEqual(self.store.list()[0]['evaluation']['status'], 'excluded')

    def test_partial_preserves_valid_job_and_failed_health(self):
        result = self.run_job(self.job(), rejected=1)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(self.store.sources()['nodesk'], 'failed')
        self.assertEqual(len(self.store.list()), 1)

    def test_no_metadata_is_not_zero_jobs_success(self):
        with self.assertRaises(ValueError):
            parse_article(b'<html>Pay or sign in</html>', {'url': URL})

    def test_source_deadline_stops_before_more_page_requests(self):
        from freelance.modules.collection.nodesk import fetch
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        opener = Mock(); opener.open.return_value = response
        with patch('freelance.modules.collection.nodesk.build_opener', return_value=opener), \
             patch('freelance.modules.collection.nodesk.read_body', return_value=feed()), \
             patch('freelance.modules.collection.nodesk.time.monotonic', side_effect=[0, 0, 100]), \
             patch('freelance.modules.collection.nodesk.time.sleep') as pause:
            result = fetch()
        self.assertEqual(result['rejected_count'], 1)
        self.assertEqual(opener.open.call_count, 1)
        pause.assert_not_called()
