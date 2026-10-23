"""Exact proposal SMTP envelope, independent of daily digest delivery."""
import smtplib


class EmailSender:
    def __init__(self,account,client_factory):self.account,self.client_factory=account,client_factory

    def __call__(self,snapshot):
        if (snapshot.get('account')!=self.account or snapshot.get('from')!=self.account
                or snapshot.get('purpose')!='proposal_submission' or snapshot.get('provider')!='email'
                or snapshot.get('environment')!='live'):
            raise ValueError('Email account/envelope mismatch')
        client=self.client_factory()
        try:
            try:refused=client.sendmail(self.account,[snapshot['to']],snapshot['raw_message'].encode('ascii'))
            except smtplib.SMTPRecipientsRefused:refused=True
            if refused:return dict(status='rejected',receipt=dict(kind='smtp_refused'))
            return dict(status='accepted',receipt=dict(kind='smtp_accepted',message_id=snapshot['message_id']))
        finally:
            try:client.close()
            except Exception:pass
