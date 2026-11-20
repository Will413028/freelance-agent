#!/usr/bin/env bash
# Plan step 11: references to the old system stay within allowed-residue.md. A step 11 record since plan D27 (2026-11-20); no longer in `pnpm check`
# It used to run in `pnpm check` (locally and in CI), where it blocked "golden" twice.
# git grep lists tracked files only (the same set rg sees); a new file counts once it is added.
# Usage: check-residue.sh [repo root]   (default: this file's repository)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="${1:-$(git -C "$here" rev-parse --show-toplevel)}"
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
# git grep exits 1 when nothing matches, which is a pass.
git -C "$root" grep -l -E "@/platform/py/|golden|@/db/d1|@/db/client|workflow|vercel|sqliteTable|D1_|oci-a1" >"$list" || [[ $? -eq 1 ]]
python3 -I "$here/check_inventory.py" --residue "$list"
