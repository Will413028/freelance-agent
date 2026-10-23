"""Deterministic contract export, using synthetic data and no runtime settings."""
import argparse
import json
from pathlib import Path
from freelance.bootstrap.http import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    target = args.output
    text = json.dumps(create_app().openapi(), ensure_ascii=False, indent=2, sort_keys=True) + '\n'
    if args.check:
        if not target.exists() or target.read_text() != text:
            parser.exit(1, 'OpenAPI contract is stale; run python -m freelance.bootstrap.export.\n')
    else:
        target.write_text(text)


if __name__ == '__main__':
    main()
