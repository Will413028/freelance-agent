from fixtures.resend_preview import MID, TARGET, mail
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import freelance.modules.collection.resend_preview as rp
from fixtures.tasker import listing



class ResendPreviewTests(unittest.TestCase):
    def test_forwarded_recipient_parses_without_raw_content(self):
        client=Mock();client.list_received.return_value={'data':[mail()], 'has_more':False};client.get_received.return_value=mail()
        result=rp.preview(client,TARGET)
        self.assertEqual(len(result['items']),1)
        self.assertTrue(result['items'][0]['job']['receipt_id'].startswith('resend:'))
        self.assertNotIn('tracking',json.dumps(result))
        self.assertEqual(result['status'],'preview_only')

    def test_other_sender_never_reads_body(self):
        client=Mock();client.list_received.return_value={'data':[mail(**{'from':'forwarding-noreply@google.com'})], 'has_more':False}
        self.assertEqual(rp.preview(client,TARGET)['body_reads'],0)
        client.get_received.assert_not_called()

    def test_wrong_recipient_or_sender_detail_is_not_imported(self):
        for changes in ({'received_for':['elsewhere@example.com']},{'from':'attacker@example.com'},{'id':'wrong'}):
            client=Mock();client.list_received.return_value={'data':[mail()], 'has_more':False};client.get_received.return_value=mail(**changes)
            result=rp.preview(client,TARGET)
            self.assertEqual(result['items'],[])
            self.assertEqual(len(result['errors']),1)

    def test_cap_and_has_more_are_visible(self):
        client=Mock();client.list_received.return_value={'data':[mail(id=f'{i:08x}-02e9-4d39-ad75-9611e0fcc33c') for i in range(21)], 'has_more':True}
        client.get_received.side_effect=lambda mid:mail(id=mid)
        result=rp.preview(client,TARGET)
        self.assertEqual(result['body_reads'],20)
        self.assertTrue(result['truncated'])
        self.assertFalse(result['complete_scan'])

    def test_duplicate_metadata_does_not_reread(self):
        client=Mock();client.list_received.return_value={'data':[mail(),mail()], 'has_more':False};client.get_received.return_value=mail()
        self.assertEqual(rp.preview(client,TARGET)['body_reads'],1)

    def test_unsupported_template_does_not_expose_body(self):
        client=Mock();client.list_received.return_value={'data':[mail()], 'has_more':False};client.get_received.return_value=mail(html='PRIVATE')
        result=rp.preview(client,TARGET)
        self.assertNotIn('PRIVATE',json.dumps(result))
        self.assertEqual(result['status'],'partial_preview')

    def test_private_key_file_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'key.json';path.write_text(json.dumps({'api_key':'re_synthetic'}));path.chmod(0o600)
            self.assertEqual(rp.read_key(path),'re_synthetic')
            path.chmod(0o644)
            with self.assertRaises(rp.ResendError):rp.read_key(path)
            out=Path(tmp)/'preview.json';rp.write_preview({},out)
            self.assertEqual(out.stat().st_mode&0o777,0o600)
            with self.assertRaises(FileExistsError):rp.write_preview({},out)

    def test_http_fixed_get_bounded_and_unlisted_rejected(self):
        response=Mock();response.status=200;response.read.return_value=json.dumps({'data':[mail()], 'has_more':False}).encode();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        opener=Mock();opener.open.return_value=response
        client=rp.ReceivingClient('re_synthetic',opener=opener,pause=lambda _:None)
        with self.assertRaises(rp.ResendError):client.get_received(MID)
        client.list_received()
        request=opener.open.call_args.args[0]
        self.assertEqual(request.get_method(),'GET')
        self.assertTrue(request.full_url.startswith('https://api.resend.com/emails/receiving?'))
        self.assertEqual(opener.open.call_args.kwargs['timeout'],20)
        response.read.return_value=b'x'*(rp.MAX_BYTES+1)
        with self.assertRaises(rp.ResendError):client.get_received(MID)

    def test_redirect_handler_refuses(self):
        self.assertIsNone(rp.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.example'))

    def test_explicit_retry_requires_opted_in_source_and_valid_id(self):
        response = Mock()
        response.status = 200
        response.read.return_value = json.dumps(mail()).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        client = rp.ReceivingClient('re_synthetic', opener=opener, pause=lambda _: None)
        with self.assertRaises(rp.ResendError):
            client.get_received(MID)
        with self.assertRaises(rp.ResendError):
            client.get_received(MID, retry_source='linkedin')
        with self.assertRaises((rp.ResendError, ValueError)):
            client.get_received('../not-an-id', retry_source='tasker')
        opener.open.assert_not_called()
        self.assertEqual(client.get_received(MID, retry_source='tasker')['id'], MID)
        self.assertEqual(opener.open.call_args.args[0].full_url,
                         rp.ROOT + '/' + MID + '?html_format=cid')

    def test_cli_requires_flag_before_key_read(self):
        from unittest.mock import patch
        from contextlib import redirect_stderr
        with patch.object(rp,'read_key',side_effect=AssertionError('key accessed')), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                rp.main(['--key-file','missing','--recipient',TARGET,'--output','missing.json'])

    def test_transport_rejects_google_confirm_body_even_if_listed(self):
        response=Mock();response.status=200;response.read.return_value=json.dumps({'data':[mail(**{'from':'forwarding-noreply@google.com'})], 'has_more':False}).encode();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        opener=Mock();opener.open.return_value=response
        client=rp.ReceivingClient('re_synthetic',opener=opener,pause=lambda _:None)
        client.list_received()
        with self.assertRaises(rp.ResendError): client.get_received(MID)
        self.assertEqual(opener.open.call_count,1)
