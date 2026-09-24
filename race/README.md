# race/ module guide

What each piece of FINSONLY Racing does and how the pieces talk to each other. To *play*, start at
the [root README](../README.md). To *run* anything (race night, content, release, deploy), use the
[runbook](../docs/RUNBOOK.md). Hotkeys, `CONFIG` flags, endpoints and env vars are generated from
the code into [docs/REFERENCE.md](../docs/REFERENCE.md). The wire protocol is
[PROTOCOL.md](PROTOCOL.md).

## Files

```text
race/
  race.js                 the whole client: one file, no build step, no dependencies
  bookmarklet.txt         PRIMARY, COMBINED, FALLBACK, COMBINED FALLBACK, PROBE, RECORDER, LAB lines
  touchdown.js            pure touchdown detector (liftoff/touchdown/bounce/go_around/settled); not wired into race.js
  courses/                shared courses (*.json), index.json (with cup/difficulty), CUPS.md (17 cups, terrain status)
  models/                 joke-plane *.glb, index.json (id, file, scale, offsets), assignments.json (callsign → id), preview.png
  runways/                landing-mode runway defs + index.json, loaded by server/app.py at startup (RACE_RUNWAYS_DIR;
                          embedded three as fallback); LANDING_CUPS.md groups them
  addons.json             third-party GeoFS addons pinned by commit SHA (checked by tools/check_addons.py)
  ADDONS.md               what each pinned addon does, its hotkeys and license status
  server/
    app.py                FastAPI: REST API, the race relay (/ws/race/{room}) and the hub (/ws/hub)
    migrate_modes.py      proto 6: creates mode_runs and backfills it from runs (additive, idempotent)
    static/               the public site at race.finsonly.net/ (index.html, site.css, site.js)
    Dockerfile            builds from the REPO ROOT: bakes in app.py, static/, bookmarklet.txt, courses/, runways/
    redeploy.sh           one-command Unraid redeploy: pull, check + back up race.db, migrate, build, swap, poll,
                          prune on PASS (--dry-run, --allow-empty-db, --no-prune; see the runbook)
    prune.sh              sourced by both deploy scripts: after a PASS, prune dangling images + keep the 10 newest race.db backups
    autodeploy.sh         5-minute cron: deploy a CI-passed origin/deploy via redeploy.sh, roll back on failure
    compose.snippet.yml   Compose service block (scp layout)
    Caddyfile.snippet     Caddy site block (no Authelia)
    DEPLOY_CHECKLIST.md   stub: moved to docs/RUNBOOK.md
  test/
    run.js                headless JS suite (jsdom + a mocked GeoFS/Cesium)
    test_server.py        API, relay and hub tests (also runs tools/smoke_lobby.py against local uvicorn)
    test_add_course.py    add_course.py validation and index upsert
    test_check_terrain.py check_terrain.py geometry, findings, CLI and decoder (offline)
    test_models.py        build_models.py output (valid glb, size, ~15 m length)
    test_models_pack.py   the committed models: glTF header, no textures, size/triangle caps, extents, centroid, preview.png
    test_check_terrain_global.py  the Terrarium source: PNG decoder, tile math, auto routing (offline fixtures)
    test_design_course.py design_course.py altitude fitting, laps, ground starts
    test_add_runway.py    add_runway.py against fixture CSVs, plus the pinned runway_hash table
    test_check_addons.py  check_addons.py schema, SHA and hotkey-collision checks
    test_gen_docs.py      docs/REFERENCE.md is up to date; gen_docs.py parsers
    course_hashes.json    every shared course's hash, asserted by run.js AND test_server.py
  tools/
    add_course.py         validate a pasted course JSON, write it and upsert courses/index.json (--cup, --difficulty)
    design_course.py      waypoints → terrain-fitted course (valley snapping, boxes, laps, ground starts, preview PNG)
    add_runway.py         add one runway end to runways/ from OurAirports data
    check_terrain.py      sample terrain along a course (auto = USGS 3DEP in CONUS + Terrarium elsewhere, Cesium ion, or a file)
    build_models.py       generate models/*.glb and models/index.json
    render_models_preview.py  redraw models/preview.png (needs matplotlib)
    check_addons.py       validate addons.json: schema, pinned SHAs, hotkey collisions with race.js
    gen_docs.py           generate docs/REFERENCE.md (--check for CI-style staleness checks)
    smoke_lobby.py        2–3 scripted pilots through a throwaway room (12 steps)
    hub_smoke.py          the same for the hub socket: identity, presence, ping the ramp
    probe.js              read-only GeoFS/Cesium internals report (PROBE line)
    physics_lab.js        WRITE-capable test panel for GeoFS physics, plus GRAPHICS / RUNWAYS / AIRCRAFT discovery (LAB line; debug only)
    terrain_probe.js      read-only check of a course against the terrain GeoFS renders
    recorder.js           20 Hz landing capture in touchdown.js's input shape (RECORDER line, Alt+T)
    replay_landing.mjs    CLI: run touchdown.js over a recording; sample_*.json are a worked example
    ui_gallery.html       every UI surface on fixture data, no sim needed
  docs/
    AUDIT.md              historical dead-code / superseded-UI audit (2026-09-23)
    ACCEPTANCE.md         stub: merged into race/ACCEPTANCE.md
    LAPS.md               design: native `laps` for circuit courses (not built yet)
    BUSH_MODE.md          design: bush mode with runway stops (not built yet)
  ACCEPTANCE.md           the in-sim checklist (everything the test suites can't settle)
  PROTOCOL.md             the relay and hub wire protocol, proto 1–8, checked against app.py
  CHANGELOG.md            what shipped, per version
```

## How the pieces talk

```text
geo-fs.com tab
  bookmarklet ──fetch──▶ race.js (raw.githubusercontent main, or jsDelivr @tag for FALLBACK)
    race.js ──GET──▶ COURSE_BASE (courses/index.json + files), MODEL_BASE (models, assignments)
    race.js ──HTTPS──▶ API_BASE: POST /runs, /leaderboard, /ghost(s), /news, …
    race.js ──WSS──▶ API_BASE /ws/hub          identity, presence, room list, ping the ramp
    race.js ──WSS──▶ API_BASE /ws/race/{room}  lobby, items, results, chat, vote, rename, formation
race.finsonly.net (Caddy → FastAPI in Docker on Unraid)
  app.py ──▶ SQLite race.db: runs, traces, races, race_results, cups, mode_runs, pilots
  app.py ──▶ in-memory: rooms, presence, room registry, votes, chat (never persisted)
```

The client works with **no server at all** (Solo: timing, ghosts from `localStorage`, loadout
Boost/Shield). Every relay-dependent feature is gated on the `proto` the relay reports in `joined`
and falls back with one status-line note (see PROTOCOL.md "Versioning").

## Inside race.js

One IIFE, top to bottom. Every GeoFS/Cesium internal is touched only in `G`, `GeoPhysics` or a
`make*Layer` factory. Those fail closed, so a GeoFS update never throws into the race loop.

| Module | Job |
|---|---|
| `CONFIG` | Every flag and constant (generated table: [REFERENCE.md#config](../docs/REFERENCE.md#config)) |
| instance guard | One client per tab: the same version re-shows the panel, and a different version tears the old one down first |
| `G` | The GeoFS/Cesium read adapter: position, heading, speed, pause, viewer, Leaflet map, multiplayer users, screen projection |
| `makeGeoPhysics` / `GeoPhysics` | The **only** aircraft writes, built on the calls verified in-sim on 2026-09-23 (see below). SI units in, kt/ft conversion inside, every write logged to the debug overlay |
| `Course` | Normalize a course (whitelisted fields, ≤ 24 item boxes), hash it (FNV-1a over gate geometry + aircraft lock; boxes excluded), length |
| `makeGateLayer` / `makeBoxLayer` / `makeItemLayer` | World-space rendering of gates, item boxes and items (entity budget + TTL) |
| `CourseMap` | Gates and route on GeoFS's Leaflet nav map (`COURSE_MAP`) |
| `Race` | The engine: start on leaving the start sphere, interpolated gate crossings, splits, pause exclusion, DQs, the gate-1 clock (`elapsed`) and the lobby clock (`goElapsed`) |
| `Countdown` | Arms a countdown against a target time (used by the lobby's synced start) |
| `FlyToStart` | Solo air start: `GeoPhysics.placeAircraft` onto gate 1, facing gate 2, at `PACE_KT` |
| `formation*` functions | Pure rolling-start geometry: holding-pattern oval, slot targets, along-track error, speed P-controller, start-line crossing, terrain-margin altitude |
| `Debug` | The Alt+D overlay and log |
| `Relay` | The `/ws/race/{room}` socket: reconnect with backoff, the proto gate |
| `Lobby` | Room state (`lobbyReduce`), clock offset (min-RTT `ping`/`pong`), ready/course/rules/start/abort/cup/rematch, grid slots, formation steering |
| `Hub` | The `/ws/hub` socket: identity (`pilot_id`/`pilot_token`), presence, rooms, ramp pings |
| `Results` | `finish`/`dnf` frames, the shared results card, points, awards, cup standings, the record badge |
| `Powerups` / `Items` / `Shake` | Loadout and box slot, Boost/Shield/penalty, world items (projectiles, bananas, boxes), the hit shake |
| `Sfx` | WebAudio-synthesized sounds (no sample files) |
| `Best` / `TraceStore` / `Recorder` / `LB` / `Courses` | Personal bests, local ghost traces (LRU), trace recording, leaderboard client, the course list |
| `ModelSwap` / `makeGhostLayer` / `Ghost` / `RivalGhosts` / `News` | Joke-plane rendering, ghosts, rival ghosts, the "someone beat your time" banner |
| `makeLineLayer` / `LineRenderer` / `Minimap` | Racing line, minimap |
| `Shell` | The shipped panel (`LOBBY_V2`): Ramp, Gate, Launch, Solo, Courses and Settings tabs, collapse/auto-collapse, toasts |
| `UI` / `Hud` / `Editor` | Status and banners, the full-viewport HUD, the course editor |
| `LegacyUI` | The rollback panel and floating lobby card, built only when `LOBBY_V2` is off |
| `window.__finsRace` | Every module plus `_internals` (the pure helpers `test/run.js` drives) |

## Rules the engine enforces

- **Start:** the clock starts when you *leave* the start sphere, so standing and flying starts both
  work. Repositioning before the start never starts the clock.
- **Gates** count in order, on first contact with the sphere, interpolated within the frame, so
  fast or low-fps flyers can't tunnel through. **Finish** is first contact with the last sphere.
- **Pause** doesn't count. Moving more than `PAUSE_MOVE_TOLERANCE_M` (50 m) while paused is a DQ.
- **Speed limit:** faster than `MAX_SPEED_MS` (700 m/s, ~1360 kt) between samples is a DQ. That
  catches teleports and slews.
- **Aircraft lock:** a course can require one aircraft id. Anyone else is DQ'd at the start.
- **Course identity:** personal bests and the leaderboard are keyed by the course hash. Renaming
  keeps the times, and moving a gate starts a fresh board.
- **Not caught:** slow slew-mode cheating under the speed limit. That's the honor system.
- **Wall-clock timing:** alt-tabbed time counts against you (wall time minus pauses). It can only
  ever penalize.

## Course format

```json
{
  "id": "steve-sprint",
  "name": "Steve Sprint",
  "version": 1,
  "aircraftId": null,
  "startType": "ground",
  "itemBoxes": [ { "lat": 45.57, "lon": -122.61, "alt": 1200, "radius": 110 } ],
  "gates": [ { "lat": 45.58, "lon": -122.6, "alt": 1200, "radius": 150 } ]
}
```

- `alt` is metres, the same as GeoFS's `llaLocation[2]`. `ALT_OFFSET_M` only moves the visuals.
- `startType` is `"ground"` (the default) or `"air"` (gate 1 is mid-air, so use **Fly to start**, or
  the grid/rolling start in a room).
- `itemBoxes` is optional (≤ 24) and outside the hash. A pre-0.10.0 single `itemBox` is still read
  as a one-element list. Setting both keys is an error.
- Any other field is silently dropped, so course notes go in [courses/CUPS.md](courses/CUPS.md).
- Adding or changing a course is a runbook task:
  [Content → Add a course](../docs/RUNBOOK.md#add-a-course).

## Writing to the aircraft (GeoPhysics)

Boost, the missile speed penalty, Fly to start, the grid and the rolling start all write through
`GeoPhysics`, using only these calls, verified in-sim on 2026-09-23:

| Call | Used for |
|---|---|
| `geofs.aircraft.instance.place([lat, lon, altM], [hdg, 0, 0])` | every teleport |
| `rigidBody.v_linearVelocity` (read) / `rigidBody.setLinearVelocity([east, north, up])` (m/s, local ENU) | Boost, the speed penalty, arriving at a teleport already flying |
| `geofs.autopilot.setSpeed(kt)` / `setAltitude(ft)` / `setCourse(deg)` / `turnOn()` / `turnOff()` | the rolling start's pace lap |
| `controls.setters.increaseThrottle` (the only throttle write) | the green-flag throttle check |

**Verified broken and gone:** `geofs.resetFlight()` / `lastFlightCoordinates`, direct
`trueAirSpeed`/`groundSpeed` writes, and engine thrust multipliers. So are the flags that gated
them (`VELOCITY_FRAME`, `SAFE_WRITES`, `BOOST_LLA_FALLBACK`). Every speed write stays under
`MAX_SPEED_MS` minus `SPEED_WRITE_MARGIN_MS`. **No control writes:** `POWERUP_CONTROL_EFFECTS` stays
`false`, so offensive items are screen effects only.

- **Boost:** `GeoPhysics.addSpeedAlongPath(+POWERUP_BOOST_ADD_MS)` (50 m/s), ramped over
  `BOOST_RAMP_MS` (1 s) in `BOOST_RAMP_STEPS` (10), capped at `BOOST_MAX_KT` (650). It never stacks.
  The trail shows for `POWERUP_BOOST_MS` (4 s).
- **Speed penalty** (`POWERUP_SPEED_PENALTY`, off by default): the same call with a negative delta,
  to `max(speed × 0.75, PENALTY_FLOOR_MS)` for `PENALTY_MS`. It never applies below
  `PENALTY_MIN_AGL_M` and is cancelled by a Boost.
- **Rolling start** (proto 8, `ROLLING_START`): slots in ready order, a holding-pattern oval behind
  gate 1 (`OVAL_LEG_M` legs, standard-rate turns), steered at `FORMATION_STEER_HZ` within pace ±
  `FORMATION_SPEED_CLAMP_KT`. The leader exits `FORMATION_EXIT_S` before green, with
  `FORMATION_GAP_S` between slots. The autopilot found off → `formation_drop` (back of the order, no
  DQ). At green: autopilot off, then `increaseThrottle` until the throttle clears 90%.

## Powerups and items

- **Loadout** (no server needed): two picks from Boost and Shield, refilled on every re-arm, on
  **Alt+1** / **Alt+2**.
- **Item boxes** (relay proto 3): contested. The first pilot through takes the box, and it's dark
  for everyone for `BOX_RESPAWN_MS` (6 s). The relay rolls the item, weighted by live rank
  (`weights_for_rank()` in `app.py`, three anchor tables interpolated), and the slot spins for
  `BOX_ROLL_MS` before **Alt+3** can fire it:

  | Your position | nothing | banana | goop | boost | missile |
  |---|---|---|---|---|---|
  | Leader | 30 | 45 | 15 | 10 | 0 |
  | Midfield | 5 | 20 | 25 | 30 | 20 |
  | Last place | 0 | 10 | 15 | 35 | 40 |

  A solo racer counts as the leader. The expected value rises strictly from leader to last
  (`test_roll_item_weighting_favors_the_back_of_the_pack`).
- **Relay-adjudicated:** the relay rolls, targets, times the projectile (distance ÷ 250 m/s,
  clamped: missile 1.5–4 s, goop 1–3 s), and checks Shield **at resolution**. The client only says
  "I crossed that box", "I fired what you gave me" and "I flew into that banana". The last one is
  checked against the pilot's own last `pos`. Banana trips are detected client-side, per frame in
  3D, because 2 Hz position pings would tunnel through at race speed.
- **Without the relay:** loadout-only. Boxes and offensive items are off, the client reconnects with
  backoff, and the race itself is never affected.
- Player-facing descriptions are in the [root README](../README.md#powerups). Frame details are in
  [PROTOCOL.md](PROTOCOL.md) (proto 1 and 3).

## Lobby, results and cups

- **The shell** (`LOBBY_V2`, on by default): **Ramp** (the hub's room list, Quick Match, ping the
  ramp), **Gate** (vote, pilot grid, ready, chat, host course pick, Start anyway, invite link),
  **Launch** (countdown, grid or formation), plus **Solo**, **Courses** and **Settings**.
  `LOBBY_V2: false` restores the classic panel and floating lobby card (`LegacyUI`) as a rollback.
- **Start:** ready gating with auto-start about 3 s after every engaged pilot is ready. An idle
  pilot (60 s) shows as Away and doesn't block. A forced start makes stragglers spectators. The
  start time comes from the relay's clock, and each client converts it with its own min-RTT offset.
- **Two clocks:** the leaderboard's gate-1 clock (`POST /runs`) and the lobby clock from the synced
  GO (`finish` frames, plus the `JUMP_START_PENALTY_MS` jump-start penalty). Course records stay
  comparable whether or not a run came from a lobby.
- **Results** (proto 4): the race ends when every racer has a result, or `RESULTS_TIMEOUT_S` (120 s)
  after the first finish. Points 15-12-10-8-6-4-2-1. Awards: most hits taken, sharpshooter,
  biggest comeback, fastest sector, clean race, jump starter. Finished races and cups are written to
  SQLite once.
- **Cups:** the host names one and picks 1–12 races. The shipped shell has no Start cup button yet
  (AUDIT B2). See [runbook → Race night](../docs/RUNBOOK.md#rules-cups-and-the-rolling-start).
- **Hub** (proto 5): identity owned by `pilot_id` (only the token's sha256 is stored), presence and
  the room registry in memory (rooms keep their code and host for 10 minutes after emptying), ramp
  pings (3 a day, reset at midnight UTC-7), free-text chat (240 chars, never stored), spectating,
  and the course vote (weighted toward courses the room has flown least).
- **Rename** (proto 7): a live callsign change, re-keyed across the room.

## Ghosts, racing line, bracket and minimap

- **Traces:** `[t, lat, lon, alt, heading, pitch, roll]` at `TRACE_HZ` (4 Hz) from your gate-1
  crossing, quantized, capped at `TRACE_MAX_SAMPLES` (6000, 25 min). A truncated, DQ'd or reset run
  is never saved. A finish saves only a personal best, to `localStorage` (LRU, `TRACE_MAX_COURSES`),
  and uploads it with `POST /runs`. The server validates the trace separately and drops a bad one
  with a reason rather than rejecting the run.
- **Ghosts:** a primary pick (Off / My best / Course record / a pilot), plus up to
  `RIVAL_GHOSTS_MAX − 1` rival ghosts (adds *Next one up*), each at `GHOST_ALPHA`. The fallback chain
  is its model, then the goldfish, then a point. Ghosts are never registered as multiplayer users.
- **Challenge link:** `?course=<id>&ghost=<callsign>[,…]`. **News:** `GET /news` on load shows a
  banner when someone has beaten one of your times.
- **Racing line:** the primary ghost's path `LINE_AHEAD_M` ahead, rebuilt at `LINE_REBUILD_HZ`.
  Green means ahead, amber means within ±`LINE_DELTA_BAND_MS`, red means behind. With no trace, it
  draws a dashed Catmull-Rom *suggested line* through the gate centres.
- **Waypoint bracket** over the next gate (an edge chevron when it's off-screen), updated every
  frame. **Minimap** north-up in the bottom-right, at `MINIMAP_HZ`.

## Landing mode (server-side only)

`score_touchdown()` in `server/app.py` turns `touchdown.js`'s raw `touchdown` event, plus the bounce
count and settled rollout, into a 0–1000 score against a runway from `RUNWAYS` (loaded from
`race/runways/` at startup, 26 today; see [LANDING_CUPS.md](runways/LANDING_CUPS.md)). It penalizes
vertical speed (the dominant term), centerline offset, distance from the touchdown zone, bank and
crab, bounces and rollout. Each penalty is capped on its own, and all the constants are in one
`LANDING_*` block. `POST /landings` scores and stores an attempt as a `landing` mode run and ignores
any client-sent score. `GET /landing-leaderboard?runway_id=` reads a board. There's no in-sim client
yet. `tools/recorder.js` + `tools/replay_landing.mjs` exercise `touchdown.js` against real
landings, and recorder.js's `FIELD_MAP` is still unverified `TODO-PROBE` placeholders.
A future *bush mode* (fly a course with required runway stops) builds on this; its design is in
[docs/BUSH_MODE.md](docs/BUSH_MODE.md).

## Model swaps

Every racer flies the stock F-16. A joke model is only *rendered* (`ModelSwap`): the stock
aircraft's `object3d` and each of its `_children` are hidden via `.visible`, and other pilots
(global `multiplayer.users`, positioned from `user.lastUpdate.co`) are re-hidden every frame. It
uses `Cesium.Model.fromGltf` (the build GeoFS ships has no `fromGltfAsync`). Still unconfirmed:
`co[4]`/`co[5]` as pitch/roll, and cockpit-view hiding. A wrong guess means "flying stock" plus a
status line, never a broken race.

## UI theme

Every surface uses the `--fr-*` tokens in `THEME_CSS`, scoped to `.fr-ui`. The type scale is
11/12/14/16/20/28/40/72 px, with nothing under 12 px in the HUD. A `test/run.js` check fails on a
literal z-index, an off-scale font size or a stray color literal. `THEME_WEBFONT` (off) would load
Saira Condensed. The shipped look is the Bahnschrift fallback. Review layouts in
`tools/ui_gallery.html` (see the [runbook](../docs/RUNBOOK.md#debug-tools)).

## Known limits

- **GeoFS updates can rename internals.** Fixes belong only in `G` (or `GeoPhysics` for writes).
- **Much is still unverified in the live sim.** Ghost translucency (`Cesium.Model.color`), the
  waypoint bracket's `SceneTransforms` projection, the items entity budget, cups and results with
  real pilots, the rolling start, and matching relay callsigns to GeoFS multiplayer users (which
  fails closed to the relay's 2 Hz `world` frame). The open rows are in
  [ACCEPTANCE.md](ACCEPTANCE.md).
- **The course vote pool** is the server's `RACE_COURSES_DIR`. A course added to the repo reaches
  the vote once the box's checkout is pulled (see the runbook).
- **Proto-5 chat delivery is conservative.** A client proves proto 5 via `pilot_token`, `spectate`,
  `client_proto >= 5` or its own typed line, so it errs toward withholding.
- **The relay is ephemeral.** A restart drops every room, banana, dark box, projectile and running
  cup. The leaderboard and finished races are in SQLite and survive.
- **Terrain badges** in the Courses tab and vote tiles come from `KNOWN_TERRAIN_STATUS` in
  `race.js`, a hand-kept list that is currently stale (AUDIT B4). CUPS.md is the current source.
- **A ghost is a pace reference**, not a replay: 4 Hz samples, interpolated.
- **Shared results trust the clock, not the flight:** a finish is accepted if its time agrees with
  the relay's clock to within 3 s. That's this project's usual friend-group trust.
