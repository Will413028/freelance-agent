"""Retired background drafting entry point; never reads data or calls a model."""
import json


def main(argv=None):
    print(json.dumps({'status': 'retired',
                      'reason': 'Discovery no longer starts background proposals; disable the AI timer.'}))
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
