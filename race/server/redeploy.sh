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
# Order: pull -> check race.db -> back up race.db -> migrate -> build -> swap container -> poll.
#
# The image is built from the checkout ROOT with -f race/server/Dockerfile, so it carries a
# snapshot of race/courses; the container also mounts the checkout's race/courses read-only over
# that snapshot, so a `git pull` alone updates the course list (the server re-reads index.json
# whenever a vote opens).
#
# Usage: race/server/redeploy.sh [--dry-run] [--allow-empty-db]
#   --dry-run          print every command this script would run, without running
#                      any of them (no git pull, no docker build, no container
#                      changes, no network calls).
#   --allow-empty-db   deploy even though the 2a check below flagged race.db as
#                      suspect (missing with a prior deploy recorded, bad schema, or
#                      a running container pointed at the wrong RACE_DB). Zero runs
#                      alone is NOT suspect -- a genuinely new board has zero runs
#                      and 2a lets that through without this flag.
#
# DATA_DIR can be overridden with RACE_DATA_DIR=... for a box laid out differently.
# ALLOW_EMPTY_DB can also be set via env: RACE_ALLOW_EMPTY_DB=1.
#
# Per race/CLAUDE.md: never touches Caddy and never restarts/reloads it.
set -euo pipefail

APP_DIR="/mnt/user/appdata/stack/race/app"
DATA_DIR="${RACE_DATA_DIR:-/mnt/user/appdata/stack/race/data}"
SERVER_DIR="$APP_DIR/race/server"
COURSES_DIR="$APP_DIR/race/courses"
RUNWAYS_DIR="$APP_DIR/race/runways"
MIGRATE_SCRIPT="$SERVER_DIR/migrate_modes.py"
DB_PATH="$DATA_DIR/race.db"
STATE_FILE="$DATA_DIR/.deployed_sha"
IMAGE="race"
CONTAINER="race"
PY_IMAGE="python:3.12-slim"          # same base the Dockerfile builds on
NETWORK="proxy"
HEALTH_URL="https://race.finsonly.net/health"
POLL_TIMEOUT_S=30

DRY_RUN=0
ALLOW_EMPTY_DB=0
if [ "${RACE_ALLOW_EMPTY_DB:-0}" = "1" ]; then
  ALLOW_EMPTY_DB=1
fi
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --allow-empty-db)
      ALLOW_EMPTY_DB=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--dry-run] [--allow-empty-db]" >&2
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

step "2a. Check $DB_PATH is the live board (not a fresh or wrong DATA_DIR)"
# Read-only (mode=ro): a missing file must NOT be created here, or the next step would back up
# and deploy onto an empty database without anyone noticing.
#
# Zero runs is NOT by itself a reason to abort -- a genuinely new board has zero runs, and that
# is fine. What IS a sign of a wrong DATA_DIR (any of these aborts, unless --allow-empty-db /
# RACE_ALLOW_EMPTY_DB=1):
#   - race.db is missing, but $STATE_FILE says a board was already deployed here before
#   - the file exists but lacks the `runs` table (not a race.db, or corrupted)
#   - the running container's RACE_DB doesn't point at /app/data/race.db
CHECK_PY="import sqlite3
try:
    c = sqlite3.connect('file:/data/race.db?mode=ro', uri=True)
    tables = {r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}
except sqlite3.OperationalError:
    print('missing')
else:
    print('bad-schema' if 'runs' not in tables else c.execute('SELECT COUNT(*) FROM runs').fetchone()[0])"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ docker run --rm --user 99:100 -v $DATA_DIR:/data:ro $PY_IMAGE python -c \"$CHECK_PY\""
  echo "+ docker inspect $CONTAINER --format '{{range .Config.Env}}{{println .}}{{end}}'   (checks RACE_DB matches /app/data/race.db)"
else
  RUNS="$(docker run --rm --user 99:100 -v "$DATA_DIR":/data:ro "$PY_IMAGE" python -c "$CHECK_PY" 2>/dev/null || echo "missing")"
  echo "runs in $DB_PATH: $RUNS"
  CONTAINER_RACE_DB="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^RACE_DB=' | cut -d= -f2- || true)"

  ABORT_REASON=""
  if [ "$RUNS" = "missing" ] && [ -f "$STATE_FILE" ]; then
    ABORT_REASON="race.db is missing, but $STATE_FILE says a board was already deployed here"
  elif [ "$RUNS" = "bad-schema" ]; then
    ABORT_REASON="race.db exists but has no 'runs' table -- not a race.db, or it is corrupted"
  elif [ -n "$CONTAINER_RACE_DB" ] && [ "$CONTAINER_RACE_DB" != "/app/data/race.db" ]; then
    ABORT_REASON="the running container's RACE_DB is '$CONTAINER_RACE_DB', not /app/data/race.db"
  fi

  if [ -n "$ABORT_REASON" ]; then
    if [ "$ALLOW_EMPTY_DB" -eq 0 ]; then
      echo "$ABORT_REASON -- is DATA_DIR right? Aborting (pass --allow-empty-db, or set RACE_ALLOW_EMPTY_DB=1, to deploy anyway)." >&2
      exit 1
    fi
    echo "$ABORT_REASON -- deploying anyway (--allow-empty-db/RACE_ALLOW_EMPTY_DB=1)." >&2
  elif [ "$RUNS" = "0" ]; then
    echo "board is empty (0 runs) -- fine for a genuinely new board, deploying."
  fi
fi

step "2b. chown -R 99:100 $DATA_DIR, then confirm the container can write it as 99:100"
# The container runs as 99:100 (Dockerfile USER, and --user 99:100 below); a data dir owned by
# root (e.g. created by an earlier root-run container, or by Unraid itself) makes it fail to
# open race.db for writing. Do this every deploy, not just once, so it self-heals.
run docker run --rm -v "$DATA_DIR":/data "$PY_IMAGE" chown -R 99:100 /data
run docker run --rm --user 99:100 -v "$DATA_DIR":/data "$PY_IMAGE" sh -c "touch /data/.write-test && rm /data/.write-test"

step "2c. Back up $DB_PATH"
# SQLite's online backup API, not `cp`: the live container keeps race.db in WAL mode, so a plain
# copy of race.db alone can miss committed transactions still sitting in race.db-wal.
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="race.db.bak-$TIMESTAMP"
BACKUP_PATH="$DATA_DIR/$BACKUP_NAME"
run docker run --rm --user 99:100   -v "$DATA_DIR":/data   "$PY_IMAGE"   python -c "import sqlite3; s = sqlite3.connect('/data/race.db'); d = sqlite3.connect('/data/$BACKUP_NAME'); s.backup(d); d.close(); s.close()"
if [ "$DRY_RUN" -eq 0 ] && [ ! -s "$BACKUP_PATH" ]; then
  echo "Backup copy at $BACKUP_PATH is missing or empty, aborting." >&2
  exit 1
fi
echo "Backup: $BACKUP_PATH"

step "3. Run migrate_modes.py against $DB_PATH, if it exists"
# Before the build, as DEPLOY_CHECKLIST.md orders it: migrate_modes.py is stdlib-only, so it runs
# in a stock python image straight from the pulled checkout, and a failure here stops the deploy
# with the old container still serving. It is additive and idempotent (a re-run backfills 0).
if [ -f "$MIGRATE_SCRIPT" ]; then
  echo "Found $MIGRATE_SCRIPT, running it in a throwaway $PY_IMAGE container."
  run docker run --rm --user 99:100     -v "$SERVER_DIR":/migrate:ro     -v "$DATA_DIR":/data     "$PY_IMAGE"     python /migrate/migrate_modes.py --db /data/race.db
else
  echo "No $MIGRATE_SCRIPT, skipping migration step."
fi

step "4. Build the new image ($IMAGE) from the checkout root (race/server + race/courses)"
# Baked into the image as RACE_GIT_SHA (Dockerfile ARG GIT_SHA) so GET /version reports the
# commit actually running, not just the code's idea of its own version string.
BUILD_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
run docker build -f "$SERVER_DIR/Dockerfile" --build-arg "GIT_SHA=$BUILD_SHA" -t "$IMAGE" "$APP_DIR"

step "5. Replace the running container"
run docker rm -f "$CONTAINER" || true
run docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  --user 99:100 \
  -v "$DATA_DIR:/app/data" \
  -e RACE_DB=/app/data/race.db \
  -v "$COURSES_DIR:/app/courses:ro" \
  -e RACE_COURSES_DIR=/app/courses \
  -v "$RUNWAYS_DIR:/app/runways:ro" \
  -e RACE_RUNWAYS_DIR=/app/runways \
  "$IMAGE"

step "6. Poll $HEALTH_URL (up to ${POLL_TIMEOUT_S}s, tolerating 502 during boot)"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ curl -sS -w '"'"'\\n%%{http_code}'"'"' %s   (repeated for up to %ss; PASS needs 200 and courses > 0)\n' "$HEALTH_URL" "$POLL_TIMEOUT_S"
  echo "--dry-run: skipping the actual poll."
  exit 0
fi

DEADLINE=$(( $(date +%s) + POLL_TIMEOUT_S ))
STATUS=""
RESULT="FAIL"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BODY="$(curl -sS -m 5 -w '\n%{http_code}' "$HEALTH_URL" || printf '\n000')"
  STATUS="${BODY##*$'\n'}"
  echo "  $HEALTH_URL -> $STATUS ${BODY%$'\n'*}"
  if [ "$STATUS" = "200" ]; then
    # /health carries the course count: an old image (no field) or an empty catalog is a FAIL.
    COURSES_N="$(printf '%s' "$BODY" | grep -o '"courses":[0-9]*' | cut -d: -f2 || true)"
    if [ -n "$COURSES_N" ] && [ "$COURSES_N" -gt 0 ]; then
      RESULT="PASS"
    else
      echo "  /health answered but reports no courses (courses=${COURSES_N:-absent})." >&2
    fi
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
