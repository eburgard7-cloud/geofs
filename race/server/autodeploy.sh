#!/usr/bin/env bash
# Pull-based auto-deploy for the race leaderboard/relay container on Unraid.
#
# Meant to run on a timer (5 min, via the Unraid User Scripts plugin -- see
# DEPLOY_CHECKLIST.md "Auto-deploy"). There is no inbound access and no GitHub-hosted runner
# involved: this script polls the repo, and the box pulls to itself.
#
# What it does, once per run:
#   1. git fetch origin "$DEPLOY_BRANCH" in APP_DIR. If origin/$DEPLOY_BRANCH hasn't moved since
#      the last deploy (DATA_DIR/.deployed_sha), exit quietly -- no log line, nothing to do.
#   2. Check GitHub's check-runs API for that exact commit SHA (public repo, no token needed).
#      Pending or failed CI: skip this tick and log it. Nothing is checked out or built.
#   3. Check out that SHA, tag the current `race` image `race:prev`, then hand off to
#      redeploy.sh (DB backup -> migrate -> build -> swap -> health poll).
#   4. If redeploy.sh fails AND the running container is unhealthy, roll back: run `race:prev`
#      with the same flags redeploy.sh uses, log ROLLBACK, and leave .deployed_sha unchanged so
#      the next tick tries again (or a fixed commit supersedes it). If redeploy.sh failed before
#      ever touching the container (e.g. the race.db backup step), the old container is still
#      serving untouched -- nothing to roll back, just log FAIL.
#
# Usage: race/server/autodeploy.sh [--dry-run]
#   --dry-run   fetch and evaluate for real (read-only: git fetch, the CI check, the health
#               probe), but make no changes: no checkout, no docker build/tag/run, no writes to
#               .deployed_sha or deploy.log. Passed through to redeploy.sh as --dry-run too.
#
# Overrides (env): RACE_DATA_DIR, RACE_DEPLOY_BRANCH (default "deploy"), RACE_REPO
# (default: parsed from `git remote get-url origin`), RACE_HEALTH_URL.
#
# Per race/CLAUDE.md: never touches Caddy, never edits the live Caddyfile.
set -euo pipefail

APP_DIR="/mnt/user/appdata/stack/race/app"
DATA_DIR="${RACE_DATA_DIR:-/mnt/user/appdata/stack/race/data}"
SERVER_DIR="$APP_DIR/race/server"
COURSES_DIR="$APP_DIR/race/courses"
STATE_FILE="$DATA_DIR/.deployed_sha"
LOCK_DIR="$DATA_DIR/.autodeploy.lock"
PAUSE_FILE="$DATA_DIR/.autodeploy_paused"
LOG_FILE="$DATA_DIR/deploy.log"
DEPLOY_BRANCH="${RACE_DEPLOY_BRANCH:-deploy}"
IMAGE="race"
CONTAINER="race"
NETWORK="proxy"
HEALTH_URL="${RACE_HEALTH_URL:-https://race.finsonly.net/health}"
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

# One line per *eventful* run (skip/fail/deploy/rollback) in deploy.log -- a plain "nothing to
# do" tick (unmoved branch, paused) intentionally writes nothing, or five-minute polling would
# fill the log with noise nobody reads.
log_line() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] would append to $LOG_FILE: $ts $1"
  else
    printf '%s %s\n' "$ts" "$1" >> "$LOG_FILE"
  fi
}

mkdir -p "$DATA_DIR"

if [ -f "$PAUSE_FILE" ]; then
  echo "$PAUSE_FILE exists -- auto-deploy is paused, exiting quietly."
  exit 0
fi

# Atomic (mkdir), dependency-free lock -- Unraid's minimal userspace isn't guaranteed to have
# util-linux's flock, but every POSIX mkdir is atomic. Reclaims a lock left by a dead process
# (e.g. the box rebooted mid-run) rather than wedging every future run forever.
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    trap 'rm -rf "$LOCK_DIR"' EXIT
    return 0
  fi
  local held_pid
  held_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
  if [ -n "$held_pid" ] && ! kill -0 "$held_pid" 2>/dev/null; then
    echo "stale lock from pid $held_pid (not running) -- reclaiming" >&2
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo $$ > "$LOCK_DIR/pid"
      trap 'rm -rf "$LOCK_DIR"' EXIT
      return 0
    fi
  fi
  return 1
}

if ! acquire_lock; then
  echo "another autodeploy run is already in progress ($LOCK_DIR exists), exiting quietly." >&2
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: git fetch and the CI/health checks run for real (read-only); nothing is built," \
       "checked out, tagged, run, or written to .deployed_sha/deploy.log."
fi

step "1. Fetch origin/$DEPLOY_BRANCH in $APP_DIR"
git -C "$APP_DIR" fetch origin "$DEPLOY_BRANCH"
REMOTE_SHA="$(git -C "$APP_DIR" rev-parse "origin/$DEPLOY_BRANCH")"
LAST_SHA="$(cat "$STATE_FILE" 2>/dev/null || echo "")"
echo "origin/$DEPLOY_BRANCH: $REMOTE_SHA  (last deployed: ${LAST_SHA:-none})"

if [ "$REMOTE_SHA" = "$LAST_SHA" ]; then
  echo "no change since the last deploy -- exiting quietly."
  exit 0
fi

step "2. Check CI for $REMOTE_SHA via the GitHub check-runs API"
# The repo's only CI is GitHub Actions (.github/workflows/test.yml), which posts Check Runs
# scoped to the commit SHA, not classic commit Statuses -- that's why this hits /check-runs and
# not /status. Check runs are keyed by SHA, not by branch, so it doesn't matter that test.yml's
# `push` trigger only watches main: the SHA already has results from when it landed there.
REPO="${RACE_REPO:-}"
if [ -z "$REPO" ]; then
  REMOTE_URL="$(git -C "$APP_DIR" remote get-url origin)"
  REPO="$(printf '%s' "$REMOTE_URL" | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
fi
CHECKS_JSON="$(curl -sS -m 15 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/commits/$REMOTE_SHA/check-runs?per_page=100" || echo '')"
# GitHub pretty-prints this response (a space after every ":"), so every pattern below tolerates
# an optional space -- a naive `"key":value` match silently finds nothing against the real API.
TOTAL="$(printf '%s' "$CHECKS_JSON" | grep -o '"total_count": *[0-9]*' | head -1 | grep -o '[0-9]*$' || true)"
if [ -z "$TOTAL" ] || [ "$TOTAL" -eq 0 ]; then
  echo "no check runs reported yet for $REMOTE_SHA -- CI hasn't started, or the API call failed."
  log_line "SKIP $REMOTE_SHA ci=none"
  exit 0
fi
INCOMPLETE="$(printf '%s' "$CHECKS_JSON" | grep -o '"status": *"[a-z_]*"' | grep -vc '"status": *"completed"' || true)"
if [ "${INCOMPLETE:-0}" -gt 0 ]; then
  echo "CI still running for $REMOTE_SHA ($INCOMPLETE of $TOTAL check(s) not completed yet)."
  log_line "SKIP $REMOTE_SHA ci=pending"
  exit 0
fi
FAILED="$(printf '%s' "$CHECKS_JSON" | grep -o '"conclusion": *"[a-z_]*"' | grep -Evc '"conclusion": *"(success|skipped|neutral)"' || true)"
if [ "${FAILED:-0}" -gt 0 ]; then
  echo "CI did not pass for $REMOTE_SHA ($FAILED of $TOTAL check(s) failed)."
  log_line "SKIP $REMOTE_SHA ci=failed"
  exit 0
fi
echo "CI passed for $REMOTE_SHA ($TOTAL checks)."

step "3. Check out $REMOTE_SHA"
run git -C "$APP_DIR" checkout "$DEPLOY_BRANCH"
run git -C "$APP_DIR" reset --hard "$REMOTE_SHA"

step "4. Tag the current $IMAGE image as ${IMAGE}:prev, in case this deploy needs a rollback"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ docker tag $IMAGE ${IMAGE}:prev (skipped if there is no existing $IMAGE image -- first deploy)"
else
  docker tag "$IMAGE" "${IMAGE}:prev" 2>/dev/null \
    && echo "tagged ${IMAGE}:prev" \
    || echo "no existing $IMAGE image to tag (first deploy?) -- rollback won't be possible this time"
fi

step "5. Hand off to redeploy.sh (backup -> migrate -> build -> swap -> health poll)"
REDEPLOY_ARGS=()
if [ "$DRY_RUN" -eq 1 ]; then
  REDEPLOY_ARGS+=(--dry-run)
fi
set +e
"$SERVER_DIR/redeploy.sh" "${REDEPLOY_ARGS[@]}"
REDEPLOY_RC=$?
set -e

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: stopping here -- not evaluating the (simulated) redeploy result, not writing state."
  exit 0
fi

if [ "$REDEPLOY_RC" -eq 0 ]; then
  echo "$REMOTE_SHA" > "$STATE_FILE"
  log_line "DEPLOY $REMOTE_SHA ok"
  echo "PASS"
  exit 0
fi

step "6. redeploy.sh failed (exit $REDEPLOY_RC) -- checking whether the running container is healthy"
HEALTH_BODY="$(curl -sS -m 5 -w '\n%{http_code}' "$HEALTH_URL" || printf '\n000')"
HEALTH_STATUS="${HEALTH_BODY##*$'\n'}"
HEALTH_COURSES="$(printf '%s' "$HEALTH_BODY" | grep -o '"courses":[0-9]*' | cut -d: -f2 || true)"
if [ "$HEALTH_STATUS" = "200" ] && [ -n "$HEALTH_COURSES" ] && [ "$HEALTH_COURSES" -gt 0 ]; then
  echo "the running container is healthy -- redeploy.sh must have failed before touching it" \
       "(e.g. the race.db backup/migrate step). Nothing to roll back."
  log_line "FAIL $REMOTE_SHA redeploy-error-pre-swap"
  exit 1
fi

step "7. Unhealthy (courses loaded: ${HEALTH_COURSES:-0}, http ${HEALTH_STATUS}) -- rolling back to ${IMAGE}:prev"
if ! docker image inspect "${IMAGE}:prev" >/dev/null 2>&1; then
  echo "no ${IMAGE}:prev image exists -- cannot roll back automatically. Old container may already" \
       "be down; fix by hand (DEPLOY_CHECKLIST.md 'Manual fallback')." >&2
  log_line "FAIL $REMOTE_SHA rollback-impossible-no-prev-image"
  exit 1
fi
run docker rm -f "$CONTAINER" || true
run docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  -v "$DATA_DIR:/app/data" \
  -e RACE_DB=/app/data/race.db \
  -v "$COURSES_DIR:/app/courses:ro" \
  -e RACE_COURSES_DIR=/app/courses \
  "${IMAGE}:prev"

DEADLINE=$(( $(date +%s) + POLL_TIMEOUT_S ))
RESULT="FAIL"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BODY="$(curl -sS -m 5 -w '\n%{http_code}' "$HEALTH_URL" || printf '\n000')"
  STATUS="${BODY##*$'\n'}"
  echo "  $HEALTH_URL -> $STATUS ${BODY%$'\n'*}"
  if [ "$STATUS" = "200" ]; then
    COURSES_N="$(printf '%s' "$BODY" | grep -o '"courses":[0-9]*' | cut -d: -f2 || true)"
    if [ -n "$COURSES_N" ] && [ "$COURSES_N" -gt 0 ]; then
      RESULT="PASS"
    fi
    break
  fi
  if [ "$STATUS" != "502" ] && [ "$STATUS" != "000" ]; then
    break
  fi
  sleep 2
done

# .deployed_sha is deliberately left unchanged either way: this tick's SHA never became the
# running version, so the next tick (or a fixed commit) should try again, not skip it as "done".
if [ "$RESULT" = "PASS" ]; then
  log_line "ROLLBACK $REMOTE_SHA to prev ok"
  echo "ROLLBACK"
else
  log_line "ROLLBACK $REMOTE_SHA to prev FAILED"
  echo "ROLLBACK-FAILED" >&2
fi
exit 1
