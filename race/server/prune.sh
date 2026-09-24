# shellcheck shell=bash
# Post-deploy cleanup, sourced by redeploy.sh and autodeploy.sh. Call it ONLY after a PASSing
# health check -- a failed deploy keeps everything, so there is always something to roll back to.
#
#   prune_after_pass DATA_DIR IMAGE CONTAINER DRY_RUN [KEEP_BACKUPS] [LOG_FILE]
#
# 1. `docker image prune -f`: dangling (untagged) images only -- never -a. By Docker's own rules
#    that cannot remove a tagged image (so never ${IMAGE}:prev) or one a container uses. As a
#    second guard, if ${IMAGE}:prev's or the running container's image ID is somehow in the
#    dangling list, the image prune is skipped outright.
# 2. Keeps the KEEP_BACKUPS (default 10) newest race.db.bak-* in DATA_DIR and deletes the rest.
#    Names are race.db.bak-YYYYmmdd-HHMMSS, so name order is age order (mtime is not trusted:
#    a restore or copy resets it).
# Prints one summary line with the bytes freed, and appends it to LOG_FILE (if given, not dry-run).
# Never fails the caller: the deploy already PASSed, so a cleanup hiccup only warns.

prune_after_pass() {
  local data_dir="$1" image="$2" container="$3" dry_run="$4" keep="${5:-10}" log_file="${6:-}"
  local protected="" id dangling reclaimed="0B" out
  local -a backups=() doomed=()
  local backup_bytes=0 f size

  printf '\n==> Prune after PASS: dangling images, and race.db backups beyond the newest %s\n' "$keep"

  # --- images
  for id in "$(docker image inspect "${image}:prev" --format '{{.Id}}' 2>/dev/null || true)" \
            "$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null || true)"; do
    if [ -n "$id" ]; then protected="$protected $id"; fi
  done
  echo "protected image IDs (${image}:prev, running $container):${protected:- none found}"
  if [ "$dry_run" -eq 1 ]; then
    echo "+ docker image prune -f   (dangling only; skipped if a protected ID is dangling)"
  else
    dangling="$(docker images -f dangling=true -q --no-trunc 2>/dev/null || true)"
    local hit=""
    for id in $protected; do
      if printf '%s\n' "$dangling" | grep -qx "$id"; then hit="$id"; fi
    done
    if [ -n "$hit" ]; then
      echo "WARNING: protected image $hit is dangling -- skipping docker image prune this time." >&2
    else
      echo "+ docker image prune -f"
      out="$(docker image prune -f 2>&1 || true)"
      printf '%s\n' "$out"
      reclaimed="$(printf '%s\n' "$out" | sed -n 's/^Total reclaimed space: *//p' | tail -1)"
      reclaimed="${reclaimed:-0B}"
    fi
  fi

  # --- race.db backups
  for f in "$data_dir"/race.db.bak-*; do
    if [ -f "$f" ]; then backups+=("$f"); fi
  done
  if [ "${#backups[@]}" -gt "$keep" ]; then
    mapfile -t doomed < <(printf '%s\n' "${backups[@]}" | sort -r | tail -n +"$((keep + 1))")
  fi
  for f in "${doomed[@]}"; do
    size="$(wc -c < "$f" | tr -d ' ')"
    backup_bytes=$((backup_bytes + size))
    echo "+ rm -f $f   ($size bytes)"
    if [ "$dry_run" -eq 0 ]; then
      rm -f "$f" || echo "WARNING: could not remove $f" >&2
    fi
  done

  local summary="PRUNE images_reclaimed=$reclaimed backups_removed=${#doomed[@]} backup_bytes_freed=$backup_bytes backups_kept=$(( ${#backups[@]} - ${#doomed[@]} ))"
  if [ "$dry_run" -eq 1 ]; then
    echo "[dry-run] $summary (nothing removed)"
  else
    echo "$summary"
    if [ -n "$log_file" ]; then
      printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$summary" >> "$log_file" || true
    fi
  fi
  return 0
}
