"""Discovery CLI: browse grouped jobs and manage preferences; no network or delivery."""
import argparse
import json
import sqlite3
from freelance.bootstrap.store import SQLiteStore
from freelance.modules.discovery.ranking import is_candidate
from freelance.modules.preferences.domain import FEEDBACK
from freelance.modules.discovery.rules import group_items, public_item
from freelance.legacy.review import Conflict, InvalidAction


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    listing = commands.add_parser('list')
    listing.add_argument('--all', action='store_true', help='include skipped, applied and excluded')
    listing.add_argument('--limit', type=int, default=20)
    commands.add_parser('summary')
    feedback = commands.add_parser('feedback')
    feedback.add_argument('id')
    feedback.add_argument('--versions', required=True, help='JSON mapping member ID to token from list')
    feedback.add_argument('--state', choices=FEEDBACK, required=True)
    preferences = commands.add_parser('preferences')
    preferences.add_argument('--revision', type=int)
    preferences.add_argument('--settings', help='JSON settings; omit both options to read')

    args = parser.parse_args(argv)
    store = SQLiteStore(args.database)
    try:
        if args.command == 'list':
            if not 1 <= args.limit <= 500:
                parser.error('--limit must be 1–500')
            result = [public_item(item) for item in group_items(store.list())
                      if args.all or is_candidate(item)][:args.limit]
        elif args.command == 'summary':
            items = group_items(store.list())
            result = dict(groups=len(items), candidates=sum(is_candidate(item) for item in items),
                          saved=sum(item['tracking']['feedback'] == 'interested' for item in items),
                          sources=store.sources())
        elif args.command == 'preferences':
            if (args.revision is None) != (args.settings is None):
                parser.error('--revision and --settings are required together')
            result = store.preferences() if args.settings is None else store.set_preferences(args.revision, json.loads(args.settings))
        else:
            result = store.feedback(args.id, json.loads(args.versions), args.state)
    except (Conflict, InvalidAction) as exc:
        parser.exit(1, str(exc)+'\n')
    except (OSError, ValueError, KeyError, sqlite3.Error):
        parser.exit(1, 'Unable to access opportunity; check database, migration and id.\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
