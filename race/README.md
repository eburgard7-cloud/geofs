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
  courses/                shared courses (*.json), index.json (with cup/difficulty), CUPS.md (17 cups, terrain status);
                          race.js plays a cup as a solo cup run or a lobby catalog cup (cupPlaylist: easy -> tight)
  rivals/                 computed rival ghosts per course (<course_id>.json), fetched by race.js as `rival:<id>` picks;
                          index.json (medal times) is also read by server/app.py (RACE_RIVALS_DIR); README.md is the pipeline
  campaign/               the Career's data: campaign.json (tiers, cups, checkrides), rewards.json (models, trails,
                          titles, liveries); read by server/app.py (RACE_CAMPAIGN_DIR), served as GET /campaign/meta
  models/                 joke-plane *.glb, index.json (id, file, scale, offsets), assignments.json (callsign → id), preview.png
  runways/                landing-mode runway defs + index.json, loaded by server/app.py at startup (RACE_RUNWAYS_DIR;
                          embedded three as fallback); LANDING_CUPS.md groups them
  addons.json             third-party GeoFS addons pinned by commit SHA (checked by tools/check_addons.py)
  ADDONS.md               what each pinned addon does, its hotkeys and license status
  server/
    app.py                FastAPI: REST API, the race relay (/ws/race/{room}) and the hub (/ws/hub)
    migrate_modes.py      proto 6: creates mode_runs and backfills it from runs (additive, idempotent)
    airportdb.py          proto 11: loads airports/airports.json.gz; search, lookup, the Dash destination boundary
    dash_engine.py        proto 11: the pure Dash engine (state machine, progress, splits, ceiling, jump start, finish checks)
    runhooks.py           leg_start / leg_finish / leg_results hooks both race engines fire (HOOKS.md is the contract)
    HOOKS.md              how a later event type (Roguelike Cup, Gun Game) wraps the gate race or the Dash
    airports/             airports.json.gz (OurAirports large + medium airports with runways, public domain),
                          build_airports.py (CSV -> that file, deterministic), diff_geofs.py (vs geofs.mainAirportList)
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
    test_dash.py          proto 11: airports, the ROAM home phase, the Dash engine and relay, run hooks, route records
    site_smoke.py          Playwright/headless Chromium guard against the HQ site's globe silently falling
                           back to 2D (real CSP header, faked tile upstream, a seeded ghost trace); CI-only
                           unless Playwright + chromium are installed locally
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
    check_terrain.py      sample terrain along a course, a runway's approach (--approach) or the air-start corridors (--starts) (auto = USGS 3DEP in CONUS + Terrarium elsewhere, Cesium ion, or a file)
    build_models.py       generate models/*.glb and models/index.json
    render_models_preview.py  redraw models/preview.png (needs matplotlib)
    check_addons.py       validate addons.json: schema, pinned SHAs, hotkey collisions with race.js
    gen_docs.py           generate docs/REFERENCE.md (--check for CI-style staleness checks)
    smoke_lobby.py        2–3 scripted pilots through a throwaway room (12 steps)
    hub_smoke.py          the same for the hub socket: identity, presence, ping the ramp
    probe.js              read-only GeoFS/Cesium internals report (PROBE line); its uiLayout section maps GeoFS's on-screen UI; navMaps/runways/recorder/groundPlacement are the Dash discovery (see "Probe: Dash discovery")
    physics_lab.js        WRITE-capable test panel for GeoFS physics, plus GRAPHICS / RUNWAYS / AIRCRAFT discovery (LAB line; debug only)
    terrain_probe.js      read-only check of a course against the terrain GeoFS renders
    recorder.js           20 Hz landing capture in touchdown.js's input shape (RECORDER line, Alt+T)
    tablet_diag.js        read-only speed/alt candidates vs. what the HUD shows, on-screen (TABLET DIAG line)
    finsonly-race.user.js Tampermonkey/Violentmonkey userscript: the COMBINED bookmarklet, automatic (tablets; BRANCH at the top)
    robot_pilot.js        dev: flies courses / runway approaches on the autopilot, reports PASS/FAIL (ROBOT line)
    robot_report.py       robot report JSON -> docs/reports/<date>/ROBOT.md with suggested (never applied) fixes
    replay_landing.mjs    CLI: run touchdown.js over a recording; sample_*.json are a worked example
    ui_gallery.html       every UI surface on fixture data, no sim needed
  docs/
    AUDIT.md              historical dead-code / superseded-UI audit (2026-09-23)
    ACCEPTANCE.md         stub: merged into race/ACCEPTANCE.md
    LAPS.md               design: native `laps` for circuit courses (not built yet)
    BUSH_MODE.md          design: bush mode with runway stops (not built yet)
  ACCEPTANCE.md           the in-sim checklist (everything the test suites can't settle)
  PROTOCOL.md             the relay and hub wire protocol, proto 1–11, checked against app.py
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
  app.py ──▶ SQLite race.db: runs, traces, races, race_results, cups, mode_runs, pilots, dash_runs
  app.py ──▶ in-memory: rooms, presence, room registry, votes, the Dash, chat + its room log (never persisted)
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
| `FlyToStart` | Solo air start: `GeoPhysics.airStart` `COUNTDOWN_LEAD_S` of flying behind gate 1 on the reverse bearing, facing gate 2 (or on the course's `start` line and floor, from `design_course.py --fix-starts`), at min(`PACE_KT`, the aircraft's cruise). `AIR_START_FLYTO` off: `placeAircraft` onto gate 1 at `PACE_KT` |
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
  "env": { "buildings": true, "time": { "localHour": 18.5, "season": 25 },
           "weather": { "clouds": 80, "fog": 10, "windKt": 12, "windDir": 270, "turbulence": 0, "precip": 0 } },
  "gates": [ { "lat": 45.58, "lon": -122.6, "alt": 1200, "radius": 150 } ]
}
```

- `alt` is metres, the same as GeoFS's `llaLocation[2]`. `ALT_OFFSET_M` only moves the visuals.
- `startType` is `"ground"` (the default) or `"air"` (gate 1 is mid-air, so use **Fly to start**, or
  the grid/rolling start in a room).
- `itemBoxes` is optional (≤ 24) and outside the hash. A pre-0.10.0 single `itemBox` is still read
  as a one-element list. Setting both keys is an error.
- `env` is optional; see [Course env](#course-env) below.
- Any other field is silently dropped, so course notes go in [courses/CUPS.md](courses/CUPS.md).
- Adding or changing a course is a runbook task:
  [Content → Add a course](../docs/RUNBOOK.md#add-a-course).

## Course env

A course can set the weather, time of day and buildings it's raced in (`COURSE_ENV`, on by default).
Every field is optional:

| Field | Range | Hashed? |
|---|---|---|
| `buildings` | `true`/`false` | no |
| `time.localHour` | 0–24, hours local to the camera's longitude | no |
| `time.season` | 0–100 (GeoFS's own scale: days after 21 March = 3.65 × season) | no |
| `weather.clouds`, `weather.fog` | 0–100 | no |
| `weather.windKt` (0–200), `weather.windDir` (0–360) | knots, degrees true | **yes** |
| `weather.turbulence`, `weather.precip` | 0–100 | **yes** |

- **Hash policy.** Wind, turbulence and precipitation change race times, so they are part of
  `Course.hash()`, as a trailing `["wx", kt, dir, turbulence, precip]` of whole numbers. Buildings,
  time, clouds and fog are cosmetic and aren't hashed. So a course whose env is cosmetic-only keeps
  the hash and leaderboard it had without one, and adding wind resets the board like any geometry
  change. `race/tools/add_course.py` and `server/app.py` reimplement the hash byte for byte, and
  `test/env_hash_vectors.json` pins all three.
- **When it applies.** On course load and on every re-arm. In a room that means every client when the
  host picks the course, because everyone loads the same file. There's no relay change. When
  `weather` is set, wind, turbulence and precipitation default to 0, so a room races the same
  conditions rather than each pilot's live METAR.
- **Restore.** The pilot's own settings are snapshotted first (a deep clone of
  `geofs.preferences.weather` plus `graphics.buildings`). They're put back at the end of the run
  (finish or DQ), when the course is unloaded or replaced by one without an env, on **Leave**, on
  teardown (the bookmarklet loading another version) and on page unload.
  `geofs.savePreferences()` is never called.
- **Where it shows.** A one-line summary ("Overcast · wind 270/15 · buildings on") appears on the
  Gate's format chips, in the rollback lobby card and on the Solo tab.
- **Old relay.** A relay older than this feature hashes geometry and aircraft only. `Race.matchesHash()`
  accepts that `Course.baseHash()`, so a windy course still loads from its vote, with one status-line
  note. A client older than this feature sees the usual course-mismatch banner on a windy course.
- **Adapter.** All the GeoFS calls are in the G adapter's `G env` section (`makeGeoEnv`), which
  follows the recipe read from GeoFS's `weather.*` source: `manual: true`, `advanced.{clouds, fog,
  windSpeedKts, windDirection, turbulences, precipitationAmount}` then `weather.setAdvanced()`;
  `localTime`/`season` then `weather.setDateAndTime()`; `geofs.api.setBuildings()`. A run.js test
  fails if any of those names turns up outside that section.

## Writing to the aircraft (GeoPhysics)

Boost, the missile speed penalty, Fly to start, the grid, the rolling start and the practice
approach all write through `GeoPhysics`, using only these calls, verified in-sim on 2026-09-23
(and the two marked 2026-09-24):

| Call | Used for |
|---|---|
| `geofs.flyTo([lat, lon, altM, hdg, true])` (2026-09-24) | every air start: spawns already flying; pauses the sim itself |
| `geofs.aircraft.instance.place([lat, lon, altM], [hdg, 0, 0])` | the fallback teleport when flyTo is missing, throws, or `AIR_START_FLYTO` is off |
| `rigidBody.v_linearVelocity` (read) / `rigidBody.setLinearVelocity([east, north, up])` (m/s, local ENU) | Boost, the speed penalty, the air-start speed |
| `geofs.autopilot.setSpeed(kt)` / `setAltitude(ft)` / `setCourse(deg)` / `turnOn()` / `turnOff()` | the rolling start's pace lap, the air-start hold |
| `controls.setters.increaseThrottle` / `decreaseThrottle` (2026-09-24), `{label, set}` records | the green-flag throttle check, the air-start throttle |

**Air start** (`GeoPhysics.airStart`, `AIR_START_FLYTO`): flyTo (place() as the fallback) → wait
for the sim to unpause (a "press P" note after 3 s, give up after `AIR_START_PAUSE_WAIT_MS`) → set
the speed along the heading → step the throttle to target with GeoFS's own keys (within 0.05, at
most 80 presses, stops if a press doesn't move it) → autopilot altitude/course hold for
`AIR_START_STABILIZE_MS` → autopilot off and the throttle re-asserted (the autopilot's throttle
setting persists after turnOff). The rolling start keeps the autopilot on instead. Speeds per
aircraft are in `AIR_START_PROFILES` in race.js (Cub 75 kt, C172 105, Beaver 110, F-16 300; an
unknown aircraft keeps flyTo's own ~200 kt).

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

## ROAM and the Dash (server, proto 11)

Server only so far: race.js doesn't speak proto 11 yet, and every piece goes only to a client that
joins with `client_proto >= 11`. The wire protocol is in [PROTOCOL.md](PROTOCOL.md) "Proto 11".

- **ROAM** is the room's home phase. Free flight with presence (`roam`, at most 1 Hz). The gate-race
  lobby (course, vote, cup, ready) lives inside it. Every event ends in `go_home()`, which sends an
  explicit `home` frame; a proto-10 client is told the room is in its `lobby`.
- **Chat** is room-scoped and survives every phase. The relay keeps the last 50 lines in memory
  (`RACE_CHAT_HISTORY`) and replays them to a joiner as `chat_log`, including across the 10-minute
  reopen window. It is never written anywhere.
- **The Dash**: two airports, a ground start and a landing finish.
  - Anyone in ROAM opens a card with `dash_create` and becomes its marshal. Others join and ready
    up; ready is gated on each pilot's own pings (on the ground, under 30 kt, within 3 km).
  - The marshal sends `dash_go` with a 10/20/30/45 s countdown. GO is the relay's timestamp.
  - The relay tracks progress along the great circle, the 25/50/75 % splits, the optional ceiling
    and jump starts.
  - It accepts a finish only from a pilot it sees on the ground, stopped, inside the destination's
    runway area, and adds the landing penalty.
  - `dash_engine.py` holds every number. Results go home after 20 s or when everyone dismisses.
    `RACE_DASH=0` turns the Dash off.
- **Route records:** `dash_runs` (per pilot, `route_key` = `FROM>TO|ceiling(|class)`),
  `GET /api/routes`, `GET /api/routes/{route_key}`. `dash_traces` is reserved for a best-run
  ghost.
- **Run hooks** ([server/HOOKS.md](server/HOOKS.md)): both engines fire `leg_start`, `leg_finish`
  and `leg_results`, so a later event type can wrap them.

## Ghosts, racing line, bracket and minimap

- **Traces:** `[t, lat, lon, alt, heading, pitch, roll]` at `TRACE_HZ` (4 Hz) from your gate-1
  crossing, quantized, capped at `TRACE_MAX_SAMPLES` (6000, 25 min). A truncated, DQ'd or reset run
  is never saved. A finish saves only a personal best, to `localStorage` (LRU, `TRACE_MAX_COURSES`),
  and uploads it with `POST /runs`. The server validates the trace separately and drops a bad one
  with a reason rather than rejecting the run.
- **Ghosts:** a primary pick (Off / My best / Course record / a pilot), plus up to
  `RIVAL_GHOSTS_MAX − 1` rival ghosts (adds *Next one up*), each at `GHOST_ALPHA`. The fallback chain
  is its model, then the goldfish, then a point. Ghosts are never registered as multiplayer users.
  The robot's House ghost (callsign `HOUSE`) is labelled **TEST PILOT**: still selectable, never a
  default pick (*Next one up*, the solo grid).
- **Challenge link:** `?course=<id>&ghost=<callsign>[,…]`. **News:** `GET /news` on load shows a
  banner when someone has beaten one of your times.
- **Racing line:** the primary ghost's path `LINE_AHEAD_M` ahead, rebuilt at `LINE_REBUILD_HZ`.
  Green means ahead, amber means within ±`LINE_DELTA_BAND_MS`, red means behind. With no trace, it
  draws a dashed Catmull-Rom *suggested line* through the gate centres.
- **Waypoint bracket** over the next gate (an edge chevron when it's off-screen), updated every
  frame. **Minimap** north-up in the bottom-right, at `MINIMAP_HZ`.

## Solo grid race

Solo on an air-start course with something to race (`SOLO_GRID`, solo only, never in a room):

- **The grid.** `soloGridField()` picks up to `RIVAL_GHOSTS_MAX` ghosts (`GRID_MAX_GHOSTS_TOUCH`
  in touch mode), in priority order: your saved ghost pick, the rival just above your PB
  (`rivalTarget`), the rival just below it, your PB, the friend just above you
  (`nextOneUpCallsign`), the course record. Deduped; never the House ghost. Your slot is your PB's
  rank (no PB: the back). Slot j sits `GRID_LEAD_S + j·GRID_ROW_S` seconds of flying before gate 1
  (`gridSlot()` unchanged, with that lead).
- **The start.** Fly to start calls `SoloGrid.makePlan()` and spawns you with
  `GeoPhysics.airStart` `GRID_COUNTDOWN_S` further back than your slot, so you reach it at GO; a
  `GRID_COUNTDOWN_S` Countdown runs to GO (the lobby's lead presets don't apply). A leg of a cup run
  does the same, after waiting (≤ 3 s) for the course's rival file.
- **Two clocks.** Race's gate 1 → finish clock is untouched: the leaderboard, Best, splits and the
  medals use it. The grid's go clock `e = now − GO` (negative in the countdown) drives the ghosts
  and the standings. A ghost trace is timed from its own gate-1 crossing, so each ghost gets a
  synthesized straight lead-in (`soloGridGhost()`): from its slot to its trace's first sample at
  the trace's entry speed (`traceEntrySpeedMs()`), `leadInMs = distance / speed`. Before GO it
  flies in formation in its slot; from GO the lead-in; from GO + leadInMs its trace at
  `e − leadInMs` (`soloGridGhostAt()`). So it crosses gate 1 at GO + leadInMs.
- **Standings.** `gridStandings()` orders by finish time, then gate index, then distance to the
  next gate (so laps that revisit a spot are still ordered right), DQ last. Gate times on the go
  clock (a rival's `splits_ms`, else `traceGateTimes()` over its trace) give timing-loop gaps
  (`gridGapMs()`). The HUD tower and position block take them (touch: place + one gap), and an
  overtake flashes "P3 → P2" with a cue.
- **Instant retry** (`SOLO_RETRY`). Reset (Alt+R, the touch bar, the pad) is a full retry
  (`SoloGrid.retry()` → `FlyToStart.run()`): back in your slot, ghosts rewound (they're a pure
  function of the go clock; traces and models stay loaded), countdown restarted, attempt counted.
  Debug `retry ms` times press → countdown. Touch: hold mid-run, a tap after a finish/DQ or once
  `missedGateCheck()` sees you fly past a gate.
- **The finish card** (`SOLO_FINISH_CARD`), instead of the banner and "Press Alt+R": time, PB delta,
  the medal this run (STEVE bronze, BRAT silver, MOO gold, DAWG the DAWG; a tie is not a win;
  display only), the next target, the sector where you lost most (`worstSector()` vs the target's
  `splits_ms`, else your old PB), attempt, posting state. Retry / Next / Close; the pad's A / X / B.
  Touch: a bottom sheet between the thumbs (`soloCardSheet()`), 56 px buttons.
- **Target chip** (`TARGET_CHIP`): "TARGET MOO −0.8", the live `traceDeltaMs` against the rival
  you're chasing, and each gate's split against its `splits_ms` with a blip.
- **DUEL** (`DUEL`, off): the target ghost's playback rate floats 0.97–1.03 (`duelRate()`) to keep it
  within ±1.5 s of you until the last 20% of its trace, then 1. Only where it is drawn changes.
- **Callouts** (`RIVAL_CALLOUTS`, `'auto'` = desktop only): a short line per persona in the HUD
  feed when they pass you, you pass them, or you beat them; at most one per 8 s.
- **Tablet cost.** In touch mode a ghost more than `GHOST_LITE_DIST_M` away draws as a light marker
  (`makeRemoteMarkerLayer`) instead of its glb (`ghostLodMode()`, with hysteresis). Debug
  `frame ms` logs frame-time p50/p95 every 5 s while a grid runs.

## Play home and Career

The FINSONLY Pilot Career makes single player the front door. It's built for the tablet first:
touch, sometimes a Switch Pro pad, often a phone network.

### Play home (`CONFIG.HOME`)

The panel boots on **Play**. Set `HOME: 'ramp'` for 1.7's Ramp-first boot.

- **Continue**: a big card that goes wherever `careerContinueTarget()` points.
  - Checkride 0 on first launch.
  - Otherwise the next un-silvered course in the current tier (cup order, then playlist order),
    flown as a solo cup run from that course (`SoloCup.start(cup, cupFromHere(...))`). So it's a
    Grid race, and the target rival is auto-picked.
  - Once every course in the tier is silver or better: that tier's checkride.
  - After the checkride: anything short of DAWG.
- **Tiles**: Career, Quick race, Cup run, Landing, Free fly and Ramp.
  - Quick race is a random course you haven't medaled, raced against its rivals.
  - The Ramp tile lists who else is on the hub and lights up when anyone is. Invites and pings
    still toast as before.
- **Sizes**: tiles are buttons at least 56 px tall. Nothing is hotkey-only.
- **Pad**: A = Continue on Play; B = back to Play from Career, Solo, Landing, Courses, Settings or
  the Ramp (`padHomeAction`). This only applies while the panel is open and no run is live. The
  rest of the time A and B keep their flight actions. GeoFS owns the sticks and the D-pad.
- **First launch** asks for a callsign once (a big field at the top of the screen, clear of the
  soft keyboard).
  - It claims the name (`POST /pilots/claim`) and turns autosubmit on.
  - Then it starts Checkride 0: about 90 s on `starter-sprint-seatac` against STEVE, or on the
    easy course with all four rivals and the shortest STEVE time.
  - The coach gives three prompts (throttle, the next-gate bracket, the racing line). Each names
    the control for the input in use: touch slider, keyboard or pad.
  - Finishing the checkride is the pass; no medal is needed. Then the Career home.

### Identity without the Ramp

`POST /pilots/claim` is the hub `hello`'s identity step over REST, calling the same
`claim_callsign()`. The client keeps `pilotId`/`pilotToken` in the same localStorage keys the hub
uses, so Play and the Ramp share one identity whichever came first.

Runs and landings carry `pilot_token` and are stored against its `pilot_id`:

- A token another pilot's callsign doesn't match → 409.
- An unknown token or no token → today's callsign behaviour. `pilot_id` now resolves at insert
  time, not only at the next restart's backfill.

### Run outbox (`CONFIG.RUN_OUTBOX`)

Every finish gets a `client_run_id` (a uuid). It goes into localStorage (`outbox`) before the
POST, then posts one run at a time, 6 s apart (POST /runs allows one per 5 s per IP).

- **When it retries**: on boot, on resume (the tablet-mode Resume hook) and on `online`. Backoff
  is 6 s, doubling up to 5 min.
- **Against a server with `run_dedupe`** (`GET /version` → `features`):
  - A repeated `client_run_id` gets the original row back (`duplicate: true`); nothing is written
    twice.
  - A 4xx about the run drops it.
  - 408, 425, 429, a 5xx or no answer at all → retry.
- **Against an older server**: a run is retried only when no answer arrived at all, never after
  any HTTP answer.
- **Storage limits**: capped at 50 runs. When storage is full, traces go before times
  (`outboxShrink`).
- **What the pilot sees**: the finish card says "Saved · posts when you're back online".

Each run also records its input method (`input`: touch, keyboard or pad) for a later ladder
calibration; it is shown nowhere.

### Career (server-authoritative)

The data is `race/campaign/campaign.json` and `race/campaign/rewards.json`, validated at startup
(`validate_campaign()`). A bad file turns the Career off, not the server. The rival medal times
come from `race/rivals/index.json` (`RACE_RIVALS_DIR`).

`campaign_progress()` in app.py is pure; the client only draws its answer.

- **Medals**: a pilot's best on the rival file's course_hash, strictly faster than STEVE is
  bronze, BRAT silver, MOO gold, DAWG the DAWG.
  - Ties don't count.
  - Other hashes (variants, older versions) don't count.
  - Stars are 1–4 per course.
  - Only courses with all four rivals count; the rest read "no rivals yet".
- **Tiers**: STUDENT → PRIVATE → COMMERCIAL → ATP → TEST PILOT, 3–4 catalog cups each.
  - The next tier opens with the tier's `unlock.stars` (about silver across the previous tier) AND
    the previous tier's checkride.
  - A checkride is a landing cup: every listed runway's best landing (score v2) must be at least
    `min_score`.
- **Trophies**: a cup's DAWG trophy is DAWG on every counted course in it. Every trophy there is
  to win opens the hidden tier DAWG (title Top DAWG).
- **Rewards** (`rewards.json`): joke models, boost-trail colours, a title per tier, and Livery
  Pack 1 liveries.
  - Joke models are locked in the model picker until earned; the option shows what it needs. A
    model the pilot already flew or was assigned before the Career is grandfathered
    (`grandfatheredModels`, set once).
  - Liveries are applied in LiverySelector, never by race.js; the reveal says where to find them.
  - The trail colour only changes your own boost trail, locally.
- **News**: medal, checkride, tier, trophy and hidden-tier events go into `record_events` with a
  `kind` ("ERIC took the Gold medal on Mt. Hood Circuit"). Every course-record reader filters to
  `kind IS NULL`.
- **The Career screen**: the tier ladder, then the selected tier's cup cards (a tile per course
  with four medal pips, trophy badges, the checkride button). A course tile flies that cup from
  there.
- **Results**: after a posted run or a scored landing, the client refetches its snapshot, and
  `careerUnlockDiff()` drives the reveal card:
  - the medal pops (not under `prefers-reduced-motion`)
  - the stars count up
  - each unlock gets a line
- **Titles**: shown next to callsigns in the tower and results (`GET /campaign/titles`, cached).
- **Mismatched rivals**: if the client's `race/rivals/index.json` generator differs from the
  server's, the Career says "Rivals updating" instead of showing two medal sets.
- **Against an older server**: Play still works, the Career says "Career needs a newer server"
  once, and nothing is locked.

**Rival callsigns.** STEVE, BRAT, MOO and DAWG are reserved like HOUSE (`RIVAL_CALLSIGN_KEYS`). A
pilot who already had one of those names before this deploy (a `pilots` row with history)
keeps it (`GRANDFATHERED_CALLSIGN_KEYS`, loaded at startup). Nobody new can take one. Rivals never
enter any table, so no board, record, news item, pilot page or cup can show one.

### CONFIG flags

All default on:

| Flag | What it does |
|---|---|
| `HOME: 'play'` | Boot on the Play home |
| `RUN_OUTBOX` | Save every finish locally and retry it until it posts |
| `CAREER` | The Career: medals, tiers, checkrides, trophies, rewards |
| `CAREER_MODEL_LOCK` | Lock joke models until they're earned |
| `CAREER_TITLES` | Show titles next to callsigns |
| `COACH` | Checkride 0's three coach prompts |

## Landing mode

**Scoring (server).** `score_touchdown()` in `server/app.py` turns `touchdown.js`'s raw `touchdown`
event, plus the bounce count and settled rollout, into a 0–1000 score against a runway from `RUNWAYS`
(loaded from `race/runways/` at startup, 26 today; see [LANDING_CUPS.md](runways/LANDING_CUPS.md)).
It penalizes vertical speed (the dominant term), centerline offset, distance from the touchdown zone,
bank and crab, bounces and rollout. Each penalty is capped on its own, and all the constants are in
one `LANDING_*` block. `POST /landings` scores and stores an attempt as a `landing` mode run and
ignores any client-sent score. `GET /landing-leaderboard?runway_id=` reads a board. `GET /runways`
serves each runway's geometry, `version`, `zone`, `notes`, the optional `aircraftId` / `approach` /
`env`, and the board's `course_hash`.

**The Landing tab (client, `CONFIG.LANDING`).** `LandingMode` in race.js runs the loop: the picker
(grouped by the leading word of `notes`, with difficulty chips), `landingSpawn()` (`approachSpawn()`
plus the runway's `approach` override and the aircraft's `approachKt`) through
`GeoPhysics.airStart`, and the Landing HUD (`landingHudModel()`: Guidance's `ilsDeviation()` and
`approachStability()`). Every frame, `G.landingSample()` feeds the touchdown detector. race.js
carries a **verbatim copy** of touchdown.js's detector section (`Touchdown`), and run.js fails if
they drift. On `settled`, `landingPostBody()` posts exactly `LandingAttemptIn`'s fields, and the
scorecard shows the server's breakdown. `landingSessionReduce()` is the attempt/cup state machine,
and a Landing Cup (`CONFIG.LANDING_CUP`) is four runways of one group. The runway's `env` goes
through `CourseEnv`. Against an old server there's one note, and no crash. How to fly it is in the
runbook, [Landing night](../docs/RUNBOOK.md#landing-night).

**Practice approach** on the Solo tab (`PRACTICE_APPROACH`) is the untimed, unscored version: the same
spawn geometry without the override, the HUD or the detector. `tools/recorder.js` +
`tools/replay_landing.mjs` exercise `touchdown.js` against real landings, and recorder.js's
`FIELD_MAP` is still unverified `TODO-PROBE` placeholders.

**Guidance and the robot.** Guidance (race.js, pure) is the shared autopilot maths: leg bearing and
distance, turn lead, the gate switch distance, rate-limited altitude commands, glidepath, and virtual
ILS deviation. `GeoPhysics.autopilotTo({courseDeg, altFt, speedKt})` hands it to the verified
autopilot calls. The ROBOT dev bookmarklet (`tools/robot_pilot.js`) flies courses and approaches with
it, through `__finsRace.dev` (`CONFIG.DEV_API`). See the runbook's
[Robot test pilot](../docs/RUNBOOK.md#robot-test-pilot).
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

## Probe: Dash discovery

`tools/probe.js` (the PROBE bookmarklet line) has four sections for the airport-to-airport Dash
race, all discovery. It changes no race code. The report starts with `readMeFirst` and a
`dashReadiness` summary (N-map instance path, runway data source, ground placement call,
recorder path), followed by the four sections, then the older ones.

- **`navMaps`**: every Leaflet map (a walk of geofs/ui/window plus every `.leaflet-container`):
  JS path, container, visibility (including hidden ancestors), size, zoom, centre, layer count.
  `raceOverlay` says which map race.js's `G.leafletMap()` would resolve and which map actually
  carries the course overlay (load a course first). A 500 ms watcher starts on the first run and
  logs containers appearing, being removed, shown or hidden, plus N keypresses. **Run the probe
  twice, before pressing N and with the N panel open**: `lifecycle.comparedToPreviousRun` says
  whether the panel's map is created lazily, destroyed on close, or reused. `panelHooks` lists
  map/nav-named GeoFS functions (with source), N-key bindings and map-ish DOM controls.

**Findings from the first in-sim run (2026-10-06).** The N map is `geofs.api.map._map` (Leaflet
1.9.4), created at page load and hidden (0x0) inside `div.geofs-map-list` until `ui.openMap` ->
`geofs.map.startMap()` resizes it. GeoFS runway records carry no designator and a TRUE heading
(KPDX 10R is 119.09, not 100), so `findRunway` matches the closest heading within 35 degrees and
splits parallels by cross-track. World runways are in `geofs.majorRunwayGrid[lonInt][latInt]` as
`[icao, lengthFt, widthFt, trueHeading, lat, lon]`. The recorder is `window.flight.recorder`.
`geofs.aircraft.instance.change(id, livery, force)` swaps aircraft keeping the current position.
`geofs.userRecord` holds the session id and email, so the report redacts it.
- **`runways`**: any object under geofs/ui/window named like runway/airport/icao, with its count,
  a normalised record shape (raw length/elevation key names kept: the unit is for a human to
  call), the three nearest records to KPDX, KSEA and the aircraft, and the page's own matching
  network requests. Rerun after moving far to see whether the data loads per area
  (`previousRunCount`). `geofsStores` decodes GeoFS's three stores (2026-10-02 probe):
  `geofs.runways.nearRunways` (full records, only near the aircraft; `location` is the threshold
  `[lat, lon, elevM]`, `heading` can be negative, no L/R designator), `geofs.mainAirportList`
  (ICAO -> `[lat, lon]`, ~6.9k airports) and `geofs.majorRunwayGrid` (bucketed 6-number arrays,
  raw ones near KPDX/KSEA are printed so the fields can be decoded). The ground test finds 10R only
  when started near KPDX; `findRunway` picks L/R by which parallel is rightmost along the heading.
- **`groundPlacement`**: not automatic. The probe adds a red **Run ground placement test**
  button (bottom-left, behind a confirm). It moves the aircraft to KPDX 10R (runway data if found,
  else 45.5960, -122.6000, hdg 100) at terrain height and tries `place()` + zero velocity, then
  three `flyTo` variants, stopping at the first that holds for 5 s (`judgeGroundPlacement`: ground
  contact, no bounce, no sinking, no crash flag, under 10 m of drift, groundspeed under 3 m/s). It
  then re-copies the whole report with the result. This is the probe's only write.
- **Effects, swap and N-map buttons** (all opt-in, behind a confirm, one at a time, each re-copies
  the whole report; `probe.js` only, race.js is not involved):
  - **Run effects tests** (blue; fly straight and level above ~5,000 ft AGL, refused below 1,500 m):
    1. velocity clamp to (speed - 20 m/s) every frame for 10 s: verdict `stable`/`jittery`/`fought`
       (`judgeClamp`: mean speed above the cap at frame start > 1.5 m/s is fought, speed std > 2 m/s
       is jittery), attitude oscillation, frame cost and fps;
    2. +30 m/s impulse along heading, decay time back to the trimmed speed;
    3. velocity x0.995 per frame for 5 s (stall-guarded): how much GeoFS restores;
    4. on the first click only, up to 10 mass/inertia/drag/thrust fields found on the instance,
       `rigidBody`, `definition`, `engines[]`, `airfoils[]` are each written x1.2, sampled 5 s against
       a 1 s baseline, and restored: `not-writable`, `snaps-back`, `effective` or `no-effect`.
    Click it once near 250 kt and once near 600 kt; the report keeps every run.
  - **Run aircraft swap test** (purple): swaps to the Cessna 172 in flight, tries `change(id)`,
    `change(id, [lat,lon,alt,hdg])`, then clicking the aircraft list item, and reports time, whether
    position and velocity survived, errors and whether `multiplayer.lastRequest` carries the new id;
    then swaps back, putting position/velocity back if the swap lost them. `aircraftCatalog` (read-only,
    always in the report) lists every aircraft id and name and the swap-ish functions with their
    parameter lists.
  - **Run N-map attach test** (green): for 10 s wraps `ui.openMap`/`closeMap` and
    `geofs.map.startMap`/`stopMap`, adds one magenta circle to `geofs.api.map._map` and reports, for each
    open you do with N, which function fired, whether the panel became visible, whether the layer
    survived the open and whether the circle is on screen. Press N, N, N inside the 10 s.
  `window.__finsProbeTimeScale` (default 1) shortens every wait; the JSDOM smoke test uses it.
- **`recorder`**: the object holding GeoFS's flight-export `tape`: path, boolean flags, sample
  rate from the `ti` stamps, whether the tape is growing (`recordingNow`), and which live GeoFS
  values equal each `st`/`ct`/`ve`/`acc` slot of the newest entry. Start a recording first.

## Airport data (the Dash)

The Dash (PROTOCOL.md "Proto 11") resolves its two airports from
`server/airports/airports.json.gz`: every **open large and medium airport** in
[OurAirports](https://ourairports.com/data/) (about 5.3k, about 5k of them with runway ends), each
with ICAO/IATA codes, name, city, country, reference point, elevation and its open runways (both
ends' ident and lat/lon, true heading, length, width, surface, elevation). OurAirports data is
**public domain**; no attribution is required, but this is where it came from.

- **Rebuild** after downloading `airports.csv` and `runways.csv` from
  `https://davidmegginson.github.io/ourairports-data/`:
  `python -I race/server/airports/build_airports.py --airports airports.csv --runways runways.csv`.
  The script never touches the network and its output is byte-identical for the same input, so
  a rebuild diff is a data change and nothing else.
- **Key:** `icao_code`, else a 4-character `gps_code`, else the OurAirports `ident`; the other
  codes and the IATA code are search aliases (`PDX` finds KPDX).
- **GeoFS's own list** is `geofs.mainAirportList` (~6.9k ICAO -> `[lat, lon]`), which is what the
  client searches. It includes small fields we don't ship, and a Dash to one of those is refused by
  name. To measure the gap, run `copy(JSON.stringify(geofs.mainAirportList))` in the geo-fs.com
  console, paste it into a file, then run
  `python -I race/server/airports/diff_geofs.py that.json` (`--json` for the full lists).
- **REST:** `GET /api/airports?q=` (at most 10 rows, no runways) and `GET /api/airports/{icao}`
  (with runways; 404 when unknown). Both have their own per-IP gate (`RACE_AIRPORT_RATE_PER_S`,
  default 5/s), since a client types into the first one.

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
- **The relay is ephemeral.** A restart drops every room, banana, dark box, projectile, running
  cup, Dash and room chat log. The leaderboard, finished races and Dash route records are in SQLite
  and survive.
- **Terrain badges** in the Courses tab and vote tiles come from `KNOWN_TERRAIN_STATUS` in
  `race.js`, a hand-kept list that is currently stale (AUDIT B4). CUPS.md is the current source.
- **A ghost is a pace reference**, not a replay: 4 Hz samples, interpolated.
- **Alt+L is claimed twice when the PROBE line is loaded.** `tools/probe.js` binds Alt+L to its
  landing sampler, the same key as race.js's racing line, so with both loaded one press does both.
  Load PROBE only on a throwaway flight. (`tools/recorder.js`'s Alt+T doesn't clash.)
- **A lobby race can't be resumed as a racer after a background gap** (tablet-mode). Coming back
  reconnects the relay straight away, but the relay seats anyone who joins a race already under way
  as a spectator, and it may briefly still hold the old connection ("callsign already connected",
  retried quietly). Changing that is a relay change, which the tablet work deliberately left alone.
- **Shared results trust the clock, not the flight:** a finish is accepted if its time agrees with
  the relay's clock to within 3 s. That's this project's usual friend-group trust.
