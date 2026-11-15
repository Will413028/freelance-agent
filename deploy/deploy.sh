#!/usr/bin/env bash
# Deploys one commit of this repository to the VM (plan step 9). Run as root:
#   /opt/side-income/deploy/deploy.sh <sha | origin branch name>
# 1. checkout the commit (detached), build side-income-web:<short sha>
# 2. run migrate-pg with the NEW image; on failure stop here: APP_IMAGE and the running web are untouched
#    (drizzle applies all pending migrations in one transaction, so a failed one leaves the schema as it was)
# 3. point APP_IMAGE at the new tag, recreate web, wait for its healthcheck
# 4. recreate fails or unhealthy: put APP_IMAGE and the checkout back to the previous ones, recreate web, exit 1
# web and daily share APP_IMAGE, so a rollback moves both. The script runs as it is in the CURRENT
# checkout: a change to deploy.sh itself takes effect from the deploy after the one that ships it.
# Every run needs Will's authorization first.
set -euo pipefail

DOCKER=${DOCKER:-docker}
GIT=${GIT:-git}
ENV_FILE=${ENV_FILE:-/etc/side-income/compose.env}
REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
LOCK=${LOCK:-$ENV_FILE.lock}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180} # seconds; web's healthcheck: start_period 20s, then 3 failures 30s apart
POLL=${POLL:-5}

target=${1:?usage: deploy.sh <sha | origin branch name>}
log() { printf 'deploy: %s\n' "$*" >&2; }
compose() { "$DOCKER" compose --env-file "$ENV_FILE" -f "$REPO/deploy/compose.yaml" "$@"; }
set_image() {
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  sed "s|^APP_IMAGE=.*|APP_IMAGE=$1|" "$ENV_FILE" >"$tmp"
  mv "$tmp" "$ENV_FILE"
}
wait_healthy() {
  local id status=missing tries=0 max=$((HEALTH_TIMEOUT / (POLL > 0 ? POLL : 1)))
  id=$(compose ps -q web)
  while ((tries <= max)); do
    status=$("$DOCKER" inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)
    case $status in
      healthy) log "web healthy"; return 0 ;;
      unhealthy) log "web unhealthy"; return 1 ;;
    esac
    sleep "$POLL"
    tries=$((tries + 1))
  done
  log "web not healthy within ${HEALTH_TIMEOUT}s (last status: $status)"
  return 1
}

cd "$REPO"
exec 9>"$LOCK"
flock -n 9 || { log "another deploy holds $LOCK"; exit 1; }

prev_image=$(sed -n 's/^APP_IMAGE=//p' "$ENV_FILE" | tail -n 1)
prev_commit=$("$GIT" rev-parse HEAD)
[[ $prev_image =~ ^[A-Za-z0-9._/:-]+$ ]] || { log "APP_IMAGE in $ENV_FILE is missing or not a plain image reference"; exit 1; }

"$GIT" fetch --quiet origin
# A branch name means the fetched origin branch, never a stale local one.
if ref=$("$GIT" rev-parse --verify --quiet "refs/remotes/origin/$target^{commit}"); then :; else
  ref=$("$GIT" rev-parse --verify "$target^{commit}") || { log "unknown commit $target"; exit 1; }
fi
compose up -d db # with the current compose.yaml, before the checkout moves
"$GIT" checkout --quiet --detach "$ref"
commit=$("$GIT" rev-parse --short HEAD)
image="side-income-web:$commit"
log "previous $prev_image ($prev_commit), new $image"
restore_checkout() { "$GIT" checkout --quiet --detach "$prev_commit"; }

if ! "$DOCKER" build -f deploy/web.Dockerfile -t "$image" web; then
  log "build failed; nothing changed"; restore_checkout; exit 1
fi
if ! APP_IMAGE=$image compose run --rm daily pnpm exec tsx scripts/migrate-pg.ts; then
  log "migration failed; $prev_image keeps serving"; restore_checkout; exit 1
fi

set_image "$image"
if compose up -d web && wait_healthy; then
  log "deployed $image"
  exit 0
fi

log "rolling back to $prev_image"
set_image "$prev_image"
restore_checkout
if compose up -d web && wait_healthy; then
  log "rolled back to $prev_image"
else
  log "ROLLBACK UNHEALTHY: $prev_image is not healthy either; check compose ps and logs"
fi
exit 1
