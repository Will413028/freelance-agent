#!/usr/bin/env bash
# Plan step 11: fails while anything inventory.md marks deleted still exists.
#   - paths: the 位置 cell of every 機制 row whose 去向 starts with 刪除 or 取代, and every path after
#     「舊檔：」 in a 去向 cell (repo-relative, backticked, starting with web/);
#   - tables: every 資料表 row whose 去向 starts with 刪除 must not be a table of the Postgres schema
#     (web/src/db/pg/schema.ts) or created by a migration (web/drizzle-pg/*.sql).
# Usage: check-deleted.sh [repo root]   (default: this file's repository)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="${1:-$(git -C "$here" rev-parse --show-toplevel)}"
exec python3 -I - "$here/inventory.md" "$root" <<'PY'
import re, sys
from pathlib import Path

inventory, root = Path(sys.argv[1]), Path(sys.argv[2])
lines = inventory.read_text(encoding='utf-8').split('\n')
cells = lambda l: [c.strip() for c in re.split(r'(?<!\\)\|', l.strip())[1:-1]]
paths, tables, section = set(), set(), None
for line in lines:
    if line.startswith('## '):
        section = line[3:]
    if not line.startswith('|') or line.startswith('|---'):
        continue
    row = cells(line)
    if len(row) < 2 or row[-1] == '去向':
        continue
    dest = row[-1]
    gone = dest.startswith(('刪除', '取代'))
    if section == '機制':
        if gone:
            paths.update(p for p in re.findall(r'`([^`]+)`', row[1]) if p.startswith('web/'))
        for tail in re.findall(r'舊檔：(.*)$', dest):
            paths.update(p for p in re.findall(r'`([^`]+)`', tail) if p.startswith('web/'))
    if section and section.startswith('資料表') and dest.startswith('刪除'):
        tables.update(re.findall(r'`([a-z_]+)`', row[0]))

errors = [f'path still exists: {p}' for p in sorted(paths) if (root / p).exists()]
schema = (root / 'web/src/db/pg/schema.ts').read_text(encoding='utf-8')
sql = ''.join(f.read_text(encoding='utf-8') for f in sorted((root / 'web/drizzle-pg').glob('*.sql')))
for t in sorted(tables):
    if re.search(r'pgTable\(\s*"%s"' % t, schema) or re.search(r'CREATE TABLE "%s"' % t, sql):
        errors.append(f'table still in the Postgres schema: {t}')
for e in errors:
    print('FAIL', e, file=sys.stderr)
print(f'checked {len(paths)} paths and {len(tables)} tables:', 'FAIL' if errors else 'OK', f'({len(errors)} errors)')
sys.exit(1 if errors else 0)
PY
