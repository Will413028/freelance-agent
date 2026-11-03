#!/usr/bin/env bash
# Step 12 rehearsal (plan), one round, on the VM as root:
#   rehearse.sh <round> <rehearsal database id> <copy file name under /var/lib/freelance-shadow/copies>
# Loads the copy into the rehearsal D1, injects the fixed changes, writes D1 back into a fresh copy
# twice, and has the running Python image read and write the result. Prints counts only. It drops and
# reloads that database, so it refuses any database whose name is not freelance-agent-*-test.
set -euo pipefail
N=$1 RID=$2 COPY=$3
set -a; . /etc/freelance-agent/shadow-compose.env; set +a
export SHADOW_IMAGE=${REHEARSAL_IMAGE:?set REHEARSAL_IMAGE to an image that has scripts/write-back.ts}
NAME=$( (set -a; . "$SHADOW_ENV"; set +a
  curl -fsS -H "Authorization: Bearer $D1_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$RID") | jq -r .result.name)
[[ "$NAME" =~ ^freelance-agent-.+-test$ ]] || { echo "refusing: database $RID is named '$NAME', not freelance-agent-*-test" >&2; exit 2; }
# The Python the rollback would start: whatever the worker runs now.
PYIMAGE=$(docker inspect -f '{{.Config.Image}}' freelance-agent-worker-1)
R=(docker compose -f "$SHADOW_CHECKOUT/deploy/compose.shadow.yaml" run --rm -T -e "D1_DATABASE_ID=$RID")
W=/var/lib/freelance-shadow/rehearsal
"${R[@]}" --entrypoint pnpm shadow exec tsx scripts/import-copy.ts --sqlite "/shadow/copies/$COPY" --confirm-drop "$RID" --report "/shadow/rehearsal/import-$N.json" </dev/null | tail -3
"${R[@]}" -v /tmp/inject.mts:/app/web/scripts/rehearsal-inject.mts:ro --entrypoint pnpm shadow exec tsx scripts/rehearsal-inject.mts --confirm "$RID" --expected "/shadow/rehearsal/expected-$N.json" </dev/null
install -m 0600 -o "$APP_UID" -g "$APP_GID" "/var/lib/freelance-shadow/copies/$COPY" "$W/target-$N.sqlite3"
"${R[@]}" --entrypoint pnpm shadow exec tsx scripts/write-back.ts --sqlite "/shadow/rehearsal/target-$N.sqlite3" --report "/shadow/rehearsal/wb-$N.json" </dev/null
"${R[@]}" --entrypoint pnpm shadow exec tsx scripts/write-back.ts --sqlite "/shadow/rehearsal/target-$N.sqlite3" --report "/shadow/rehearsal/wb-$N-again.json" </dev/null | tail -1
docker run --rm --network none --read-only --tmpfs /tmp --user "$APP_UID:$APP_GID" -v "$W/target-$N.sqlite3:/data/target.sqlite3:ro" -v "$W/expected-$N.json:/data/expected.json:ro" \
  -v /tmp/check.py:/check.py:ro --entrypoint python "$PYIMAGE" -I /check.py /data/target.sqlite3 /data/expected.json
