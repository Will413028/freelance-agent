"""Enforce feature ownership, including relative and aliased imports."""
import ast
from importlib.util import resolve_name
from pathlib import Path
import sys

FRAMEWORKS = {'fastapi', 'pydantic', 'uvicorn', 'huey', 'sqlite3', 'sqlalchemy'}
# 依賴方向：這些模組被其他模組使用，自己不引用任何其他業務模組（含 public），否則形成反向依賴
LEAF_MODULES = {'preferences'}

def violations(root):
    errors = []
    for path in sorted(root.rglob('*.py')):
        parts = path.relative_to(root).with_suffix('').parts
        owner = parts[1] if parts[0] == 'modules' else None
        domain = owner and parts[-1] in ('domain', 'rules', 'ranking')
        package = 'freelance.' + '.'.join(parts[:-1])
        for node in ast.walk(ast.parse(path.read_text())):
            if (parts[0] == 'platform' and isinstance(node, ast.Constant)
                    and isinstance(node.value, str) and node.value in ('item', 'snapshot', 'result')):
                errors.append(f'{path.relative_to(root)}:{node.lineno}: platform interprets product JSON field: {node.value}')
            if (owner == 'collection' and parts[-1] != 'store'
                    and isinstance(node, ast.Attribute)
                    and node.attr in ('_connect', 'execute', 'executemany', 'executescript')):
                errors.append(f'{path.relative_to(root)}:{node.lineno}: connector accesses raw storage: {node.attr}')
            if isinstance(node, ast.Import):
                targets = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = resolve_name('.' * node.level + (node.module or ''), package) if node.level else (node.module or '')
                targets = [base + '.' + a.name for a in node.names]
            else:
                continue
            for target in targets:
                p = target.split('.')
                reason = None
                if domain and p[0] in FRAMEWORKS:
                    reason = 'domain imports framework'
                if domain and p[:2] == ['freelance', 'platform'] and p[2:3] != ['errors']:
                    reason = 'domain imports infrastructure'
                if owner and p[:2] == ['freelance', 'modules'] and p[2] != owner and p[3:4] != ['public']:
                    reason = 'cross-module internal import'
                if owner in LEAF_MODULES and p[:2] == ['freelance', 'modules'] and p[2] != owner:
                    reason = 'leaf module imports another module'
                if owner and p[:2] in (['freelance', 'bootstrap'], ['freelance', 'legacy']):
                    reason = 'feature imports composition/history'
                if parts[0] == 'platform' and p[:2] in (['freelance', 'modules'], ['freelance', 'bootstrap'], ['freelance', 'legacy']):
                    reason = 'platform imports business'
                if reason:
                    errors.append(f'{path.relative_to(root)}:{node.lineno}: {reason}: {target}')
    return errors

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1] / 'backend/src/freelance'
    errors = violations(root)
    print('\n'.join(errors) if errors else 'PASS Python module boundaries')
    sys.exit(bool(errors))
