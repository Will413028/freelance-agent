#!/bin/sh
# Daily shadow job on the VM (plan steps 4c/4d); runs inside the shadow container.
#   morning: 08:30 copy of production, loaded into the Neon shadow branch.
#   after:   10:30 copy after the Python run, compared with the shadow branch after the TS run.
set -eu
day=$(TZ=Asia/Taipei date +%F)
copies=/shadow/copies reports=/shadow/reports
mkdir -p "$copies" "$reports"
case "${1:-}" in
  morning)
    pnpm exec tsx scripts/snapshot.ts --source /data/freelance-agent.sqlite3 --target "$copies/$day-0830.sqlite3" --retain-days 7
    pnpm exec tsx scripts/converge.ts --sqlite "$copies/$day-0830.sqlite3" --confirm-drop "$SHADOW_HOST" --report "$reports/converge-$day.json"
    ;;
  after)
    pnpm exec tsx scripts/snapshot.ts --source /data/freelance-agent.sqlite3 --target "$copies/$day-1030.sqlite3"
    pnpm exec tsx scripts/compare.ts --start "$copies/$day-0830.sqlite3" --python "$copies/$day-1030.sqlite3" --out "$reports" --day "$day"
    ;;
  *) echo "usage: shadow-job.sh morning|after" >&2; exit 2 ;;
esac
