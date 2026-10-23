"""Reentrant local-date scheduling; no timer installation or external sender."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TAIPEI = ZoneInfo('Asia/Taipei')


def daily_tick(store, recipient, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('daily_tick requires an aware datetime')
    if not isinstance(recipient, str) or not recipient.strip() or '\n' in recipient or '\r' in recipient:
        raise ValueError('a nonempty recipient is required')
    local = now.astimezone(TAIPEI)
    if local.hour < 9:
        return None
    return store.create_digest(local.date(), recipient.strip(), now)


def dispatch(store, intent_id, sender):
    """Call an explicitly injected sender once. Raised errors are uncertain.

    A process killed after claim leaves `attempted`, which must be reconciled
    manually. There is deliberately no reset/retry path for attempted/unknown.
    The sender receives the persisted snapshot and must raise on any uncertainty.
    """
    if not callable(sender):
        raise TypeError('sender must be explicitly supplied')
    intent = store.claim_digest(intent_id)
    if intent is None:
        return store.get_digest(intent_id)
    try:
        result = sender(intent['snapshot'])
        receipt = result.get('message_id') if isinstance(result, dict) else None
        if not isinstance(receipt, str) or not receipt.strip():
            return store.finish_digest(intent_id, 'unknown')
    except Exception:
        return store.finish_digest(intent_id, 'unknown')
    return store.finish_digest(intent_id, 'sent', receipt=receipt)
