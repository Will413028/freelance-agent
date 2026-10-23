from fixtures.gmail_transport import ROOT, Response, Session, transport, PROFILE
import json
import unittest

from freelance.modules.collection.gmail import QUERY
from freelance.modules.collection.gmail_transport import GmailTransport, GmailTransportError












class GmailTransportTests(unittest.TestCase):
    def test_verified_mailbox_pages_and_full_message_are_confined_to_fixed_routes(self):
        client, session = transport(PROFILE, Response({'messages': [{'id': 'm1'}], 'nextPageToken': 'p2'}),
                                    Response({'messages': [{'id': 'm2'}]}),
                                    Response({'id': 'm2', 'payload': {'mimeType': 'text/plain', 'body': {'data': 'SGk='}}}))
        self.assertEqual(client.list_messages(query=QUERY, page_token=None, max_results=100)['nextPageToken'], 'p2')
        self.assertEqual(client.list_messages(query=QUERY, page_token='p2', max_results=1)['messages'], [{'id': 'm2'}])
        self.assertEqual(client.get_message('m2')['payload']['body']['data'], 'SGk=')
        self.assertEqual(session.calls, [
            (ROOT + '/profile', {'params': None, 'timeout': 20, 'allow_redirects': False}),
            (ROOT + '/messages', {'params': {'q': QUERY, 'maxResults': 100, 'includeSpamTrash': False}, 'timeout': 20, 'allow_redirects': False}),
            (ROOT + '/messages', {'params': {'q': QUERY, 'maxResults': 1, 'includeSpamTrash': False, 'pageToken': 'p2'}, 'timeout': 20, 'allow_redirects': False}),
            (ROOT + '/messages/m2', {'params': {'format': 'full'}, 'timeout': 20, 'allow_redirects': False}),
        ])

    def test_wrong_mailbox_fails_before_listing_and_does_not_leak_address(self):
        client, session = transport(Response({'emailAddress': 'other@example.com'}))
        with self.assertRaises(GmailTransportError) as caught:
            client.list_messages(query=QUERY, page_token=None, max_results=10)
        self.assertNotIn('other@example.com', str(caught.exception))
        self.assertEqual([call[0] for call in session.calls], [ROOT + '/profile'])

    def test_only_listed_ids_can_be_read(self):
        client, session = transport(PROFILE, Response({'messages': [{'id': 'm1'}]}))
        with self.assertRaises(GmailTransportError):
            client.get_message('m1')
        client.list_messages(query=QUERY, page_token=None, max_results=5)
        for bad in ['m2', '../profile', '', None]:
            with self.subTest(bad=bad), self.assertRaises(GmailTransportError):
                client.get_message(bad)
        self.assertEqual(len(session.calls), 2)

    def test_invalid_inputs_never_issue_requests(self):
        for email in ['', ' ', None, 1]:
            with self.subTest(email=email), self.assertRaises(ValueError):
                GmailTransport(Session([]), email)
        client, session = transport()
        for query, token, limit in [('from:anyone', None, 10), (QUERY, '', 10), (QUERY, 7, 10),
                                    (QUERY, None, 0), (QUERY, None, 101), (QUERY, None, True)]:
            with self.subTest(query=query, token=token, limit=limit), self.assertRaises(ValueError):
                client.list_messages(query=query, page_token=token, max_results=limit)
        self.assertEqual(session.calls, [])

    def test_transport_errors_do_not_expose_remote_data_or_follow_redirects(self):
        for reply in [Response({'error': {'message': 'PRIVATE BODY'}}, 302),
                      Response({'error': {'message': 'PRIVATE BODY'}}, 403),
                      RuntimeError('PRIVATE token')]:
            with self.subTest(reply=type(reply).__name__):
                client, session = transport(reply)
                with self.assertRaises(GmailTransportError) as caught:
                    client.list_messages(query=QUERY, page_token=None, max_results=10)
                self.assertNotIn('PRIVATE', str(caught.exception))
                self.assertIsNone(caught.exception.__cause__)
                self.assertFalse(session.calls[0][1]['allow_redirects'])

    def test_malformed_success_and_error_envelope_are_failures(self):
        malformed = [Response({'error': {'message': 'PRIVATE'}}), Response({'messages': 'bad'}),
                     Response({'messages': [{'id': ''}]}), Response({'nextPageToken': 4}),
                     Response({'unexpected': 'value'})]
        for reply in malformed:
            with self.subTest(body=reply.content):
                client, _ = transport(PROFILE, reply)
                with self.assertRaises(GmailTransportError):
                    client.list_messages(query=QUERY, page_token=None, max_results=10)

    def test_empty_page_with_result_estimate_is_valid(self):
        client, _ = transport(PROFILE, Response({'resultSizeEstimate': 0}))
        self.assertEqual(client.list_messages(query=QUERY, page_token=None, max_results=10),
                         {'resultSizeEstimate': 0})

    def test_missing_messages_with_positive_result_count_is_not_empty_success(self):
        client, _ = transport(PROFILE, Response({'resultSizeEstimate': 3}))
        with self.assertRaises(GmailTransportError):
            client.list_messages(query=QUERY, page_token=None, max_results=10)

    def test_full_message_must_match_listed_id_and_have_payload(self):
        for payload in [{'id': 'other', 'payload': {}}, {'id': 'm1'}, {'error': 'PRIVATE'}]:
            with self.subTest(payload=payload):
                client, _ = transport(PROFILE, Response({'messages': [{'id': 'm1'}]}), Response(payload))
                client.list_messages(query=QUERY, page_token=None, max_results=10)
                with self.assertRaises(GmailTransportError):
                    client.get_message('m1')

    def test_oversize_response_is_rejected_before_json_parsing(self):
        class Oversize(Response):
            def __init__(self):
                self.content = b'x' * (2 * 1024 * 1024 + 1)
                self.status_code = 200
                self.parsed = False

            def json(self):
                self.parsed = True
                return {'emailAddress': 'Will@Example.com'}

        reply = Oversize()
        client, _ = transport(reply)
        with self.assertRaises(GmailTransportError):
            client.list_messages(query=QUERY, page_token=None, max_results=10)
        self.assertFalse(reply.parsed)


if __name__ == '__main__':
    unittest.main()
