"""Offline notification-to-review preview. No storage, mailbox or delivery calls."""
import json
import sys
from freelance.modules.discovery.public import qualify
from freelance.modules.collection.tasker import parse_tasker


def preview(message):
    results = []
    for job in parse_tasker(message):
        evaluation = qualify(job)
        results.append({'job':job, 'evaluation':evaluation})
    return results


def main():
    # Default CLI is intentionally offline. Real provider integration is explicit
    # at the Python API boundary while CLI tool/credit policy is being verified.
    try:
        content = sys.stdin.read(1_000_001)
        if len(content)>1_000_000:
            raise ValueError()
        result = preview(json.loads(content))
    except (ValueError, TypeError):
        print('Invalid or unsupported notification; no action taken.', file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
