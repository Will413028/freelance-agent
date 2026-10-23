from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from freelance.modules.notifications.scheduler import daily_tick

def main():
    import argparse
    import json
    import os
    parser = argparse.ArgumentParser(description='Run one daily tick; persists an intent and NEVER sends')
    parser.add_argument('--recipient', required=True)
    parser.add_argument("--backend", choices=("postgres", "sqlite"), default="postgres")
    parser.add_argument("--database", help="existing SQLite database path")
    args = parser.parse_args()
    dsn = os.environ.get('FREELANCE_DATABASE_URL')
    if args.backend == "postgres" and not dsn:
        parser.error('FREELANCE_DATABASE_URL must be explicitly configured')
    if args.backend == "sqlite" and not args.database:
        parser.error("SQLite requires --database")
    if args.backend == "postgres" and args.database:
        parser.error("--database requires SQLite")
    try:
        if args.backend == "sqlite":
            from freelance.bootstrap.store import SQLiteStore
            store = SQLiteStore(args.database)
        else:
            from freelance.legacy.postgres import PostgresStore
            store = PostgresStore(dsn)
        intent = daily_tick(store, args.recipient)
    except Exception:
        parser.exit(1, 'Daily tick failed; inspect local database and recipient configuration.\n')
    print(json.dumps({'id': intent['id'], 'status': intent['status']} if intent else {'status': 'not_due'}))


if __name__ == "__main__":
    raise SystemExit(main())
