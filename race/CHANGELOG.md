# Changelog

All notable changes to FINSONLY Racing, newest first, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Versions are the client's
`CONFIG.VERSION`. The server reports its own `SERVER_VERSION` on `GET /version`. Details are in
[README.md](README.md), [PROTOCOL.md](PROTOCOL.md) and the [runbook](../docs/RUNBOOK.md). What still
needs the live sim is in [ACCEPTANCE.md](ACCEPTANCE.md). Dates are the day the change landed on
`main` (from git history).

Versions 0.1–1.3.1 predate this file. Their history is in git and in the per-feature notes of
[README.md](README.md) and [PROTOCOL.md](PROTOCOL.md).

## [Unreleased] — ui-unify, the 2026-09-24 content expansion, runway loader, deploy prune

No version bump until the ui-unify rows (UI1–UI4) and the 2026-09-24 rows (Course 1–10, Model 1,
Runway 1–3, Deploy 1–2, Lab G0–A1) in race/ACCEPTANCE.md pass in-sim. `race.js` is unchanged by the
2026-09-24 work, so the client needs no new `CONFIG` flags. The content reaches players through
`COURSE_BASE`/`MODEL_BASE`, and the server changes arrive with the next deploy.

### Added
- **Theme tokens:** `THEME_CSS` (`<style id="fr-theme">`) holds the sunset palette, type scale,
  spacing, radii, z-layers and motion as `--fr-*` vars on `.fr-ui`. Every stylesheet uses them. A
  test fails on a literal z-index, an off-scale font size or a stray color literal.
- **Flags:** `CONFIG.THEME_WEBFONT` (off: Saira Condensed from Google Fonts) and `CONFIG.SEASONS`
  (off: hides the Season tab).
- **tools/ui_gallery.html:** every surface on fixture data at 1366×768 and 1920×1080.
- **Courses: 15 → 69, in 17 cups of four** (2026-09-24). Alpine, Fjord, Canyon, KHABO, Pacific and
  Legends. Then Alaska, Aloha, Japan, China, Wonders, Aviation History, Pylon (unrolled multi-lap
  circuits) and Bush (ground starts, `aircraftId` still `null`). See `race/courses/CUPS.md`.
- **Runways: 3 → 26** (2026-09-24): a 16-runway world landing pack plus 7 bush strips
  (`race/runways/LANDING_CUPS.md`).
- **Joke planes: 6 → 12** (2026-09-24): rubber duck, cheese wedge, beer stein, pizza slice, flying
  couch, shopping cart, plus `models/preview.png`.
- **Server: runway loader** (2026-09-24). `app.py` reads `race/runways/` at startup
  (`RACE_RUNWAYS_DIR`, logs `runways loaded: N`) and falls back to the three embedded runways.
  The Dockerfile, compose snippet and both deploy scripts mount it. Existing runway boards keep
  their keys. `SERVER_VERSION` is not bumped.
- **Deploy: `prune.sh`** (2026-09-23). After a passing deploy (or a healthy autodeploy rollback) it
  runs `docker image prune -f` (dangling only) and keeps the 10 newest `race.db.bak-*`.
  `--no-prune` skips it. CI shellchecks it.
- **Tools** (2026-09-24): `design_course.py` (terrain-fitted courses, laps, ground starts),
  `add_runway.py` (OurAirports), `check_addons.py` + `race/addons.json` + `race/ADDONS.md` (six pinned
  third-party addons), `render_models_preview.py`, `add_course.py --cup/--difficulty`,
  `check_terrain.py --source auto|global` (Terrarium worldwide; `auto` is the new default). Physics
  Lab gains GRAPHICS, RUNWAYS and AIRCRAFT discovery sections.
- **Docs** (2026-09-24): `docs/RUNBOOK.md`, generated `docs/REFERENCE.md` (`race/tools/gen_docs.py`),
  `docs/README.md` index, a player-first root README, and the `race/docs/LAPS.md` and
  `race/docs/BUSH_MODE.md` designs.

### Changed
- **HUD:** every readout sits on one plate in a 4-corner grid with 16 px margins, with numbers in
  the num font. Toasts and the news card share a top-right stack under the feed. The reopen pill
  moves bottom-left and hides mid-run. **Alt+K** collapses/reopens the panel.
- **Rollback UI:** the classic panel and old lobby card live in a `LegacyUI` module that's only
  built when `LOBBY_V2` is off. The shell, results card and toasts fade/slide in and out.
- **Copy:** relay/ramp refusals and other system states read as plain sentences.
- **Seven courses repaired as version 2** (fresh boards): `dells-narrows`, `madison-isthmus`,
  `apostle-caves`, `devils-lake-bluffs`, `three-sisters`, `star-wars-canyon`, `cabo-lands-end`.
  The gates keep their lat/lon, and the altitudes are refitted to clear terrain.
- **Docs restructure:** `race/README.md` is a module guide. `race/server/DEPLOY_CHECKLIST.md` and
  `race/docs/ACCEPTANCE.md` are stubs pointing to the runbook and the merged `race/ACCEPTANCE.md`.
  This changelog uses Keep-a-Changelog headings.

### Removed
- `#fr-shell`'s navy/amber palette and the per-panel var copies.

### Fixed
- The Launch course facts and the rollback lobby card no longer print a stray "null". The
  end-of-race banner no longer covers the results table.

## [1.7.0] — 2026-09-23 — rolling start, rebuilt Boost, GeoPhysics

Rebuilt airstart, teleport and Boost on the GeoFS APIs verified in-sim on 2026-09-23: `place()`,
`rigidBody.v_linearVelocity`/`setLinearVelocity`, `geofs.autopilot.*` and
`controls.setters.increaseThrottle`.

### Added
- **GeoPhysics** (in `race.js`, no new file, per the single-file rule): the one place GeoFS physics
  is touched. It covers `placeAircraft`, `getVelocityENU`/`setVelocityENU`, `addSpeedAlongPath`,
  the autopilot calls and the throttle read/press. SI units in, kt/ft conversion inside, and every
  write is logged.
- **Formation:** pure holding-pattern geometry (the oval, slot targets, along-track error, the
  speed P-controller, start-line crossing, terrain-margin altitude), with no GeoFS dependency.
- **Rolling start (relay proto 8):** a new room phase, `formation`, between `lobby` and `racing`.
  It's offered only on an air-start course with `rules.rolling` on, when every racer's connection
  proves proto 8.
  - Server: `formation`/`formation_drop` frames and ready-order slots. A late `ready` joins at the
    back, and `formation_drop` fires on an unexpected autopilot-off.
  - Client: places each pilot in the oval and engages the autopilot, steers at
    `CONFIG.FORMATION_STEER_HZ`, then disengages and checks the throttle at the synced green. It
    falls straight through to the existing grid against an older relay, a ground start, or
    `rules.rolling` off.
- Tests: GeoPhysics unit conversions and write paths, Formation's pure geometry (numeric-derivative
  heading check, slot spacing, controller convergence, terrain clearance), the server FORMATION
  phase (8 new server tests), and the client wiring against the existing GeoFS mock (6 new tests).
  That's 252 pytest, with the full JS suite green.

### Changed
- **Boost rewritten:** `GeoPhysics.addSpeedAlongPath`, ramped +50 m/s over 1.0 s in 10 steps,
  capped at `CONFIG.BOOST_MAX_KT`. It never stacks. The missile speed penalty (off by default) is
  the same adapter with a negative delta, floored.
- **Fly to start** now uses `GeoPhysics.placeAircraft`: one call, arriving already flying at
  `CONFIG.PACE_KT`.

### Removed
- `resetFlight`, direct `trueAirSpeed`/`groundSpeed` writes and thrust multipliers (confirmed
  broken), along with `CONFIG.VELOCITY_FRAME`/`SAFE_WRITES`/`BOOST_LLA_FALLBACK`.

## [1.6.0] — 2026-09-23 — rename, HUD timer fix, classic-panel migration

### Added
- **Callsign rename (proto 7):** a `rename` frame lets a pilot change their room-visible callsign
  at any time, including mid-race, from the top-bar chip (every screen) or the Settings tab. The
  room re-keys presence, host, votes, live bananas and (mid-race) standings under the new name and
  broadcasts `renamed`. Identity stays `pilot_id`/`pilot_token`. A rename also re-presents the
  hub's `hello` handshake, so ghosts, seasons and leaderboards resolve to the new name for past runs
  too, by `pilot_id`, at read time. An old relay just never receives the frame.

### Changed
- **Classic panel retired from the shipped client:** under the default `CONFIG.LOBBY_V2`, the old
  `#fr-root` settings panel is no longer built at all. It only ever showed on the Solo tab,
  duplicating the new HUD/shell. Its unique controls moved into the shell, reusing the exact same
  elements and handlers:
  - course-scoped, on Solo: leaderboard + callsign, the ghost/rival pickers, the course editor, and
    the manual-sync countdown fallback
  - account-scoped, on a new Settings tab: Your plane, Sound and the Powerups loadout

  `#fr-root` itself is unchanged and still boots as the primary UI under the
  `CONFIG.LOBBY_V2 = false` rollback.

### Fixed
- **HUD/timer legibility:** the race clock (`#fr-hud-timer`, `#fr-timer`) no longer inherits a
  `text-shadow` onto its gradient-clipped fill (the "smeared shadow" bug). Both now sit on a solid
  dark pill in a solid color, with an explicit system-font fallback stack and tabular numerals, so
  they stay legible even if a page font is blocked.

## [1.5.0] — 2026-09-23 — race.finsonly.net redesign

### Added
- **New read-only endpoints:** `GET /stats` (races/pilots/gates/missiles_hit), `GET /rooms/live`
  (live rooms, never a join code or pilot_token), `GET /courses/catalog` (every course, raced or
  not, for the per-cup tabs) and `GET /bookmarklet`. All are cached a few seconds in memory and
  rate-limited per IP (`RACE_GET_MIN_INTERVAL_S`).
- **Course metadata:** `race/courses/index.json` entries carry `cup`/`difficulty`. `GET /courses`
  and `/courses/catalog` add `cup`/`difficulty`/`length_km`/`gate_coords` alongside the existing
  fields.
- **hits_landed_by_item:** the relay now tallies offensive hits by item (missile/goop/banana)
  alongside the existing `hits_landed` total, purely so `/stats` can report real missiles landed.
  Results screens, awards and every other field are unchanged.

### Changed
- **Public site rebuilt** as `race/server/static/{index.html,site.css,site.js}`: plain static
  files (`StaticFiles(html=True)` answers `/`) replacing the old inline-HTML page. It has a hero
  record replay (an animated ghost trace over an SVG route map), a live departures board, per-cup
  course records with mini route maps, recent races and open cups, and a real draggable bookmarklet
  built from `race/bookmarklet.txt` at server start. Google Fonts (Saira/Saira Condensed) is the one
  allowed external request. The CSP is `script-src 'self'` (no inline script at all, tighter than
  before). Every section has a loading skeleton, an empty state and an error state, and times out
  at 8 s.

## Lobby reliability pass — 2026-09-23 (no version bump)

Landed between 1.4.0 and 1.5.0. It was listed as "Unreleased" at the time.

### Added
- **Auto-deploy:** `server/autodeploy.sh` polls `origin/deploy` from the Unraid box (no inbound
  access, no hosted runner), deploys only a commit whose GitHub check-runs already passed, tags
  `race:prev` before every build and rolls back to it on a failed health check. `GET /version`
  (`sha`/`version`/`proto`/`courses`/`started_at`, with `sha` baked in at build time via a
  `GIT_SHA` build-arg) is how to confirm a deploy landed. See the
  [runbook](../docs/RUNBOOK.md#autodeploy) (formerly `DEPLOY_CHECKLIST.md` §8).
- **Debug:** the `CONFIG.DEBUG` / Alt+D overlay, with a Test grid slot button.
- **Tests and docs:** `tools/smoke_lobby.py` (also run by pytest against a local uvicorn), the lobby
  acceptance checklist (now the `LB` rows of `ACCEPTANCE.md`), and PROTOCOL.md's
  no-bump-without-proof rule.

### Changed
- **Courses on the server:** the vote draws from `RACE_COURSES_DIR` (the image snapshot, with the
  checkout mounted read-only over it), not from `runs`. Startup fails on zero courses. `/health`
  reports `courses`. GO is refused with `no course selected`.
- **Deploy:** the image builds from the repo root (`-f race/server/Dockerfile`, root
  `.dockerignore`). `redeploy.sh` mounts `race/courses` read-only, refuses a missing or run-less
  `race.db` unless you pass `--allow-empty-db`, and polls `/health` for a non-empty catalog.
- **One socket per tab:** Relay and Hub detach their handlers before closing. There's no auto-join
  under `LOBBY_V2`. Leave forgets the room. The loader replaces a different version and reuses the
  same one.
- **Old UI gone under the shell:** the floating lobby card and its confirm() force-start are never
  built. Alt+Y goes to the Gate. Manual sync hides in a proto-5 room. A relay below proto 5 gets a
  persistent banner.
- **Send path:** every lobby frame that can't go out, every relay/hub refusal and every thrown
  handler becomes a toast. `fr-hidden` actually hides shell elements. Typed chat renders (`from`).
  `join.client_proto` is sent. A voting room can start (the host picker is always shown, and it
  starts on one vote).
- **Start:** `start.course` (additive). The client loads and hash-checks the course before arming,
  re-arms on the first pong, and logs the teleport method and the state before and after.
- **Away** is reachable: 60 s with no input at the Gate reports `idle`.

### Fixed
- The Launch screen threw on every render (`launchRouteSvg`), and a blocked missile on someone
  else threw in `Items.onResolved`. A catch-all had hidden both.

## [1.4.0] — 2026-09-23

### Added
- **CI:** `.github/workflows/test.yml` runs the JS suite, the server pytest suite and ruff on every
  PR and on pushes to main (#5).
- **Mode registry, proto 6:** `MODES` (race asc, landing desc), the `mode_runs` table,
  `GET /modes`, `POST /modes/{mode}/runs`, `GET /modes/{mode}/leaderboard`, and `join.mode` /
  `joined.mode`. `migrate_modes.py` backfills `runs` additively and idempotently (#1).
- **Touchdown detector:** `race/touchdown.js`, a pure-function liftoff/touchdown/bounce/
  go_around/settled state machine that owns the sample and touchdown-event schema (#2). The
  touchdown event now also carries `lat`, `lon` and `heading_deg`.
- **probe.js "touchdown inputs":** reports the GeoFS reads for AGL, vertical speed, ground contact
  and IAS (#4).
- **Server-side landing scoring:** `POST /landings` scores touchdown.js's raw event against
  `RUNWAYS` (three seed runways) and stores it as a `landing` mode run. Client scores and client
  offsets are ignored. Also `GET /landing-leaderboard` (#3).
- **Touchdown recorder + replay:** the `tools/recorder.js` bookmarklet and the
  `tools/replay_landing.mjs` CLI (which now also works on Windows paths) (#6).
- **redeploy.sh:** a one-command Unraid redeploy (pull, SQLite backup, migrate, build, swap, poll)
  with `--dry-run` (#8).
- **Audit:** `docs/AUDIT.md`, a dead-code and superseded-UI report. Nothing in it was applied (#7).

