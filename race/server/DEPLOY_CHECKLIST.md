# Leaderboard deploy checklist (Unraid)

Copy-paste steps to bring `race.finsonly.net` up on the Unraid box. As of this writing
`race.finsonly.net` does not resolve (NXDOMAIN) and nothing is deployed — this is prep,
not a record of what's live.

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

```sh
mkdir -p /mnt/user/appdata/stack/race-api
# from your machine, or however files land on the box:
scp race/server/{app.py,requirements.txt,Dockerfile} unraid:/mnt/user/appdata/stack/race-api/
```

Verify the copy landed intact before doing anything else — a bad transfer here is a
confusing failure three steps later:

```sh
ls -la /mnt/user/appdata/stack/race-api/
cat /mnt/user/appdata/stack/race-api/app.py | head -5
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

## 3a. Deploy via Docker Compose (preferred)

Merge the service block below into
`/mnt/user/appdata/stack/docker-compose.yml`, under `services:`. Do this with an editor,
not a shell append — heredocs into a YAML file that already has a `services:` key will
just create a syntax error, not a merge.

```yaml
  race-api:
    build: ./race-api
    container_name: race-api
    restart: unless-stopped
    environment:
      RACE_ORIGINS: https://www.geo-fs.com,https://geo-fs.com
      RACE_MAX_SPEED_MS: "700"
      RACE_MIN_INTERVAL_S: "5"
    volumes:
      - /mnt/user/appdata/race-api:/data
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
docker build -t race-api .
docker rm -f race-api 2>/dev/null  # only if re-running this step; no-op the first time
docker run -d \
  --name race-api \
  --restart unless-stopped \
  --network proxy \
  -e RACE_ORIGINS=https://www.geo-fs.com,https://geo-fs.com \
  -e RACE_MAX_SPEED_MS=700 \
  -e RACE_MIN_INTERVAL_S=5 \
  -v /mnt/user/appdata/race-api:/data \
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

Then add this block to the Caddyfile (same file, new stanza — **no Authelia
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

Expect `{"ok":true}`. If that fails, check `docker logs race-api` and
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

## 6. Last step — only after all of the above is confirmed working

This flips the client over to the live board for everyone, so do it as its own commit
after everything above is verified, not bundled with the deploy itself:

1. In `race.js`, set `CONFIG.API_BASE = 'https://race.finsonly.net'`.
2. Bump `CONFIG.VERSION`.
3. Commit, push, and (if the fallback bookmarklet tag needs to move) re-tag per
   `race/bookmarklet.txt`'s note about the pinned jsDelivr tag.
