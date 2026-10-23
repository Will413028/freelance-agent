"""Synthetic adapters: exact envelopes, fixed endpoints and conservative receipts."""
import unittest
from unittest.mock import Mock
from freelance.modules.submissions.email import EmailSender
from freelance.modules.submissions.freelancer import FreelancerSender


class TransportTests(unittest.TestCase):
    def test_email_exact_wire_and_refusal_close(self):
        client=Mock();client.sendmail.return_value={}
        envelope=dict(account='sender@example.test',provider='email',environment='live',purpose='proposal_submission',
            **{'from':'sender@example.test','to':'recipient@example.test'},raw_message='exact\r\n',message_id='<synthetic>')
        sender=EmailSender('sender@example.test',lambda:client)
        self.assertEqual(sender(envelope)['status'],'accepted')
        client.sendmail.assert_called_once_with('sender@example.test',['recipient@example.test'],b'exact\r\n')
        client.close.assert_called_once()
        client.sendmail.return_value={'recipient@example.test':(550,b'private error')}
        self.assertEqual(sender(envelope)['status'],'rejected')

    def test_email_wrong_account_never_connects(self):
        factory=Mock()
        with self.assertRaises(ValueError):EmailSender('other@example.test',factory)(dict(account='sender@example.test'))
        factory.assert_not_called()

    def envelope(self):
        return dict(purpose='proposal_submission',provider='freelancer',environment='sandbox',account='2',project_id=1,bidder_id=2,
                    currency_id=3,currency_code='USD',amount=100,period=5,milestone_percentage=100,body='synthetic bid')

    def request(self,method,path,payload=None):
        self.calls.append((method,path,payload))
        if path=='/api/users/0.1/self/':return {'id':2}
        if path=='/api/projects/0.1/projects/1/':return {'id':1,'status':'active','currency':{'id':3,'code':'USD'}}
        return {'id':9,'project_id':1,'bidder_id':2}

    def test_freelancer_official_paths_fields_and_receipt(self):
        self.calls=[]
        sender=FreelancerSender('2','sandbox',self.request)
        result=sender(self.envelope())
        self.assertEqual(result['receipt']['bid_id'],9)
        self.assertEqual(self.calls[-1],('POST','/api/projects/0.1/bids/',dict(project_id=1,bidder_id=2,amount=100,period=5,milestone_percentage=100,description='synthetic bid')))

    def test_freelancer_wrong_account_currency_or_environment_no_post(self):
        for field,value in (('account','3'),('environment','live'),('currency_id',9)):
            self.calls=[];envelope=self.envelope();envelope[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):FreelancerSender('2','sandbox',self.request)(envelope)
            self.assertFalse(any(c[0]=='POST' for c in self.calls))

    def test_freelancer_missing_or_mismatched_receipt_stays_unknown(self):
        self.calls=[]
        def request(method,path,payload=None):
            if method=='POST':return {'id':9,'project_id':999,'bidder_id':2}
            return self.request(method,path,payload)
        self.assertEqual(FreelancerSender('2','sandbox',request)(self.envelope())['status'],'unknown')

    def test_lookup_verifies_exact_bid_before_provider_reconciliation(self):
        envelope=self.envelope();calls=[]
        def request(method,path,payload=None):
            calls.append((method,path))
            if path=='/api/users/0.1/self/':return {'id':2}
            return {'bids':[dict(id=9,project_id=1,bidder_id=2,description='synthetic bid',amount=100,period=5,milestone_percentage=100)]}
        receipt=FreelancerSender('2','sandbox',request).lookup(envelope,9)
        self.assertEqual(receipt['bid_id'],9)
        self.assertTrue(all(method=='GET' for method,path in calls))
        with self.assertRaises(ValueError):FreelancerSender('2','sandbox',request).lookup(dict(envelope,body='different'),9)
