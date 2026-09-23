#!/usr/bin/env bash
# Redeploy the race leaderboard/relay container on the Unraid host.
#
# Layout this script assumes (NOT the scp-based race-api layout in
# DEPLOY_CHECKLIST.md sections 1-6 -- confirm which one is actually on the
# box before running):
#   APP_DIR   /mnt/user/appdata/stack/race/app   a git checkout of this repo
#   DATA_DIR  /mnt/user/appdata/stack/race/data  race.db + backups
#   IMAGE     race
#   CONTAINER race, on the external `proxy` network
#
# Usage: race/server/redeploy.sh [--dry-run]
#   --dry-run   print every command this script would run, without running
#               any of them (no git pull, no docker build, no container
#               changes, no network calls).
#
# Per race/CLAUDE.md: never touches Caddy and never restarts/reloads it.
set -euo pipefail

APP_DIR="/mnt/user/appdata/stack/race/app"
DATA_DIR="/mnt/user/appdata/stack/race/data"
SERVER_DIR="$APP_DIR/race/server"
MIGRATE_SCRIPT="$SERVER_DIR/migrate_modes.py"
DB_PATH="$DATA_DIR/race.db"
IMAGE="race"
CONTAINER="race"
NETWORK="proxy"
HEALTH_URL="https://race.finsonly.net/docs"
POLL_TIMEOUT_S=30

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--dry-run]" >&2
      exit 2
      ;;
  esac
done

step() {
  printf '\n==> %s\n' "$1"
}

# Prints the command about to run, then runs it (unless --dry-run).
run() {
  printf '+ %s\n' "$*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: printing commands only, nothing will actually be run."
fi

step "1. Pull latest code in $APP_DIR"
run cd "$APP_DIR"
run git pull

step "2. Back up $DB_PATH"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="$DB_PATH.bak-$TIMESTAMP"
run cp "$DB_PATH" "$BACKUP_PATH"
if [ "$DRY_RUN" -eq 0 ] && [ ! -s "$BACKUP_PATH" ]; then
  echo "Backup copy at $BACKUP_PATH is missing or empty, aborting." >&2
  exit 1
fi
echo "Backup: $BACKUP_PATH"

step "4. Build the new image ($IMAGE) from $SERVER_DIR"
# Building here (ahead of the numbered step 3) so migrate_modes.py, if
# present, runs against the NEW image as the checklist requires.
run docker build -t "$IMAGE" "$SERVER_DIR"

step "3. Run migrate_modes.py against $DB_PATH, if it exists"
if [ -f "$MIGRATE_SCRIPT" ]; then
  echo "Found $MIGRATE_SCRIPT, running it in a throwaway container of the new image."
  run docker run --rm \
    -v "$SERVER_DIR":/migrate:ro \
    -v "$DATA_DIR":/app/data \
    -e RACE_DB=/app/data/race.db \
    "$IMAGE" \
    python /migrate/migrate_modes.py
else
  echo "No $MIGRATE_SCRIPT, skipping migration step."
fi

step "5. Replace the running container"
run docker rm -f "$CONTAINER" || true
run docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  -v "$DATA_DIR:/app/data" \
  -e RACE_DB=/app/data/race.db \
  "$IMAGE"

step "6. Poll $HEALTH_URL (up to ${POLL_TIMEOUT_S}s, tolerating 502 during boot)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ curl -sS -o /dev/null -w '%{http_code}' $HEALTH_URL   (repeated for up to ${POLL_TIMEOUT_S}s)"
  echo "--dry-run: skipping the actual poll."
  exit 0
fi

DEADLINE=$(( $(date +%s) + POLL_TIMEOUT_S ))
STATUS=""
RESULT="FAIL"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATUS="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo "000")"
  echo "  $HEALTH_URL -> $STATUS"
  if [ "$STATUS" = "200" ]; then
    RESULT="PASS"
    break
  fi
  if [ "$STATUS" != "502" ] && [ "$STATUS" != "000" ]; then
    # Something other than "still booting" or "network hiccup" -- no point
    # burning the rest of the timeout retrying the same non-2xx/non-502 code.
    break
  fi
  sleep 2
done

echo "$RESULT"
if [ "$RESULT" != "PASS" ]; then
  exit 1
fi
