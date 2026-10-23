"""Ordering of normalized notifications outside versioned mail intake."""
from datetime import datetime

def older_notification(incoming, current):
    """Compare receipt times only for normalized notifications with known times."""
    if not incoming.get('receipt_id') or not current.get('receipt_id'):
        return False
    try:
        new = datetime.fromisoformat(incoming['received_at'].replace('Z', '+00:00'))
        old = datetime.fromisoformat(current['received_at'].replace('Z', '+00:00'))
        return new.tzinfo is not None and old.tzinfo is not None and new < old
    except (KeyError, AttributeError, TypeError, ValueError):
        return False
