import unittest

from dataclasses import replace

from freelance.modules.collection.linkedin_mail import parse_linkedin, canonical, SENDER

from freelance.modules.collection.mail import MailMessage, MailParseError

from freelance.modules.discovery.domain import qualify

def mail(cards=None):
    cards = cards or 'Freelance Backend API Engineer (Remote)\nExample Co\nSingapore\nFast growing\nView job: https://www.linkedin.com/comm/jobs/view/1234/?otpToken=private&trackingId=private'
    return MailMessage('test', SENDER, 'Example is hiring',
                       'Your job alert for backend in Asia\nNew jobs match your preferences.\n' + cards +
                       '\n---------------------------------------------------------\nSee all jobs on LinkedIn: https://www.linkedin.com/jobs/',
                       False, '2026-09-26T02:00:00+00:00')
