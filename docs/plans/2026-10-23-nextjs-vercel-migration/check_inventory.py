#!/usr/bin/env python3
"""Check the migration inventories (plan step 2) and the step-14 residue list.

Checks:
  (a) every row of a Markdown table whose header has a `去向` column starts that
      cell with exactly one known tag followed by `：` and detail; no empty/TBD.
      `改寫` and `只搬資料` must name a step (`步驟 N`); `延後` must cite the
      plan's 延後 section.
  (b) every numbered item under `## 既有缺陷與處置` has `處置：修|接受|隨改寫消失`;
      `修` items must also describe a regression test (`回歸測試`).
  (c) with --residue FILE (output of `rg -n -l ...`), every listed path matches a
      glob in allowed-residue.md's ```globs block.

Exit 0 on pass, 1 on any failure. Standard library only.
"""
import argparse
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_FILES = [HERE / 'inventory-surface.md', HERE / 'inventory-sources.md']
RESIDUE_DOC = HERE / 'allowed-residue.md'
TAGS = ('改寫', '只搬資料', '刪除', '取代', '延後')
TAG_RE = re.compile(r'^(%s)：\s*(\S.*)$' % '|'.join(TAGS))
STEP_RE = re.compile(r'步驟\s*\d+')
DEFECT_HEADING = '## 既有缺陷與處置'
DISPOSITION_RE = re.compile(r'處置：\s*(修|接受|隨改寫消失)')


def split_row(line):
    """Split a Markdown table row on unescaped pipes; drop the outer empties."""
    cells = re.split(r'(?<!\\)\|', line.strip())
    return [c.strip() for c in cells[1:-1]]


def is_separator(cells):
    return bool(cells) and all(re.fullmatch(r':?-{3,}:?', c) for c in cells)


def check_tables(path, errors):
    counts = Counter()
    lines = path.read_text(encoding='utf-8').split('\n')
    i = 0
    tables = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('|') and i + 1 < len(lines) and is_separator(split_row(lines[i + 1])):
            header = split_row(line)
            col = header.index('去向') if '去向' in header else None
            i += 2
            if col is not None:
                tables += 1
            while i < len(lines) and lines[i].startswith('|'):
                if col is not None:
                    cells = split_row(lines[i])
                    where = f'{path.name}:{i + 1}'
                    if len(cells) != len(header):
                        errors.append(f'{where}: {len(cells)} cells, header has {len(header)}')
                    else:
                        check_cell(cells[col], where, counts, errors)
                i += 1
            continue
        i += 1
    if tables == 0:
        errors.append(f'{path.name}: no table with a 去向 column')
    return counts


def check_cell(value, where, counts, errors):
    if not value or value.upper() == 'TBD':
        errors.append(f'{where}: 去向 is empty or TBD')
        return
    m = TAG_RE.match(value)
    if not m:
        errors.append(f'{where}: 去向 lacks a leading tag ({"/".join(TAGS)} + "："): {value[:40]!r}')
        return
    tag, detail = m.groups()
    if 'TBD' in detail:
        errors.append(f'{where}: 去向 detail still contains TBD')
    if tag in ('改寫', '只搬資料') and not STEP_RE.search(detail):
        errors.append(f'{where}: {tag} must name a step (步驟 N)')
    if tag == '延後' and '延後' not in detail:
        errors.append(f'{where}: 延後 must cite the plan\'s 延後 section')
    counts[tag] += 1


def check_defects(path, errors):
    text = path.read_text(encoding='utf-8')
    start = text.find('\n' + DEFECT_HEADING + '\n')
    if start < 0:
        errors.append(f'{path.name}: missing section {DEFECT_HEADING!r}')
        return 0
    body = text[start + len(DEFECT_HEADING) + 2:]
    nxt = re.search(r'^## ', body, re.M)
    body = body[:nxt.start()] if nxt else body
    items = re.split(r'^(?=\d+\. )', body, flags=re.M)
    items = [it for it in items if re.match(r'\d+\. ', it)]
    if not items:
        errors.append(f'{path.name}: {DEFECT_HEADING} has no numbered items')
    for it in items:
        num = it.split('.', 1)[0]
        m = DISPOSITION_RE.search(it)
        if not m:
            errors.append(f'{path.name}: defect {num} lacks 處置：修／接受／隨改寫消失')
        elif m.group(1) == '修' and '回歸測試' not in it:
            errors.append(f'{path.name}: defect {num} is 修 but names no 回歸測試')
    return len(items)


def glob_to_regex(glob):
    out, i = [], 0
    while i < len(glob):
        if glob.startswith('**/', i):
            out.append('(?:.*/)?'); i += 3
        elif glob.startswith('**', i):
            out.append('.*'); i += 2
        elif glob[i] == '*':
            out.append('[^/]*'); i += 1
        elif glob[i] == '?':
            out.append('[^/]'); i += 1
        else:
            out.append(re.escape(glob[i])); i += 1
    return re.compile(''.join(out) + r'\Z')


def load_globs(errors):
    text = RESIDUE_DOC.read_text(encoding='utf-8')
    m = re.search(r'^```globs\n(.*?)^```', text, re.M | re.S)
    if not m:
        errors.append(f'{RESIDUE_DOC.name}: no ```globs block')
        return []
    return [g.strip() for g in m.group(1).splitlines() if g.strip() and not g.startswith('#')]


def check_residue(path, errors):
    globs = load_globs(errors)
    patterns = [glob_to_regex(g) for g in globs]
    allowed = bad = 0
    for raw in Path(path).read_text(encoding='utf-8').splitlines():
        p = raw.strip()
        if not p:
            continue
        p = p[2:] if p.startswith('./') else p
        if any(r.match(p) for r in patterns):
            allowed += 1
        else:
            bad += 1
            errors.append(f'residue not allowed: {p}')
    print(f'residue: {allowed} allowed, {bad} not allowed ({len(globs)} globs)')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--files', nargs='+', type=Path, help='inventory files to check (default: both inventories)')
    ap.add_argument('--residue', type=Path, help='file holding `rg -n -l` output to check against allowed-residue.md')
    args = ap.parse_args()
    errors = []
    files = args.files or DEFAULT_FILES
    for f in files:
        counts = check_tables(f, errors)
        summary = ', '.join(f'{t} {counts[t]}' for t in TAGS)
        print(f'{f.name}: {sum(counts.values())} rows — {summary}')
        if f.name.startswith('inventory-surface'):
            print(f'{f.name}: {check_defects(f, errors)} defects')
    if args.residue:
        check_residue(args.residue, errors)
    for e in errors:
        print('FAIL', e, file=sys.stderr)
    print('FAIL' if errors else 'OK', f'({len(errors)} errors)')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
