# Leaderboard deploy checklist (Unraid)

Copy-paste steps to bring `race.finsonly.net` up on the Unraid box, and to redeploy it
(section 7). This is a procedure, not a record of what's live: to find out which version is
actually running, the smoke test in section 5 is the source of truth.

**Per `race/CLAUDE.md`: never edit the live Caddyfile or restart containers without
explicit approval, and never add Authelia to this block.** Nothing below should be run
unattended — treat every `docker exec caddy caddy reload` and every container
build/start as a step to confirm before running, the same as any other live change.

## 0. Paths

- `/mnt/user/appdata/stack` — holds the stack's `docker-compose.yml` and `Caddyfile`.
- External network: `proxy` (shared by every stack service that Caddy fronts).
- Data dir: `/mnt/user/appdata/race-api`, owned `99:100` (matches the container's
  `USER 99:100` in the Dockerfile — Unraid's `nobody:users`).

## 1. Copy the app onto the box

The image is built from a **repo-shaped** directory, not from `race/server/` alone: the
Dockerfile copies `race/server/*` (including `race/server/static/`, the public site), `race/
bookmarklet.txt` and `race/courses/` (the course list the vote draws from), and the server
refuses to start with zero courses. Keep the `race/server`, `race/server/static` and
`race/courses` paths inside `race-api/`:

```sh
mkdir -p /mnt/user/appdata/stack/race-api/race/server/static /mnt/user/appdata/stack/race-api/race/courses
# from your machine, or however files land on the box:
scp race/server/{app.py,migrate_modes.py,requirements.txt,Dockerfile} unraid:/mnt/user/appdata/stack/race-api/race/server/
scp race/server/static/* unraid:/mnt/user/appdata/stack/race-api/race/server/static/
scp race/bookmarklet.txt unraid:/mnt/user/appdata/stack/race-api/race/
scp race/courses/*.json unraid:/mnt/user/appdata/stack/race-api/race/courses/
scp .dockerignore unraid:/mnt/user/appdata/stack/race-api/
```

Verify the copy landed intact before doing anything else — a bad transfer here is a
confusing failure three steps later:

```sh
ls -la /mnt/user/appdata/stack/race-api/race/server/ /mnt/user/appdata/stack/race-api/race/courses/
cat /mnt/user/appdata/stack/race-api/race/server/app.py | head -5
```

## 2. Data directory

```sh
mkdir -p /mnt/user/appdata/race-api
chown 99:100 /mnt/user/appdata/race-api
ls -ld /mnt/user/appdata/race-api
```

Confirm the `ls -ld` output actually shows `99 100` (or `nobody users`) as owner:group
before moving on. SQLite will fail silently-ish (permission errors buried in container
logs) if this is wrong.

### What ends up in `race.db`

Seven tables. The app creates all of them itself on every container start (`CREATE TABLE IF
NOT EXISTS`, then `PRAGMA journal_mode=WAL`), so a new version adds what is missing and leaves
every existing row alone.

> **1.2.0 adds the first real migration step.** Everything before it was pure
> `CREATE TABLE IF NOT EXISTS`. 1.2.0 also runs `migrate(conn)`, which uses
> `ALTER TABLE … ADD COLUMN pilot_id` on `runs`, `traces` and `race_results`, then backfills one
> `pilots` row per distinct (casefolded) callsign. It is additive, in place, idempotent, and run
> automatically on every start — **but back up `race.db` before deploying 1.2.0 anyway**
> (§7 step 1). `ALTER TABLE ADD COLUMN` is O(1) and rewrites no row, and an older image rolled
> back on top simply never selects the new column.

| Table | Since | Written by | Holds |
|---|---|---|---|
| `runs` | 0.1 | `POST /runs` | Every posted attempt, append-only: course, callsign, `time_ms`, splits, model, client version |
| `traces` | 0.9.0 | `POST /runs`, when it carries a `trace` | One row per (`course_hash`, `callsign`): that pilot's best ghost trace, replaced by a faster run |
| `cups` | 0.11.0 | the relay, when a cup's first race finishes | `id`, `room`, `name`, `race_count`, `created_at`, `closed_at` (NULL while open) |
| `races` | 0.11.0 | the relay, once per finished lobby race | `id`, `room`, `course_hash`, `course_name`, `started_at`, `cup_id` (NULL for a one-off) |
| `race_results` | 0.11.0 | the same write as `races` | `race_id`, `callsign`, `pos`, `go_time_ms`, `status`, `points`, `model`, `stats_json` |
| `mode_runs` | proto 6 | `POST /runs` (as `mode_id='race'`, alongside its `runs` row), `POST /landings` (as `mode_id='landing'`, server-scored) and `POST /modes/{mode}/runs` | Every mode's runs in one shape: `pilot_id`, `callsign`, `course_id`, `course_hash`, `mode_id`, `metric_value`, `direction` (`asc`/`desc`), `payload_json`, `created_at`, and `legacy_run_id` (the `runs.id` a race row mirrors; UNIQUE, which is what makes the backfill idempotent) |
| `pilots` | 1.2.0 | the hub, on `hello` | One row per pilot: `pilot_id` (uuid4), `callsign` (display), `callsign_key` (casefolded, UNIQUE), `token_hash` (sha256 of the pilot's token; NULL = backfilled and unclaimed), `created_at`, `last_seen`, and the ramp-ping cap (`ramp_day`, `ramp_count`, `last_ramp_ms`) |

0.10.0 (the visible items) added no table: everything about a race in flight — rooms, lobby
state, bananas, projectiles, a cup's running total — is in memory and is gone on restart.
1.2.0's hub adds no table beyond `pilots`: presence, the room registry, the course vote and every
chat line are in memory and gone on restart, on purpose. **Chat is never persisted anywhere** —
not a table, not a log.

After a deploy, `sqlite3 /mnt/user/appdata/race-api/race.db ".tables"` should list `cups`,
`mode_runs`, `pilots`, `race_results`, `races`, `runs` and `traces`, and
`sqlite3 … "SELECT COUNT(*) FROM pilots;"` should be roughly the number of distinct callsigns on
the board (that is the backfill). Rolling back to an older image is safe: it just ignores the
tables and columns it doesn't know.

### Freeing a callsign (admin)

A callsign is owned by one `pilot_id` and claiming one someone else holds is refused. There is
**no endpoint** for releasing one — this server has no auth by design, and a new secret shipped
anywhere would be a worse trade than a one-line query. To hand a name back, with the container
running:

```sh
# Who holds it, and is it actually claimed? (token_hash NULL = nobody has proved it yet)
sqlite3 /mnt/user/appdata/race-api/race.db \
  "SELECT pilot_id, callsign, token_hash IS NOT NULL AS claimed, last_seen FROM pilots
   WHERE callsign_key = lower(trim('TheName'));"

# Release it: the pilot row and its history stay, the NAME becomes claimable again by whoever
# proves it next (exactly like a backfilled row).
sqlite3 /mnt/user/appdata/race-api/race.db \
  "UPDATE pilots SET token_hash = NULL WHERE callsign_key = lower(trim('TheName'));"
```

That invalidates the old holder's token for that name and nothing else. Do not `DELETE` the row:
`runs`, `traces` and `race_results` reference its `pilot_id`, and deleting it orphans that history.

## 3a. Deploy via Docker Compose (preferred)

Merge the service block below into
`/mnt/user/appdata/stack/docker-compose.yml`, under `services:`. Do this with an editor,
not a shell append — heredocs into a YAML file that already has a `services:` key will
just create a syntax error, not a merge.

```yaml
  race-api:
    build:
      context: ./race-api                  # repo-shaped: race/server + race/courses (section 1)
      dockerfile: race/server/Dockerfile
    container_name: race-api
    restart: unless-stopped
    environment:
      RACE_ORIGINS: https://www.geo-fs.com,https://geo-fs.com
      # 1.2.0, all optional — the defaults are the ones in app.py's constant block.
      # RACE_ROOM_MAX_PILOTS: "12"      # pilots per room; spectators don't count toward it
      # RACE_RAMP_PING_PER_DAY: "3"     # ping-the-ramp budget per pilot per day (UTC-7 midnight reset)
      # RACE_CHAT_RATE_PER_S: "2"       # free-text lobby chat, burst 4, separate from the 20 msg/s socket cap
      RACE_MAX_SPEED_MS: "700"
      RACE_MIN_INTERVAL_S: "5"
      RACE_COURSES_DIR: /app/courses
    volumes:
      - /mnt/user/appdata/race-api:/data
      # Live course list over the image's snapshot: updating race-api/race/courses (scp or
      # git pull) reaches the next room's vote with no rebuild or restart.
      - ./race-api/race/courses:/app/courses:ro
    networks:
      - proxy
```

(This is `race/server/compose.snippet.yml` verbatim — diff it against what you pasted
to be sure nothing got mangled.)

```sh
cd /mnt/user/appdata/stack
docker compose up -d --build race-api
docker compose ps race-api
docker compose logs --tail=50 race-api
```

## 3b. No-Compose fallback (Compose Manager plugin has gone missing before)

If the Docker Compose Manager plugin isn't there, skip 3a and build/run the container
directly instead of hand-editing compose state you can't verify:

```sh
cd /mnt/user/appdata/stack/race-api
docker build -f race/server/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t race-api .
docker rm -f race-api 2>/dev/null  # only if re-running this step; no-op the first time
docker run -d \
  --name race-api \
  --restart unless-stopped \
  --network proxy \
  -e RACE_ORIGINS=https://www.geo-fs.com,https://geo-fs.com \
  `# 1.2.0 optional: -e RACE_ROOM_MAX_PILOTS=12 -e RACE_RAMP_PING_PER_DAY=3 -e RACE_CHAT_RATE_PER_S=2` \
  -e RACE_MAX_SPEED_MS=700 \
  -e RACE_MIN_INTERVAL_S=5 \
  -v /mnt/user/appdata/race-api:/data \
  -v /mnt/user/appdata/stack/race-api/race/courses:/app/courses:ro \
  -e RACE_COURSES_DIR=/app/courses \
  race-api
docker ps --filter name=race-api
docker logs --tail=50 race-api
```

Either way, confirm the container is actually on the `proxy` network before touching
Caddy:

```sh
docker inspect race-api --format '{{json .NetworkSettings.Networks}}' | grep -o '"proxy"'
```

## 4. Caddy block

Open the stack's live jellyfin block first and copy its exact geoblock + crowdsec
directive lines — don't retype them from memory, and don't invent syntax; whatever that
block currently uses is what this one should use too:

```sh
grep -A 20 '^jellyfin' /mnt/user/appdata/stack/Caddyfile
```

This same block also fronts the powerups relay's WebSocket endpoint
(`/ws/race/{room}`) — `reverse_proxy` proxies WS upgrades automatically in Caddy 2, so
no separate stanza or matcher is needed for it. The one thing worth double-checking once
this is live is that the geoblock/CrowdSec directives copied in below don't strip the
`Connection`/`Upgrade` headers or otherwise treat the handshake as something to block;
see step 5 for how to actually test that (a plain `curl` won't catch it — it never sends
an Upgrade request in the first place).

Add this block to the Caddyfile (same file, new stanza — **no Authelia
`forward_auth`**: the browser calls this API cross-origin from geo-fs.com and can't do
the Authelia login redirect):

```
race.finsonly.net {
	# <geoblock directive — copied from the jellyfin block above>
	# <crowdsec directive — copied from the jellyfin block above>
	reverse_proxy race-api:8000
}
```

Write it with a quoted heredoc so the shell doesn't expand anything in it, then
immediately `cat` it back — pasted commands on this box have picked up stray characters
before, and a heredoc write is exactly the kind of thing that fails silently if a
character got dropped mid-paste:

```sh
cat >> /mnt/user/appdata/stack/Caddyfile <<'CADDYEOF'

race.finsonly.net {
	# <geoblock directive>
	# <crowdsec directive>
	reverse_proxy race-api:8000
}
CADDYEOF
cat /mnt/user/appdata/stack/Caddyfile | tail -8
```

Read that `tail` output back line by line against what you meant to paste before
reloading. Once it matches:

```sh
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

`caddy validate` first is deliberate — it catches a broken Caddyfile before `reload`
touches the running config for every other site Caddy fronts, not just this one.

## 5. Verify

```sh
curl -sS -m 5 https://race.finsonly.net/health
```

Expect `{"ok":true,"courses":N}` with N > 0 (15 as of this writing). `docker logs race-api`
should show `courses loaded: N from /app/courses`; a container that logs
`no courses loaded` and exits means the courses mount or snapshot is missing. If that fails, check `docker logs race-api` and
`docker exec caddy caddy validate --config /etc/caddy/Caddyfile` before assuming it's a
DNS/proxy issue — cheaper to rule out the container first.

Then a real `POST /runs` smoke test, matching `RunIn` in `app.py` exactly and using the
actual starter course already in the repo (`race/courses/starter-sprint-seatac.json`,
hash `1b352c3c` as of this course's current gates — recompute with
`race/tools/add_course.py` if that file has changed since):

```sh
curl -sS -m 5 -X POST https://race.finsonly.net/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "course_id": "starter-sprint-seatac",
    "course_hash": "1b352c3c",
    "course_name": "Starter Sprint (Sea-Tac test course)",
    "callsign": "DEPLOY-TEST",
    "aircraft_id": "7",
    "model": "",
    "time_ms": 90000,
    "splits": [18000, 36000, 54000, 72000, 90000],
    "gates": 6,
    "length_m": 10000,
    "client_version": "0.2.3"
  }'
```

Expect a 200 with a JSON body like `{"id":1,"rank":1,"personal_best":90000,"improved":true}`.
A 422 means the payload stopped matching `RunIn`'s validation (check `app.py` for what
changed); a 429 means you're re-running this within `RACE_MIN_INTERVAL_S` (5s) of a
previous attempt from the same IP — wait a few seconds and retry.

Then confirm the test row is actually queryable and clean it up so it doesn't sit in a
"live" leaderboard forever:

```sh
curl -sS -m 5 'https://race.finsonly.net/leaderboard?course_hash=1b352c3c'
# then, on the box, remove the smoke-test row directly (there's no DELETE endpoint by design):
sqlite3 /mnt/user/appdata/race-api/race.db "DELETE FROM runs WHERE callsign='DEPLOY-TEST';"
```

### Powerups relay smoke test (WebSocket)

The relay (`/ws/race/{room}`) is separate from the HTTP endpoints above and needs its own
check — `curl` alone won't tell you whether the WS upgrade actually makes it through
Caddy/geoblock/CrowdSec, since a plain `curl -sS` request never sends the
`Connection: Upgrade` handshake in the first place. Use a real WS client, e.g.
[`websocat`](https://github.com/vi/websocat) from your own machine (not the Unraid box,
so this also exercises the geoblock the way a real friend would hit it):

```sh
websocat wss://race.finsonly.net/ws/race/smoke-test
{"type":"join","callsign":"DEPLOY-TEST"}
```

Expect `{"type":"joined","room":"smoke-test","proto":5,"server_ms":...}` echoed back, followed by
a `lobby` frame (and, from 1.2.0, a `vote` frame if the board has any runs on it). `"proto":5` is
the part that matters: a client only turns on the lobby at 2, the visible items at 3, shared
results at 4, and free-text chat / spectating / the course vote at 5. If the connection instead
fails at the handshake (not after), check the geoblock/CrowdSec directives first — that's
the layer most likely to reject on origin/headers before the request ever reaches
`race-api`; see the note in `Caddyfile.snippet`. There is nothing to clean up afterward:
the relay keeps no DB, and the room disappears on its own once every socket in it
disconnects (or on the next `race-api` restart, whichever comes first).

### Hub smoke test (WebSocket, 1.2.0)

`/ws/hub` is the second socket and needs its own check — and, like the relay above, `curl` alone
cannot do it, because a plain `curl -sS` never sends the `Connection: Upgrade` handshake. Two
steps, both from your own machine so the geoblock is exercised the way a real friend would hit it:

```sh
# 1. Does the upgrade survive Caddy/geoblock/CrowdSec at all? Expect "HTTP/1.1 101".
curl -i -N -o - -s --max-time 5 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==" -H "Origin: https://www.geo-fs.com" \
  https://race.finsonly.net/ws/hub | head -1

# 2. The actual frame exchange, end to end. Needs `pip install websockets` on your machine only
#    (it is NOT a server dependency and is not in requirements.txt).
python race/tools/hub_smoke.py wss://race.finsonly.net/ws/hub
```

`hub_smoke.py` exercises: a first `hello` with no token (expect `welcome` with a fresh
`pilot_id`/`pilot_token` and `proto: 5`), a reconnect presenting that token (expect the **same**
`pilot_id`), a second pilot claiming the first one's callsign (expect a refusal naming the holder),
`where`, `list`, and a `ping_ramp` that the other client receives as `ramp_ping`. It prints one
line per check and exits non-zero on the first failure.

Note that step 2 **spends one of the test pilot's three daily ramp pings**. That is by design — the
cap is server-side and deliberately scarce — so don't loop it. The pilot rows it creates are
harmless; remove them if you'd rather not leave them behind:

```sh
sqlite3 /mnt/user/appdata/race-api/race.db \
  "DELETE FROM pilots WHERE callsign_key LIKE 'hub-smoke%';"
```

### Lobby smoke test (WebSocket, lobby reliability pass)

From your own machine, after the hub check above (needs `pip install websockets` locally):

```sh
python race/tools/smoke_lobby.py                       # 2 pilots against wss://race.finsonly.net
python race/tools/smoke_lobby.py --clients 3
```

It drives scripted pilots through a throwaway `smoke-<hex>` room: join, lobby presence, typed
chat both ways, a vote on a real course, ready, GO, distinct grid slots, abort, spectate, leave and
host handoff, printing PASS/FAIL per step and exiting non-zero on any failure. It aborts the
countdown before GO, so nothing is scored or written; the race socket never touches `pilots`.
A `vote` FAIL naming only `surprise-me` means the server loaded no courses (the 2026-09-23 night).

### Smoke test (after every deploy or redeploy)

Four checks, from your own machine so the geoblock is exercised the way a friend would hit it.
Health and the WebSocket join are the checks from above, tightened; `/ghost` (0.9.0) and `GET /`
(0.11.0) are new.

1. **Health.** `curl -sS -m 5 https://race.finsonly.net/health` returns `{"ok":true,"courses":N}` with N > 0.
2. **`/ghost` 404s on a hash nobody has raced.** This proves the 0.9.0 route *and* the
   `traces` table are there — but a missing route also answers 404, so read the body:
   ```sh
   curl -sS -m 5 -w '
HTTP %{http_code}
' 'https://race.finsonly.net/ghost?course_hash=0000dead'
   ```
   Pass is `{"detail":"No ghost recorded for that course yet."}` and `HTTP 404`. A body of
   `{"detail":"Not Found"}` means the old image is still serving (the route does not exist),
   and a `500` means `traces` is missing.
3. **A WebSocket `join` answers `"proto":4`.** The `websocat` check under "Powerups relay smoke
   test" above. Anything below 4 means an older `app.py` is running.
4. **`GET /` returns 200.** The landing page (0.11.0):
   ```sh
   curl -sS -m 5 -D - -o /dev/null https://race.finsonly.net/ | head -8
   ```
   Expect `HTTP/… 200`, `content-type: text/html`, and a `content-security-policy` header
   starting `default-src 'none'`. A 404 here is the same old-image tell as in check 2.

## 6. Last step — only after all of the above is confirmed working

This flips the client over to the live board for everyone, so do it as its own commit
after everything above is verified, not bundled with the deploy itself:

1. In `race.js`, set `CONFIG.API_BASE = 'https://race.finsonly.net'`.
2. Bump `CONFIG.VERSION`.
3. Commit, push, and (if the fallback bookmarklet tag needs to move) re-tag per
   `race/bookmarklet.txt`'s note about the pinned jsDelivr tag.

## 7. Redeploying an existing server

`race/server/redeploy.sh` automates this for a box laid out as a git checkout — `APP_DIR`
`/mnt/user/appdata/stack/race/app` (this repo, updated with `git pull`), `DATA_DIR`
`/mnt/user/appdata/stack/race/data` (holding `race.db`), image/container both named `race`,
on the `proxy` network. **That is not the `race-api`/scp layout sections 0–6 describe** — check
which layout is actually on the box before running it; the two are not interchangeable without
updating the paths in one of them.

**Confirm the data directory before the first run.** `redeploy.sh` mounts
`/mnt/user/appdata/stack/race/data`, the scp layout mounts `/mnt/user/appdata/race-api`. Pointing a
redeploy at the wrong one starts a fresh, empty `race.db` — no runs, no pilots, a new token for
everyone — and before the courses fix it also emptied the course vote (the 2026-09-23 incident).
`docker inspect <container> --format '{{json .Mounts}}'` shows which one the live container uses;
set `RACE_DATA_DIR=` to it if it isn't the default.

The 2a guard no longer treats a plain **zero-run count as suspect** — a genuinely new board has
zero runs, and deploying onto it is exactly what should happen. It aborts only on an actual
wrong-`DATA_DIR` signal:
- `race.db` is missing, but `DATA_DIR/.deployed_sha` (written by `autodeploy.sh`) says a board was
  already deployed here before — the db vanished out from under a live deploy history;
- the file exists but has no `runs` table — not a `race.db` at all, or it's corrupted;
- the *running* container's `RACE_DB` env doesn't point at `/app/data/race.db` — someone started
  it by hand against a different path.

Pass `--allow-empty-db`, or set `RACE_ALLOW_EMPTY_DB=1`, to deploy anyway when one of those trips.

Run it from the box:

```sh
race/server/redeploy.sh --dry-run   # print every command first, run nothing
race/server/redeploy.sh             # 1. git pull
                                     # 2a. abort only on a real wrong-DATA_DIR
                                     #     signal (see above); a zero-run count
                                     #     alone just logs "board is empty"
                                     # 2b. chown -R 99:100 the data dir, then
                                     #     verify a 99:100 write actually works
                                     # 2c. back up race.db (SQLite online backup,
                                     #    not cp; aborts if the copy is empty)
                                     # 3. run race/server/migrate_modes.py (if
                                     #    present) in a stock python:3.12-slim
                                     # 4. docker build -f race/server/Dockerfile
                                     #    from the checkout root
                                     # 5. swap the container (runs as --user 99:100,
                                     #    same as the Dockerfile's own USER, so it
                                     #    can never leave root-owned files behind)
                                     # 6. poll /health for up to 30s; PASS needs
                                     #    200 and courses > 0
                                     # 7. PASS only: docker image prune -f (dangling
                                     #    only) + keep the 10 newest race.db.bak-*;
                                     #    logs bytes freed (skip: --no-prune)
```

Step 7 (`race/server/prune.sh`) never runs after a FAIL, so a failed deploy keeps every image and
backup. It prunes dangling images only (never `-a`), which by Docker's rules can't remove
`race:prev` or the image a container is using; and if either of those IDs ever shows up as
dangling, it skips the image prune entirely. It prints a
`PRUNE images_reclaimed=… backups_removed=… backup_bytes_freed=… backups_kept=…` line and
appends it to `DATA_DIR/deploy.log`.

Same order as the manual steps below: **chown, then back up, then migrate, then build.** A failed
backup or migration stops the script before anything is rebuilt, with the old container still
serving.

It never touches Caddy. After it prints `PASS`, still run the smoke test in section 5 — the
script's poll only proves `/health` answered with a non-empty course list, not that every endpoint/route in this
release actually works. On `FAIL`, or if the script can't run at all, use the manual steps below.

### Manual fallback (race-api / scp layout)

Same box, same data directory, new `app.py`. This is the order of operations; the commands are
the ones already above, not repeated here.

1. **Back up `race.db` first.** Use SQLite's own backup, not `cp` — the database is in WAL
   mode, so a plain copy of `race.db` can miss whatever is still in `race.db-wal`:
   ```sh
   sqlite3 /mnt/user/appdata/race-api/race.db ".backup '/mnt/user/appdata/race-api/race.db.$(date +%Y%m%d-%H%M).bak'"
   ls -la /mnt/user/appdata/race-api/
   ```
   It is safe with the container running. Check the copy, and keep it for a few days:
   `sqlite3 <that .bak file> "PRAGMA integrity_check;"` should print `ok`. If the running
   container mounts its data somewhere other than section 0's path,
   `docker inspect race-api --format '{{json .Mounts}}'` shows where `race.db` really is.
2. **Get the new code onto the box** — section 1 (copy and verify). Make sure
   `migrate_modes.py` came across with `app.py`: the next step and the new Dockerfile both need it.
3. **Run the mode migration (proto 6 and later)** — against the live database, before the rebuild.
   It only creates `mode_runs` and copies every `runs` row into it as `mode_id='race'`; it never
   drops, alters or updates anything, and a second run does nothing (it prints
   `0 backfilled, N already present`). It is stdlib-only, so it runs in a stock Python image and
   does not need the new build:
   ```sh
   docker run --rm --user 99:100 \
     -v /mnt/user/appdata/race-api:/data \
     -v /mnt/user/appdata/stack/race-api/race/server/migrate_modes.py:/migrate_modes.py:ro \
     python:3.12-slim python /migrate_modes.py --db /data/race.db
   sqlite3 /mnt/user/appdata/race-api/race.db \
     "SELECT (SELECT COUNT(*) FROM runs), (SELECT COUNT(*) FROM mode_runs WHERE mode_id = 'race');"
   ```
   The two counts should match. It is safe with the old container still running (WAL mode). The
   new `app.py` also runs the same migration on every start, so skipping this step does not break
   the app — running it first just means a failure shows up here, with the old version still
   serving, rather than as a container that will not start.
4. **Rebuild and start** — section 3a (Compose) or 3b (no Compose), whichever this box uses.
   Restarting drops every live room: pick a moment when nobody is mid-race, and remember the
   README's "the relay is ephemeral" note before you do it on race night. Per the top of this
   file, don't run it unattended.
5. **Smoke test** — the four checks above, all four. After a proto-6 deploy, also
   `curl -s https://race.finsonly.net/modes` should list `race` (`asc`) and `landing` (`desc`), and
   `curl -s "https://race.finsonly.net/landing-leaderboard?runway_id=sea-tac-16c"` should answer
   `{"mode":"landing",...,"rows":[]}` (or rows, once anyone has landed).
6. **Roll back if it fails:** put the previous `app.py` back (`git show <old-commit>:race/server/app.py`)
   and repeat step 4. The database does not need rolling back — the new tables are ignored by
   the old code — unless `integrity_check` says the file itself is damaged, in which case
   restore the backup from step 1 with the container stopped.
   A pre-proto-6 `app.py` writes race runs to `runs` only; the next proto-6 start (or a re-run of
   step 3) backfills whatever it posted into `mode_runs`, so rolling forward again needs nothing extra.

## 8. Auto-deploy (pull-based, no inbound access, no GitHub-hosted runner)

`race/server/autodeploy.sh` polls the repo from the box on a timer and hands off to
`redeploy.sh` when there's a CI-passed commit to deploy. Nothing reaches into the box from
outside — GitHub Actions never sees the box, and the box only ever makes outbound calls (`git
fetch`, the GitHub API, its own `/health`).

### Flow

1. Merge your change to `main` as usual — CI runs there (`.github/workflows/test.yml`).
2. Point the `deploy` branch at it: `git push origin main:deploy`.
3. Within ~5 minutes (the cron interval below), `https://race.finsonly.net/version` shows the
   new `sha`. Check it from any browser:
   ```sh
   curl -s https://race.finsonly.net/version
   # {"sha":"<40-char sha>","version":"1.4.0","proto":6,"courses":N,"started_at":"<ISO8601>"}
   ```
   `started_at` changing confirms the container actually restarted, not just that the code on
   disk changed.

Autodeploy **never triggers a new CI run** — it reads the check-runs GitHub already recorded
for that exact SHA (from the `pull_request` or `push`-to-`main` run that landed it on `main` in
the first place). A commit pushed straight to `deploy` without ever having been on `main` (and
therefore never CI-checked) sits forever as `SKIP … ci=none` — that's deliberate, not a bug.

### Install (Unraid User Scripts plugin)

The **User Scripts** plugin isn't part of a stock Unraid install — check Apps for it first (by
Squid) if it isn't already on the box.

1. Community Apps → Apps → search **User Scripts** → Install.
2. Settings → User Scripts → **Add New Script**, name it `race-autodeploy`.
3. Edit the script and put exactly one line in it:
   ```sh
   /mnt/user/appdata/stack/race/app/race/server/autodeploy.sh
   ```
4. Set its schedule to **Custom** → `*/5 * * * *` (every 5 minutes).
5. Run it once by hand first (the script's own "Run Script" button, or `... --dry-run` pasted
   into the box's terminal) to confirm `APP_DIR` is actually a checkout of this repo on the
   `deploy` branch before you let the cron loose on it.

### What it checks, in order

1. `git fetch origin deploy` in `APP_DIR`. If `origin/deploy` hasn't moved since the SHA
   recorded in `DATA_DIR/.deployed_sha`, it exits quietly — no `deploy.log` line, nothing to see.
2. GitHub's check-runs API for that exact SHA (public repo, no token). Pending or failed CI:
   the tick is skipped and logged (`SKIP <sha> ci=pending` / `ci=failed` / `ci=none`); nothing is
   checked out or built.
3. Checks out the SHA, tags the current `race` image `race:prev`, then calls `redeploy.sh`
   (same chown → backup → migrate → build → swap → health-poll sequence as a manual redeploy).
4. If `redeploy.sh` fails, it checks whether the running container is actually unhealthy
   (`/health`, same `courses > 0` bar redeploy.sh's own poll uses). If the container's fine, the
   failure was before the swap (e.g. the `race.db` backup step) and nothing is rolled back — just
   logged (`FAIL <sha> redeploy-error-pre-swap`). If the container is unhealthy — including a
   image that starts but loads zero courses — it rolls back: runs `race:prev` with the exact
   flags `redeploy.sh` step 5 uses (including `--user 99:100`), re-polls `/health`, and logs
   `ROLLBACK <sha> to prev ok` (or `FAILED`, if even the rollback doesn't come up healthy — that
   needs a manual look). A rollback that comes up healthy then runs the same step-7 prune as
   `redeploy.sh` (`--no-prune` skips it here too). Either way, `.deployed_sha` is left unchanged, so the next tick (or a
   fixed commit on `deploy`) tries again rather than treating the failed SHA as done.

Any argument besides `--dry-run` (e.g. `--allow-empty-db`, `--no-prune`) and any env var `redeploy.sh` reads
(e.g. `RACE_ALLOW_EMPTY_DB=1`) pass straight through — `autodeploy.sh` doesn't interpret them
itself, it just forwards them to `redeploy.sh`, which validates them the same as a manual run.

`deploy.log` (`DATA_DIR/deploy.log`) gets one line per *eventful* run — a skip, a deploy, a
failure, a rollback — not one line every 5 minutes; a tick where nothing changed writes nothing.

### Pausing it

Drop a file at `DATA_DIR/.autodeploy_paused` (any content, even empty — `touch` it) before any
manual work on the box (a hand-run `redeploy.sh`, digging into `race.db`, anything that
shouldn't race against a cron tick). Autodeploy checks for it first and exits immediately,
before taking its lock or touching git. Remove the file to resume; the very next tick picks up
wherever `origin/deploy` and `.deployed_sha` actually are.

**Autodeploy's own lock only protects it against itself** (two overlapping cron ticks) — it does
not know about a manually-run `redeploy.sh`. Pause autodeploy first if you're about to run
`redeploy.sh` by hand, or the two can build/swap the container at the same time.

### Manual fallback

If the User Scripts plugin goes missing (it has before — see section 3b's note) or you'd rather
not wait for the next tick, `race/server/autodeploy.sh` and `race/server/redeploy.sh` are both
safe to run by hand from the box, in that order or independently — `autodeploy.sh --dry-run`
first is the same "print everything, touch nothing" check `redeploy.sh --dry-run` gives you.
