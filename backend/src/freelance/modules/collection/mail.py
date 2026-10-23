"""Offline MIME extraction. Never fetch attachments or fall back to snippets."""
import base64
import binascii
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import getaddresses


class MailParseError(ValueError):
    """Content-free error safe for source status reporting."""


@dataclass(frozen=True)
class MailMessage:
    message_id: str
    sender: str
    subject: str
    body: str
    is_html: bool
    received_at: str


def parse_message(message):
    try:
        payload = message['payload']
        headers = payload.get('headers', [])
        def values(name):
            return [h['value'] for h in headers if h['name'].lower() == name]
        senders = values('from')
        subjects = values('subject')
        if len(senders) != 1 or len(subjects) != 1:
            raise MailParseError('Ambiguous or missing message headers')
        addresses = getaddresses(senders)
        if len(addresses) != 1 or addresses[0][1].count('@') != 1:
            raise MailParseError('Invalid or ambiguous sender')
        timestamp = message.get('internalDate', message.get('internal_date'))
        if isinstance(timestamp, bool) or timestamp is None:
            raise MailParseError('Invalid source timestamp')
        if isinstance(timestamp, (str, int, float)) and str(timestamp).isdigit():
            received = datetime.fromtimestamp(int(timestamp) / 1000, timezone.utc)
        else:
            received = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            if received.tzinfo is None:
                raise MailParseError('Source timestamp requires timezone')
            received = received.astimezone(timezone.utc)
        candidates = []
        def visit(part):
            if part.get('filename'):
                return
            disposition = [h.get('value', '') for h in part.get('headers', []) if h.get('name', '').lower() == 'content-disposition']
            if any(v.lower().startswith('attachment') for v in disposition):
                return
            mime = (part.get('mimeType') or part.get('mime_type') or '').lower()
            if mime.startswith('multipart/'):
                for child in (part.get('parts') or []):
                    visit(child)
            elif mime in ('text/html', 'text/plain'):
                body = part.get('body', {})
                if 'content' in body:
                    content = body['content']
                elif 'data' in body or 'base64_url_content' in body:
                    data = body.get('data') or body.get('base64_url_content')
                    content = base64.b64decode(data + '=' * (-len(data) % 4), altchars=b'-_', validate=True).decode('utf-8')
                else:
                    return
                if isinstance(content, str) and content.strip():
                    candidates.append((mime == 'text/html', content))
        visit(payload)
        if not candidates:
            raise MailParseError('Message has no supported inline body')
        is_html, body = max(candidates, key=lambda item: item[0])
        message_id = message['id']
        if not isinstance(message_id, str) or not message_id:
            raise MailParseError('Missing message identifier')
        return MailMessage(message_id, addresses[0][1], subjects[0], body, is_html, received.isoformat())
    except MailParseError:
        raise
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError, OSError, binascii.Error):
        raise MailParseError('Malformed Gmail message') from None
