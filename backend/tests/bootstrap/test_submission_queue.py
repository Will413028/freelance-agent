"""On-demand tasks persist independently of business attempts."""
from pathlib import Path
import tempfile
import unittest
from freelance.bootstrap.queue import build_queue,register_submission_task


class SubmissionQueueTests(unittest.TestCase):
    def test_restart_reads_stable_task_payload_without_automatic_retry(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'queue.sqlite';effects=[]
            queue,_=build_queue(path,lambda day:None)
            task=register_submission_task(queue,effects.append)
            task({'schema_version':1,'intent_id':'synthetic'})
            restarted,_=build_queue(path,lambda day:None)
            register_submission_task(restarted,effects.append)
            persisted=restarted.dequeue()
            self.assertEqual(persisted.retries,0)
            restarted.execute(persisted)
            self.assertEqual(effects,['synthetic'])
            self.assertIsNone(restarted.dequeue())

    def test_unknown_payload_version_no_dispatch_and_old_queue_isolated(self):
        with tempfile.TemporaryDirectory() as root:
            calls=[];queue,_=build_queue(Path(root)/'new.sqlite',lambda day:None)
            task=register_submission_task(queue,calls.append)
            task({'schema_version':2,'intent_id':'synthetic'})
            queue.execute(queue.dequeue());self.assertEqual(calls,[])
            task({'schema_version':1,'intent_id':'pending'})
            old,_=build_queue(Path(root)/'rollback.sqlite',lambda day:None)
            self.assertIsNone(old.dequeue())
            self.assertEqual(queue.pending_count(),1)
