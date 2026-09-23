# Changelog

One line per shipped item. Details live in README.md, PROTOCOL.md and server/DEPLOY_CHECKLIST.md;
what still needs the live sim is in ACCEPTANCE.md.

## 1.5.0: race.finsonly.net redesign

- **Public site rebuilt** — `race/server/static/{index.html,site.css,site.js}`, plain static files
  (`StaticFiles(html=True)` answers `/`) replacing the old inline-HTML page: hero record replay
  (animated ghost trace over an SVG route map), live departures board, per-cup course records with
  mini route maps, recent races/open cups, and a real draggable bookmarklet built from
  `race/bookmarklet.txt` at server start. Google Fonts (Saira/Saira Condensed) is the one allowed
  external request; CSP is `script-src 'self'` (no inline script at all, tighter than before).
  Every section has a loading skeleton, an empty state and an error state, and times out at 8 s.
- **New read-only endpoints** — `GET /stats` (races/pilots/gates/missiles_hit), `GET /rooms/live`
  (live rooms, never a join code or pilot_token), `GET /courses/catalog` (every course, raced or
  not, for the per-cup tabs), `GET /bookmarklet`. All cached a few seconds in memory and
  per-IP rate limited (`RACE_GET_MIN_INTERVAL_S`).
- **Course metadata** — `race/courses/index.json` entries carry `cup`/`difficulty`; `GET /courses`
  and `/courses/catalog` add `cup`/`difficulty`/`length_km`/`gate_coords` alongside the existing
  fields.
- **hits_landed_by_item** — the relay now tallies offensive hits by item (missile/goop/banana)
  alongside the existing `hits_landed` total, purely so `/stats` can report real missiles landed;
  results screens, awards and every other field are unchanged.

## Unreleased: lobby reliability pass (no version bump)

- **Courses on the server** — the vote draws from `RACE_COURSES_DIR` (the image snapshot, with the
  checkout mounted read-only over it), not from `runs`; startup fails on zero courses;
  `/health` reports `courses`; GO is refused with `no course selected`.
- **Deploy** — the image builds from the repo root (`-f race/server/Dockerfile`, root
  `.dockerignore`); `redeploy.sh` mounts `race/courses` read-only, refuses a missing or run-less
  `race.db` unless you pass `--allow-empty-db`, and polls `/health` for a non-empty catalog.
- **One socket per tab** — Relay/Hub detach handlers before closing; no auto-join under
  `LOBBY_V2`; Leave forgets the room; the loader replaces a different version and reuses the same
  one.
- **Old UI gone under the shell** — the floating lobby card and its confirm() force-start are
  never built; Alt+Y goes to the Gate; manual sync hides in a proto-5 room; persistent banner for
  a relay below proto 5.
- **Send path** — every lobby frame that cannot go out, every relay/hub refusal and every thrown
  handler becomes a toast; `fr-hidden` actually hides shell elements; typed chat renders (`from`);
  `join.client_proto`; a voting room can start (host picker always shown, start on one vote).
- **Start** — `start.course` (additive); the client loads and hash-checks it before arming,
  re-arms on the first pong, and logs the teleport method and the state before and after.
- **Fixes found on the way** — the Launch screen threw on every render (`launchRouteSvg`), and a
  blocked missile on someone else threw in `Items.onResolved`; both were hidden by a catch-all.
- **Away** is reachable (60 s with no input at the Gate reports `idle`).
- **Debug** — `CONFIG.DEBUG` / Alt+D overlay with a Test grid slot button.
- **Tests and docs** — `tools/smoke_lobby.py` (also run by pytest against a local uvicorn),
  `docs/ACCEPTANCE.md`, and PROTOCOL.md's no-bump-without-proof rule.
- **Auto-deploy** — `server/autodeploy.sh` polls `origin/deploy` from the Unraid box (no inbound
  access, no hosted runner), deploys only a commit whose GitHub check-runs already passed, tags
  `race:prev` before every build and rolls back to it on a failed health check. `GET /version`
  (`sha`/`version`/`proto`/`courses`/`started_at`, `sha` baked in at build time via a
  `GIT_SHA` build-arg) is how to confirm a deploy landed. See `DEPLOY_CHECKLIST.md` §8.

## 1.4.0

- **CI** — `.github/workflows/test.yml` runs the JS suite, the server pytest suite and ruff on
  every PR and on pushes to main (#5).
- **Mode registry, proto 6** — `MODES` (race asc, landing desc), `mode_runs` table,
  `GET /modes`, `POST /modes/{mode}/runs`, `GET /modes/{mode}/leaderboard`, `join.mode` /
  `joined.mode`; `migrate_modes.py` backfills `runs` additively and idempotently (#1).
- **Touchdown detector** — `race/touchdown.js`, a pure-function liftoff/touchdown/bounce/
  go_around/settled state machine; owns the sample and touchdown-event schema (#2). The
  touchdown event now also carries `lat`, `lon` and `heading_deg`.
- **probe.js "touchdown inputs"** — reports the GeoFS reads for AGL, vertical speed, ground
  contact and IAS (#4).
- **Server-side landing scoring** — `POST /landings` scores touchdown.js's raw event against
  `RUNWAYS` (three seed runways) and stores it as a `landing` mode run; client scores and client
  offsets are ignored; `GET /landing-leaderboard` (#3).
- **Touchdown recorder + replay** — `tools/recorder.js` bookmarklet and
  `tools/replay_landing.mjs` CLI (now also works on Windows paths) (#6).
- **redeploy.sh** — one-command Unraid redeploy: pull, SQLite backup, migrate, build, swap,
  poll; `--dry-run` (#8).
- **Audit** — `docs/AUDIT.md`, a dead-code and superseded-UI report; nothing in it is applied (#7).
