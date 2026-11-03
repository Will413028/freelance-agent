#!/bin/sh
# Daily shadow job on the VM (plan step 4e3); runs inside the shadow container.
#   (the 08:30 morning copy fed only the digest replay; removed with it in plan step 10f, D22)
#   after:   10:30 copy after the Python run (kept for a reload); the storage triggers (D20/D21, the
#            projection's read retries, D18's cross-source pairs) checked on the TS run's result. The
#            digest replay and ledger check were removed with the digest (plan step 10f, D22).
set -eu
day=$(TZ=Asia/Taipei date +%F)
copies=/shadow/copies reports=/shadow/reports
mkdir -p "$copies" "$reports"
case "${1:-}" in
  after)
    pnpm exec tsx scripts/snapshot.ts --source /data/freelance-agent.sqlite3 --target "$copies/$day-1030.sqlite3" --retain-days 7
    pnpm exec tsx scripts/check-storage-triggers.ts --since "$day"
    ;;
  *) echo "usage: shadow-job.sh after" >&2; exit 2 ;;
esac
