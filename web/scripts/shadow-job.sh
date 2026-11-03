#!/bin/sh
# Daily shadow job on the VM (plan step 4e3); runs inside the shadow container.
#   morning: 08:30 copy of production, kept on the VM only (the D1 shadow is loaded once, at step 4e4,
#            with scripts/import-copy.ts, and accumulates the TS runs from then on).
#   after:   10:30 copy after the Python run; the day's digest replayed from it on the local D1
#            stand-in; the ledger rows the TS run wrote on D1 checked against its snapshot; the D20/D21
#            revocation triggers checked on the TS run's usage.
set -eu
day=$(TZ=Asia/Taipei date +%F)
copies=/shadow/copies reports=/shadow/reports
mkdir -p "$copies" "$reports"
case "${1:-}" in
  morning)
    pnpm exec tsx scripts/snapshot.ts --source /data/freelance-agent.sqlite3 --target "$copies/$day-0830.sqlite3" --retain-days 7
    ;;
  after)
    pnpm exec tsx scripts/snapshot.ts --source /data/freelance-agent.sqlite3 --target "$copies/$day-1030.sqlite3"
    # Each check runs even when an earlier one reports differences; any failing fails the job.
    rc=0
    pnpm exec tsx scripts/replay-digest.ts --start "$copies/$day-0830.sqlite3" --python "$copies/$day-1030.sqlite3" --out "$reports" --day "$day" || rc=$?
    pnpm exec tsx scripts/check-novelty.ts --since "$day" || rc=$?
    pnpm exec tsx scripts/check-storage-triggers.ts --since "$day" || rc=$?
    exit "$rc"
    ;;
  *) echo "usage: shadow-job.sh morning|after" >&2; exit 2 ;;
esac
