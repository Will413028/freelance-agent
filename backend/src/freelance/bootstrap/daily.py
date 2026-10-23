"""Opt-in daily discovery CLI."""
import argparse
import json
from .settings import DailySettings
from .jobs import execute_daily

def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--key-file', required=True)
    parser.add_argument('--inbox', required=True)
    parser.add_argument('--recipient', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--live-read', action='store_true')
    parser.add_argument('--freelancer-read', action='store_true')
    parser.add_argument('--free-boards', action='store_true')
    parser.add_argument('--linkedin-read', action='store_true')
    parser.add_argument('--cake-read', action='store_true')
    parser.add_argument('--jobbank104-read', action='store_true')
    parser.add_argument('--talent-read', action='store_true')
    parser.add_argument('--sources', nargs='+', help='explicit source IDs; exclusive with legacy source flags')
    parser.add_argument('--sender')
    parser.add_argument('--smtp-config')
    parser.add_argument('--live-send', action='store_true')
    args = parser.parse_args(argv)
    if (args.live_send != bool(args.sender or args.smtp_config)) or (args.sender and args.smtp_config):
        parser.error('Send requires exactly one of --sender or --smtp-config with --live-send')
    if not args.live_read:
        parser.error('--live-read required; no key accessed')
    return DailySettings(**vars(args))

def main(argv=None):
    result = execute_daily(parse_args(argv))
    print(json.dumps(result))
    return 1 if result['status'] in ('failed', 'source_failed') or result.get('run_status') in ('failed','running') or result.get('delivery_error') or result.get('delivery_status') in ('unknown','attempted') else 0

if __name__ == '__main__':
    raise SystemExit(main())
