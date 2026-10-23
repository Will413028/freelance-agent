from unittest.mock import Mock
import unittest
import fixtures.daily_setup as test_daily
from fixtures.daily import NOW
import freelance.modules.notifications.daily as daily

class DailyDeliveryTests(unittest.TestCase):
    setUp = test_daily.DailyTestsFixture.setUp
    tearDown = test_daily.DailyTestsFixture.tearDown
    client = test_daily.DailyTestsFixture.client
    run_daily = test_daily.DailyTestsFixture.run_daily
    def test_daily_delivery_once_and_restart_no_token(self):
        session=Mock()
        session.get.return_value=Mock(status_code=200,content=b'{}',json=lambda:{'emailAddress':'test@example.invalid'})
        session.post.return_value=Mock(status_code=200,content=b'{}',json=lambda:{'id':'accepted'})
        factory=Mock(return_value=session)
        result=self.run_daily(send_session_factory=factory)
        self.assertEqual(result['delivery_status'],'sent')
        self.assertEqual(self.run_daily(send_session_factory=factory)['status'],'already_run')
        session.post.assert_called_once()
        factory.assert_called_once()

    def test_profile_failure_does_not_repeat_automatically(self):
        factory=Mock(side_effect=RuntimeError('private'))
        result=self.run_daily(send_session_factory=factory)
        self.assertEqual(result['delivery_status'],'pending')
        self.assertEqual(result['delivery_error'],'send_preflight_failed')
        self.run_daily(send_session_factory=factory)
        factory.assert_called_once()

    def test_not_due_does_not_load_send_token(self):
        factory=Mock(side_effect=AssertionError('token'))
        result=daily.run_daily(self.store,self.client,recipient='test@example.invalid',output_dir=self.root,now=NOW.replace(hour=0),send_session_factory=factory)
        self.assertEqual(result['status'],'not_due')
        factory.assert_not_called()

    def test_next_day_creates_new_digest_and_sends_once(self):
        session=Mock()
        session.get.return_value=Mock(status_code=200,content=b'{}',json=lambda:{'emailAddress':'test@example.invalid'})
        session.post.return_value=Mock(status_code=200,content=b'{}',json=lambda:{'id':'accepted'})
        factory=Mock(return_value=session)
        first=self.run_daily(send_session_factory=factory)
        second=daily.run_daily(self.store,self.client,recipient='test@example.invalid',output_dir=self.root,now=NOW.replace(day=18),send_session_factory=factory)
        self.assertEqual(second['delivery_status'],'sent')
        self.assertNotEqual(first['intent_id'],second['intent_id'])
        self.assertEqual(session.post.call_count,2)
        self.assertEqual(len(self.calls),2)

    def test_failed_source_still_sends_truthful_status(self):
        import contextlib
        import base64
        from email.parser import BytesParser
        from email import policy
        @contextlib.contextmanager
        def failed_source():
            raise RuntimeError('private')
            yield
        session=Mock()
        session.get.return_value=Mock(status_code=200,content=b'{}',json=lambda:{'emailAddress':'test@example.invalid'})
        session.post.return_value=Mock(status_code=200,content=b'{}',json=lambda:{'id':'accepted'})
        result=daily.run_daily(self.store,failed_source,recipient='test@example.invalid',output_dir=self.root,now=NOW,send_session_factory=lambda:session)
        self.assertEqual(result['status'],'source_failed')
        self.assertEqual(result['delivery_status'],'sent')
        raw=base64.urlsafe_b64decode(session.post.call_args.kwargs['json']['raw'])
        message=BytesParser(policy=policy.default).parsebytes(raw)
        self.assertIn('讀取失敗',message.get_body(preferencelist=('html',)).get_content())
        self.assertNotIn('private',raw.decode())
