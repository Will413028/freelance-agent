from fixtures.mail import encoded, message
import base64
import unittest
import freelance.modules.collection.mail as mail






class MailTests(unittest.TestCase):
    def test_raw_body_timestamp_and_headers(self):
        result = mail.parse_message(message())
        self.assertEqual(result.body, '完整正文')
        self.assertEqual(result.sender, 'deals@tasker.com.tw')
        self.assertEqual(result.received_at, '2026-09-17T00:00:00+00:00')
        self.assertTrue(result.is_html)

    def test_connector_content_and_internal_date(self):
        data = message()
        data['internal_date'] = data.pop('internalDate')
        data['payload']['body'] = {'content': 'Connector 正文'}
        self.assertEqual(mail.parse_message(data).body, 'Connector 正文')

    def test_nested_multipart_prefers_html_ignores_attachments(self):
        data = message()
        data['payload'].update(mimeType='multipart/mixed', body={}, parts=[
            {'mimeType': 'text/html', 'filename': 'attachment.html', 'body': {'data': encoded('ATTACHMENT')}},
            {'mimeType': 'multipart/alternative', 'parts': [
                {'mimeType': 'text/plain', 'body': {'data': encoded('PLAIN')}},
                {'mimeType': 'text/html', 'body': {'data': encoded('<p>HTML</p>')}}]}])
        self.assertEqual(mail.parse_message(data).body, '<p>HTML</p>')

    def test_missing_body_does_not_use_snippet(self):
        data = message()
        data['payload']['body'] = {'attachmentId': 'do-not-fetch'}
        with self.assertRaises(mail.MailParseError):
            mail.parse_message(data)

    def test_rejects_ambiguous_sender_and_bad_timestamp(self):
        for sender in ['deals@tasker.com.tw, attacker@example.org', 'invalid', '"deals@tasker.com.tw" <attacker@example.org>']:
            data = message()
            data['payload']['headers'][0]['value'] = sender
            if sender.startswith('"deals@tasker.com.tw" <'):
                self.assertEqual(mail.parse_message(data).sender, 'attacker@example.org')
            else:
                with self.assertRaises(mail.MailParseError):
                    mail.parse_message(data)
        data = message()
        data['payload']['headers'].append({'name': 'from', 'value': 'deals@tasker.com.tw'})
        with self.assertRaises(mail.MailParseError):
            mail.parse_message(data)
        for timestamp in [None, 'bad', '2026-09-17T00:00:00', True]:
            data = message()
            data['internalDate'] = timestamp
            with self.assertRaises(mail.MailParseError):
                mail.parse_message(data)

    def test_bad_encoding_has_content_free_error(self):
        data = message()
        data['payload']['body'] = {'data': '!PRIVATE!'}
        with self.assertRaises(mail.MailParseError) as result:
            mail.parse_message(data)
        self.assertNotIn('PRIVATE', str(result.exception))

    def test_connector_timezone_converted_to_utc(self):
        data = message()
        data['internalDate'] = '2026-09-17T08:00:00+08:00'
        self.assertEqual(mail.parse_message(data).received_at, '2026-09-17T00:00:00+00:00')

    def test_connector_snake_case_mime_and_null_parts(self):
        data = message()
        data['payload']['mime_type'] = data['payload'].pop('mimeType')
        data['payload']['parts'] = None
        data['payload']['body'] = {'content': 'connector html'}
        self.assertEqual(mail.parse_message(data).body, 'connector html')
        data['payload']['body'] = {'base64_url_content': encoded('encoded connector')}
        self.assertEqual(mail.parse_message(data).body, 'encoded connector')
        data['payload'].update(mime_type='multipart/mixed', body={}, parts=[
            {'mime_type': 'multipart/mixed', 'parts': None},
            {'mime_type': 'text/html', 'body': {'content': 'nested'}}])
        self.assertEqual(mail.parse_message(data).body, 'nested')
