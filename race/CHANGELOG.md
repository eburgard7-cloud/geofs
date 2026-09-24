# Changelog

One line per shipped item. Details live in README.md, PROTOCOL.md and server/DEPLOY_CHECKLIST.md;
what still needs the live sim is in ACCEPTANCE.md.

## Unreleased (ui-unify): one visual system

No version bump until race/ACCEPTANCE.md's ui-unify rows pass in-sim.

- **Theme tokens** — `THEME_CSS` (`<style id="fr-theme">`): the sunset palette, type scale,
  spacing, radii, z-layers and motion as `--fr-*` vars on `.fr-ui`. Every stylesheet uses them;
  `#fr-shell`'s navy/amber palette and the per-panel var copies are gone. A test fails on a
  literal z-index, an off-scale font size or a stray color literal.
- **HUD** — every readout on one plate in a 4-corner grid with 16 px margins; numbers in the num
  font. Toasts and the news card share a top-right stack under the feed. The reopen pill moves
  bottom-left and hides mid-run; **Alt+K** collapses/reopens the panel.
- **Rollback UI** — the classic panel and old lobby card live in a `LegacyUI` module that is only
  built when `LOBBY_V2` is off. The shell, results card and toasts fade/slide in and out.
- **Flags** — `CONFIG.THEME_WEBFONT` (off: Saira Condensed from Google Fonts),
  `CONFIG.SEASONS` (off: hides the Season tab).
- **Copy** — relay/ramp refusals and other system states read as plain sentences.
- **Fixes** — the Launch course facts and the rollback lobby card no longer print a stray
  "null"; the end-of-race banner no longer covers the results table.
- **tools/ui_gallery.html** — every surface on fixture data at 1366×768 and 1920×1080.

## 1.7.0: rolling start, rebuilt Boost, GeoPhysics

Rebuilt airstart/teleport/Boost on the GeoFS APIs verified in-sim on 2026-09-23 — `place()`,
`rigidBody.v_linearVelocity`/`setLinearVelocity`, `geofs.autopilot.*`, `controls.setters.
increaseThrottle`. `resetFlight`, direct `trueAirSpeed`/`groundSpeed` writes and thrust
multipliers are confirmed broken and removed, along with `CONFIG.VELOCITY_FRAME`/`SAFE_WRITES`/
`BOOST_LLA_FALLBACK`.

- **GeoPhysics** (`race.js`, no new file — single-file rule) — the one place GeoFS physics is
  touched: `placeAircraft`, `getVelocityENU`/`setVelocityENU`, `addSpeedAlongPath`, the autopilot
  calls, the throttle read/press. SI units in, kt/ft conversion inside. Every write logged.
- **Formation** — pure holding-pattern geometry (the oval, slot targets, along-track error, the
  speed P-controller, start-line crossing, terrain-margin altitude), no GeoFS dependency.
- **Rolling start (relay proto 8)** — new room phase `formation` between `lobby` and `racing`,
  offered only when every racer's connection proves proto 8 on an air-start course with
  `rules.rolling` on. Server: `formation`/`formation_drop` frames, ready-order slots, a late
  `ready` joins at the back, `formation_drop` on an unexpected autopilot-off. Client: places and
  engages the autopilot into the oval, steers at `CONFIG.FORMATION_STEER_HZ`, disengages and
  checks the throttle at the synced green, falls straight through to the existing grid against
  an older relay/ground start/`rules.rolling` off.
- **Boost rewritten**: `GeoPhysics.addSpeedAlongPath`, ramped +50 m/s over 1.0 s in 10 steps,
  capped at `CONFIG.BOOST_MAX_KT`, never stacks. The missile speed penalty (off by default) is
  the same adapter with a negative delta, floored.
- **Fly to start** now uses `GeoPhysics.placeAircraft` — one call, arrives already flying at
  `CONFIG.PACE_KT`.
- Tests: GeoPhysics unit conversions and write paths, Formation's pure geometry (numeric-
  derivative heading check, slot spacing, controller convergence, terrain clearance), the server
  FORMATION phase (8 new server tests), and the client wiring against the existing GeoFS mock
  (6 new tests) — 252 pytest, full JS suite green.

## 1.6.0: rename, HUD timer fix, classic-panel migration

- **Callsign rename (proto 7)** — a `rename` frame lets a pilot change their room-visible
  callsign at any time, including mid-race, from the top-bar chip (every screen) or the Settings
  tab. The room re-keys presence, host, votes, live bananas and (mid-race) standings under the
  new name and broadcasts `renamed`. Identity stays `pilot_id`/`pilot_token`; a rename also
  re-presents the hub's `hello` handshake, so ghosts/seasons/leaderboards resolve to the new name
  for past runs too, by `pilot_id`, at read time. An old relay just never receives the frame.
- **HUD/timer legibility fix** — the race clock (`#fr-hud-timer`, `#fr-timer`) no longer inherits
  a `text-shadow` onto its gradient-clipped fill (the "smeared shadow" bug); both now sit on a
  solid dark pill, in a solid color, with an explicit system-font fallback stack and tabular
  numerals, so they stay legible even if a page font is blocked.
- **Classic panel retired from the shipped client** — under the default `CONFIG.LOBBY_V2`, the
  old `#fr-root` settings panel is no longer built at all (it only ever showed on the Solo tab,
  duplicating the new HUD/shell). Its unique controls — leaderboard + callsign, ghost/rival
  pickers, the course editor and the manual-sync countdown fallback (course-scoped, on Solo) and
  Your plane / Sound / the Powerups loadout (account-scoped, on a new Settings tab) — moved into
  the shell, reusing the exact same elements and handlers. `#fr-root` itself is unchanged and
  still boots as the primary UI under the `CONFIG.LOBBY_V2 = false` rollback.

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
