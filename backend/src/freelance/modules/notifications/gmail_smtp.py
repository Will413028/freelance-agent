"""Gmail SMTP over verified TLS using a VM-local application password."""
from hashlib import sha256
import hmac
from freelance.modules.notifications.gmail_send import build_message, write_preview
from freelance.modules.notifications.scheduler import dispatch


from freelance.platform.gmail_smtp import open_client


def deliver(store,intent_id,email,expected_sha256,client_factory):
    intent=store.get_digest(intent_id)
    if intent['status']!='pending':return intent
    raw=build_message(intent['snapshot'],intent_id,email)
    if not isinstance(expected_sha256,str) or not hmac.compare_digest(sha256(raw).hexdigest(),expected_sha256):raise ValueError('Preview hash mismatch')
    client=client_factory()
    try:
        def send(snapshot):
            if build_message(snapshot,intent_id,email)!=raw:raise ValueError('Snapshot changed')
            if client.sendmail(email,[email],raw):raise ValueError('Recipient refused')
            return {'message_id':'smtp-accepted:'+str(intent_id)}
        return dispatch(store,intent_id,send)
    finally:
        try:client.close()
        except Exception:pass
