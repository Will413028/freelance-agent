"""Wire providers and storage to the daily application; no CLI semantics."""
from freelance.modules.collection.resend_preview import ReceivingClient, read_key
from freelance.modules.notifications.service import run
from .store import SQLiteStore
from freelance.modules.collection.public import REGISTRY

def execute_daily(args):
    delivery = None
    if args.live_send and args.sender:
        from freelance.modules.notifications.resend_delivery import deliver, DeliveryClient, sender_domain
        try:
            sender_domain(args.sender)
        except ValueError:
            raise ValueError('A custom sending domain is required') from None
        delivery = lambda store, intent: deliver(store, intent, args.recipient, args.sender,
                                                lambda: DeliveryClient(read_key(args.key_file)))
    if args.live_send and args.smtp_config:
        from freelance.modules.notifications.gmail_smtp import deliver as smtp_deliver, open_client
        from freelance.modules.notifications.gmail_send import build_message
        from hashlib import sha256
        def delivery(store, intent):
            snapshot = store.get_digest(intent)['snapshot']
            expected = sha256(build_message(snapshot, intent, args.recipient)).hexdigest()
            return smtp_deliver(store, intent, args.recipient, expected,
                                lambda: open_client(args.smtp_config, args.recipient))
    try:
        selected = args.selected_sources()
        enabled = tuple(source for source in selected if REGISTRY[source].runner == 'resend_sync')
        def receiving():
            return ReceivingClient(read_key(args.key_file), sources=enabled) if enabled else None
        result = run(SQLiteStore(args.database), receiving,
                     inbox=args.inbox, recipient=args.recipient, output_dir=args.output_dir, delivery=delivery,
                     sources=selected)
    except Exception:
        return {'status': 'failed', 'reason': 'daily_processing_failed'}
    return result
