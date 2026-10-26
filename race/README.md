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
    gungame_engine.py     proto 14: the pure Gun Game engine (ladder, tiers, catch-up, end, leg vote); data in data/gungame.json
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
    test_gungame.py       proto 14: the Gun Game engine, its catalog and the relay glue (a whole game, wins, unlocks)
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
    probe.js              read-only GeoFS/Cesium internals report (PROBE line); its uiLayout section maps GeoFS's on-screen UI; navMaps/runways/recorder/groundPlacement are the Dash discovery (see "Probe: Dash discovery"); liveries/liveryApply are the livery discovery (see "Probe: livery discovery")
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
| `MapLayer` / `MapOverlay` | The one overlay group on the nav map, and what is drawn in it: Dash route, friend dots, look-here pings (`MAP_OVERLAY`, `MAP_PING`); `BeaconLayer` is the 3D destination pillar (`DASH_BEACON`) |
| `MapProLayer` / `MapPro` | The nav map's FINSONLY styling (`MAP_PRO`, `MAP_TRAILS`, `MAP_LABEL_DENSITY`): pilots, CUP gates, DASH route, ROAM pins, the plate and the controls |
| `Race` | The engine: start on leaving the start sphere, interpolated gate crossings, splits, pause exclusion, DQs, the gate-1 clock (`elapsed`) and the lobby clock (`goElapsed`) |
| `Countdown` | Arms a countdown against a target time (used by the lobby's synced start) |
| `FlyToStart` | Solo air start: `GeoPhysics.airStart` `COUNTDOWN_LEAD_S` of flying behind gate 1 on the reverse bearing, facing gate 2 (or on the course's `start` line and floor, from `design_course.py --fix-starts`), at min(`PACE_KT`, the aircraft's cruise). `AIR_START_FLYTO` off: `placeAircraft` onto gate 1 at `PACE_KT` |
| `formation*` functions | Pure rolling-start geometry: holding-pattern oval, slot targets, along-track error, speed P-controller, start-line crossing, terrain-margin altitude |
| `Debug` | The Alt+D overlay and log |
| `Relay` | The `/ws/race/{room}` socket: reconnect with backoff, the proto gate |
| `Lobby` | Room state (`lobbyReduce`), clock offset (min-RTT `ping`/`pong`), ready/course/rules/start/abort/cup/rematch, grid slots, formation steering |
| `Hub` | The `/ws/hub` socket: identity (`pilot_id`/`pilot_token`), presence, rooms, ramp pings |
| `Results` | `finish`/`dnf` frames, the shared results card, points, awards, cup standings, the record badge |
| `Powerups` / `Items` | Loadout and box slot, what each powerup does (`powerupEffectSpecs`), world items (projectiles, bananas, boxes) |
| `effects*` functions / `Effects` | The effects engine: the one owner of every change to this player's physics or screen (see below) |
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

- **Boost:** an effects-engine impulse of `BOOST_ADD_MS` (60 m/s) along the flight path, ramped in
  over `BOOST_RAMP_MS` (0.8 s), then bled back off over `BOOST_DECAY_MS` (4 s), capped at
  `BOOST_MAX_KT` (650). It never stacks. The trail and vignette show for `POWERUP_BOOST_MS` (4 s).
- **Speed penalty** (`POWERUP_SPEED_PENALTY`, off by default): an effects-engine drag of
  `EFFECTS_MISSILE_DRAG_PER_S` (6 %/s) for `PENALTY_MS`, never stacking, shrugged off by a live Boost.
  The engine's floors apply.

### Effects engine

`Effects` (runtime) and the pure `effects*` functions own **every** change to this player's physics or
screen: Boost, Shield and the hits today; Roguelike Cup, Gun Game, zones and chaos events later. An
effect is `{ id, kind, source, stacking, hostile, durationMs | permanent, params }`, added with
`Effects.add(spec, { granted, onExpire })` (`__finsRace.effects` in the console):

| Kind | Does | Notes |
|---|---|---|
| `governor(capMps)` | Clamps the speed to the cap, keeping direction | Eases down over `EFFECTS_GOV_RAMP_MS` (1 s). The lowest cap wins |
| `impulse(deltaMps, rampMs, decayMs)` | Adds speed along the velocity, then bleeds it back off | Never below the speed it started from. A bare push lingers for 7–16 s in GeoFS, hence the bleed |
| `drag(fractionPerSec)` | `v *= (1 − f)^dt` | Time-based, so 30 fps and 144 fps match. Default `EFFECTS_DRAG_DEFAULT_PER_S` (5 %/s) |
| `screen(goop / fog / shake / tint)` | The `#fr-fx` overlay and the hit shake | Shake off under reduced motion and `HIT_SHAKE` false |
| `shield` | Blocks any later hostile effect | |

Stacking: `replace` (the same id restarts), `stack` (instances coexist), `max` (one record: the
later expiry and the stronger magnitude). `onExpire(record, reason)` fires once (`expired`,
`replaced`, `removed`, `cleared`).

Rules the engine never breaks: drag and governors never take you below
`EFFECTS_STALL_MARGIN` × stall (1.3 × `AIR_START_PROFILES` approach / 1.3, or
`EFFECTS_FLOOR_FALLBACK_KT`). Hostile drag and governors do nothing below `EFFECTS_MIN_AGL_M` (150 m)
or when AGL is unreadable. On the ground only a governor acts. Control inputs are never touched. With
a relay up, hostile and progression (`cup`/`gungame`/`zone`/`chaos`) effects apply only with
`granted: true`, which only the relay's `hit`/`grant` handlers pass. Solo, local ones are allowed.

The only write is one `GeoPhysics.setVelocityENU(v, {quiet})` per frame (the probe-verified
`setLinearVelocity`). It is counted, not logged. `CONFIG.EFFECTS` false keeps the clocks but never
writes. The HUD chip strip (`EFFECTS_CHIPS`) shows each effect's time left and why it is held
(`held: low`). `EFFECTS_DEBUG` adds a panel with the effects, the cap, the floor, AGL and writes/s.
There are no mass, drag or thrust scales: the probe found those fields noisy or recomputed every
frame.
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

## Nav map overlays and the Dash beacon

Probe-confirmed facts this is built on: the N panel's Leaflet map is `geofs.api.map._map`
(`geofs.map` is only a wrapper), it is created at page load and survives every open/close, it
renders to canvas (no SVG nodes), `ui.openMap` fires on every open and `ui.closeMap` on close.

- **One group, added once.** `makeMapLayer()` (next to `makeGateLayer`) is the only place race.js
  touches Leaflet overlays. It adds ONE `L.layerGroup` to `G.leafletMap()` and gives every user a
  named sub-group inside it (`course`, `dash`, `dots`, `pings`, and your own). Nothing is re-added
  on open. Markers and lines are non-interactive, so a tap still reaches the map.
- **Open/close.** `G.hookMapPanel()` wraps `ui.openMap` / `ui.closeMap` once (a second hook, or a
  newer copy of race.js, swaps the callbacks and never wraps twice). They only pause and resume the
  500 ms (2 Hz) refresh of the live dots; the layers themselves stay put. Open refreshes at once.
- **What is drawn** while a Dash card is up (staging, countdown, running): departure and
  destination markers with their ICAO, the great-circle route, ticks labelled 25 / 50 / 75 %, and
  the entrants' dots. In free roam: friend dots from the relay's `roam` presence (callsign,
  plane, altitude), dead-reckoned between its 1 Hz frames. GeoFS's `multiplayer.users` come back
  with BLANK callsigns (probe round 4), so a relay pilot is matched to a drawn user by position:
  the nearest user within 200 m of the dead-reckoned relay position, and only when each is the
  other's nearest (`matchDrawnUsers`). A match takes the user's smooth position, altitude and
  heading; no match keeps the relay dot. My aircraft is the large accent dot.
- **Look here.** A tap or long-press drops a ping on your map and sends `look` to the room (1 per
  5 s; PROTOCOL.md "look"). Others see `LOOK · callsign`; it fades over its last 5 s and is gone at
  30 s. Against a relay without the `look` feature it is drawn locally only, with one status note.
- **The beacon.** `makeBeaconLayer()` draws one translucent Cesium `Primitive` cylinder, 15 km
  tall, at the destination's reference point in the theme accent. Its radius grows with distance
  (40-450 m) so it reads from ~50 nm; it is drawn out to 120 nm and hidden inside 2 nm (back at
  2.3 nm). `CONFIG.DASH_BEACON` turns it off.
- **For Tag and Gun Game.** `__finsRace.mapOverlay` exposes `addMarker(owner, spec)`,
  `addLine(owner, spec)`, `setColor(handle, color)` and `clear(owner?)`. Pick your own `owner` name;
  `clear(owner)` empties only yours. Specs are in the comments on `makeMapLayer`.
- **Wiring.** Everything above is in race.js's `MapOverlay` block plus the two factories. The only
  call into it is `MapOverlay.init()` after `window.__finsRace` is built; `init()` wraps
  `Lobby.onFrame` (to see `look`), hooks the panel, and chains teardown.

### The map design pass (`MAP_PRO`, nmap-pro)

With `CONFIG.MAP_PRO` on (the default), `MapOverlay.refresh` and its pings go to `MapPro`, which
draws the map in the FINSONLY style. With it off, the functional overlay above is drawn exactly as
before (`race/test/map_golden.json` pins it). Client-only: no relay or protocol change.

- **Where it draws.** `makeMapProLayer(MapLayer)` is the only new Leaflet code: owner sub-groups
  in MapLayer's one root, plus five panes of our own (an event's lines and marks, our lines and
  marks, and mine on top), stacked by the `--fr-z-map*` tokens. Lines use their own canvas
  renderers. Labels are `L.divIcon` markers whose content element MapPro builds once and then
  changes only by class, CSS variable and text. Two `L.Control`s: the plate (top left) and the
  control stack (bottom right). GeoFS's tiles and DOM are never touched.
- **Three states** (`mapViewState`). **CUP** while a course is armed or running, and for 30 s after
  the finish: numbered gate rings, the next one large and pulsing, passed ones small ticks, a
  chequered finish. The course line runs in the accent gradient, the leg I'm on bold, done legs
  muted. The ghost's trace is a thin glowing line in the racing line's colours. **DASH** while I'm in
  a Dash, or the room is flying one: the route solid behind me and dashed ahead, waypoints as
  diamonds, CLB / FAF / TOD badges, 25 / 50 / 75 % plates that take the leader's split from
  `dash_split`, the airports as ICAO + runway badges, and the arrival runway, centreline and feather
  in the accent. **ROAM** otherwise: friends, look-here pings as a ripple that fades out by 30 s, a
  *Dash forming* pin at the departure of a card I haven't joined (a tap opens the card), and faint
  labels where friends are parked. When CUP or DASH ends, its layers fade out over 1 s and are cleared.
- **Pilots.** Chevrons rotated to heading and sized by zoom. Mine is in the accent gradient with a
  halo, on its own pane. Others get a stable colour per callsign (`pilotColor`, 10 colours, never
  the accent). The plate: position (races), a crown on the leader, callsign, plane (never "?"),
  `FL190` or `3,200 ft`, and a climb / descend arrow. `mapDeclutter` drops overlapping plates to
  callsign only, then hides them; mine never hides (`MAP_LABEL_DENSITY`: `auto`, `full`,
  `minimal`). Trails cover 60 s in three fading segments (`MAP_TRAILS`). At most 32 pilots are
  drawn, then a *+N more* chip. Above a Dash ceiling my chevron turns warn yellow. The marker pool is
  built once and reused.
- **Controls** (44 px): Follow me (a drag stops it), Fit course / route / pilots, a north-up label
  with my track, toggles for Trails, Labels, ILS and Pings, and a legend. Leaflet can't rotate the
  map without transforming GeoFS's pane, so there is no track-up. Settings are saved per user in
  `finsRace.mapPro`.
- **For Tag and Gun Game.** `__finsRace.mapOverlay.setPilotStyle(callsign, { color, badge, pulse })`
  restyles a pilot without new drawing code; `clearPilotStyle(callsign?)` undoes it.
- **Motion** is CSS only (the next-gate pulse, ping ripples, my halo, the fade) and is off under
  `prefers-reduced-motion`. Updates stay at 2 Hz and stop while the N panel is closed.

## ROAM and the Dash (proto 11)

Every piece goes only to a client that joins with `client_proto >= 11`. The wire protocol is in
[PROTOCOL.md](PROTOCOL.md) "Proto 11". The in-sim checks are ACCEPTANCE.md "Dash client (2-client)".

**Client (race.js, `CONFIG.ROAM` / `CONFIG.DASH`, both on).**
- **The join** says `client_proto: 11` (5 with `ROAM` off). `roam` and the `dash_*` phases read
  as `lobby` to every gate-race path (`homePhase()`), and `Lobby.state.roomPhase` keeps the real
  one. Against a relay below proto 11: the Gate as before, no Dash, and one status-line note.
- **ROAM screen** (the Gate, Alt+K / click-away as before; 44 px targets):
  - who is in the room, from `roam` frames (plane, ground or altitude, speed);
  - the Dash section: New dash, or the active card;
  - the gate race (vote, pilots, ready bar) in a card that folds away;
  - the room chat, with `chat_log` merged in once and the Dash card pinned on top.
- **Free-flight pings:** `pos` at `DASH_POS_HZ` (2 Hz) in a proto-11 room, with `alt_m`,
  `on_ground`, `gs_kt`, `vs_fpm`, `hdg`. The gate race's own ping carries the same fields.
- **New dash:** From is the nearest `geofs.mainAirportList` airport. Both fields search that list,
  then `GET /api/airports?q=`. The ceiling is None / 10,000 / 18,000 / Custom. A refusal shows on
  the form.
- **Staging:**
  - The checklist (on the ground, within 3 km, under 30 kt) gates READY. The relay's own
    `ready_block` shows under it.
  - **Line up on runway** puts you on the card's departure runway (below; on an older relay, the
    longest `geofs.runways.nearRunways` runway at the departure), in your card slot (n x 60 m down the centreline, 20 m left/right alternating).
    It uses `GeoPhysics.placeOnGround`, the verified place + zero-velocity call.
  - If those runways aren't loaded, it places you at the airport point first and waits up to
    `DASH_RUNWAY_WAIT_MS`, else says "Taxi to ICAO".
  - The marshal (or host) has the lead time, GO and Cancel dash.
- **Start and running:**
  - The countdown and GO are on `#fr-dash-hud`, and a jump start is a sticky chip.
  - From the countdown on, `GeoPhysics` refuses every teleport (its `blocked` dep). A position
    jump faster than `MAX_SPEED_MS` is a DQ (`dash_dnf retired`).
  - The HUD shows the race clock, the destination's bearing / nm / ETA, and the ceiling bar
    (amber 500 ft below, live penalty seconds over). It also shows the standings and split toasts.
  - DNF is a two-tap in-page confirm. GeoFS's crash flag is `dash_dnf crash`.
- **The finish:**
  - The Landing tab's touchdown detector feeds `dashFinishReduce()`. A touchdown, then stopped
    under 30 kt, then `dash_finish` after two stopped pings, retried every 2 s on a refusal.
  - Airborne again 5 s after the touchdown (or a go-around) is a touch-and-go: you keep racing.
  - `landing_score` is `landingScoreV2()`, the client copy of app.py's `score_touchdown()`. It is
    scored against the card's destination runway end (zone 150–450 m).
- **Results card:** total, itemised penalties, splits, landing score and the route board rank
  (`GET /api/routes/{key}`). The buttons are Rematch, Reverse route and Back to roam (`dismiss`).
  `home` closes it and opens ROAM.

**Server.**

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

**Runways, the route and the line-up (dash-arrival).** The wire format is in PROTOCOL.md
"Runways and the route". The in-sim checks are ACCEPTANCE.md "Dash arrival".

- **Runways.** The relay picks a runway end at each airport, so every pilot flies the same one:
  - Departure: the one best aligned with the outbound course.
  - Arrival: the one best aligned with the inbound course.
  - Only main runways count (at least 60 % of the longest), and ties go to the longest.
  - The New dash form can override either from a runway list (`GET /api/airports/{icao}`).
  - The card shows *KSEA 16L → KPDX 10R*, and so do staging and the HUD.
- **The route.** Departure threshold → CLIMB (5 nm out on the runway heading) → up to 3 vias →
  FAF (8 nm on the extended centreline) → arrival threshold. Vias are typed (ICAO) or tapped
  on the nav map.
  - The relay measures progress, distance remaining and the 25/50/75 % splits along it.
  - The nav map draws it leg by leg with waypoint labels. At the arrival it draws the runway
    outline, a 10 nm dashed centreline and the FAF.
  - The HUD steers to the next waypoint and times the ETA on what's left of the route.
  - A route never changes `route_key`, and `distance_m` stays great-circle.
- **Arrival.**
  - The 3D beacon stands 500 m short of the arrival threshold (`DASH_BEACON_BACK_M`).
  - Inside 40 nm (`ILS_HUD_NM`), the approach HUD runs on the arrival runway, and the approach
    lights come up inside 20 nm. See "Approach aids".
  - The results row names the runway you landed on, and *(planned 10R)* when it differs. It costs
    nothing.
- **Line-up**, from any state (airborne or on the ground, gear up or down):
  1. Place on the slot of the card's `from_runway`.
  2. `GeoPhysics.gearDown()`: `controls.gear.target = 0` plus `setPartAnimationDelta`, verified
     2026-10-22. GeoFS's own `setGearDown` refuses on the ground.
  3. Place again on the same spot.
  4. Idle the throttle.
  - If the gear doesn't come down within 6 s, a toast says *Lower your gear (G)*.
  - *Gear down* is a checklist item.
  - There is no airstart and no green-flag throttle on a ground start.
- **Ground-start cup legs.** In a points cup or a Roguelike run, a gate course with
  `startType: "ground"` (the Bush Cup) lines every racer up the same way. The runway is the one at
  the airport nearest gate 1 that points toward gate 1, and racers are staggered by slot. No runway
  found = the old airstart.
- **Friend labels** on the nav map name the plane from the pilot's `aircraft_id` (new on `pos` and
  in presence) through `geofs.aircraftList`. A model swap's name still wins, and the fallback is
  *—*, never *?*.
- **Flags.** Client: `DASH_GEAR_DOWN`, `DASH_GEAR_TIMEOUT_MS`, `DASH_RUNWAYS`, `DASH_ROUTE`,
  `DASH_VIAS`, `DASH_BEACON_BACK_M`, `CUP_GROUND_LINEUP` (the arrival HUD's range is now `ILS_HUD_NM`). Server:
  `RACE_DASH_ROUTE`.
- **Old relay.** The client falls back to the old Dash and puts one note on the status line.

## Roguelike Cup (proto 13)

A run of 3–6 legs, each a gate course or a Dash. Results earn **parts**, and parts buy
**upgrades** in a 30 s shop between legs. Debuffs follow a hard landing or a DNF. The relay owns
the run and starts every leg itself.

- **Wire protocol:** [PROTOCOL.md](PROTOCOL.md) "Proto 13".
- **Catalog:** [data/upgrades.json](data/upgrades.json), which is data, not code.
- **In-sim checks:** ACCEPTANCE.md "Roguelike Cup (2-client, 3 legs)".

**Server.**

- `server/rogue_engine.py` is the pure engine: parts, catch-up, offers, purchases, debuffs, the
  summary and the Pacific-midnight clock.
- `app.py` wraps the two race engines through the run hooks (server/HOOKS.md): `leg_start`,
  `leg_results` with `hold_home`, then the shop, then `start_race()` or a Dash card.
- One `rogue_runs` row is written per finished run. `GET /api/rogue/runs` lists them, and the site's
  Cups page shows them.
- Env:

  | Variable | Default | Effect |
  |---|---|---|
  | `RACE_ROGUE` | on | `0` turns the Roguelike Cup off |
  | `RACE_ROGUE_SHOP_S` | 30 | shop length |
  | `RACE_ROGUE_LEG_LEAD_S` | 30 | gate-leg countdown |
  | `RACE_ROGUE_DASH_STAGING_S` | 120 | how long a run's Dash waits for unready entrants |
  | `RACE_ROGUE_CATALOG` | the baked-in catalog | path to the catalog |

**Client (race.js).**

- `CONFIG.ROGUE` (on) joins as `client_proto: 13`.
- **Host's Gate row:** a catalog cup's legs (up to 6), optionally ending on a Dash. Type its
  `from`/`to` ICAOs.
- **The shop:** cards with name, rarity, cost and what each upgrade does in plain words; the timer
  and your parts; 44 px buttons; Hide leaves a pill.
- **Leg results:** parts earned and why.
- **The summary card** at the end of a run.

What the relay grants becomes effects-engine records (source `cup`, granted):

- a `rogue-cap` governor while a leg is on: cruise × `ROGUE_CAP_FACTOR`, else `ROGUE_CAP_BASE_KT`,
  scaled by each `cap_pct`; Slipstream counts only while drafting (`ROGUE_SLIPSTREAM_CONE_DEG`);
- a chip per upgrade and debuff;
- Smoke's tint.

Climb kit reads `G.pitch()` × `ROGUE_PITCH_SIGN`. Extra boost charge refills the Boost slot
(`powerupsUse`). Shield capacitor lengthens the shield, and the relay's cap rises to match.

**Cup-leg placement (`CONFIG.CUP_LEG_PLACE`, on, the cup bug fix).** At a points-cup or run leg's
start, every racer is put at that leg's start instead of being left where they finished:

- **A gated course** is an airstart on the grid through `GeoPhysics.airStart` (geofs.flyTo),
  whatever its `startType` or the host's teleport rule (`legPlacement()`).
- **A Dash leg** lines up on the departure runway (`Dash.lineUp`, `GeoPhysics.placeOnGround`) and
  readies itself once the checklist agrees.

Outside a cup the grid rules are unchanged.

| CONFIG | Default | What |
|---|---|---|
| `ROGUE` | `true` | the Roguelike Cup (needs `ROAM` and a proto-13 relay) |
| `ROGUE_CAP_FACTOR` | `1.15` | the leg cap: this × the aircraft's cruise speed |
| `ROGUE_CAP_BASE_KT` | `350` | the leg cap for an aircraft with no profile |
| `ROGUE_SLIPSTREAM_CONE_DEG` | `30` | Slipstream: how far off your nose the pilot ahead may be |
| `ROGUE_PITCH_SIGN` | `1` | Climb kit: flip if GeoFS reports nose-up as negative |
| `CUP_LEG_PLACE` | `true` | cup and run legs place every racer at the leg's start |

## Gun Game (proto 14)

A ladder of progressively worse planes. Win a leg and you step down a tier. The first pilot to
win a leg on the final tier wins the game. If nobody does within the game's leg count, whoever is
furthest down the ladder wins. The relay owns the game, picks every leg by vote, and starts each
leg itself, like the Roguelike Cup.

- **Wire protocol:** [PROTOCOL.md](PROTOCOL.md) "Proto 14".
- **Ladder data:** [data/gungame.json](data/gungame.json), which is data, not code. It holds the
  airframes, the class defaults for searched aircraft, the presets and the settings bounds.
  [../liveries/gungame/ladder.json](../liveries/gungame/ladder.json) owns the heat colours and which
  paint each airframe wears. The two share airframe keys, and a test pins that.
- **In-sim checks:** ACCEPTANCE.md "Gun Game (2-client)".

**The rules.**

- The leg winner steps down one tier. Everyone else stays.
- **Catch-up** (a game setting, on by default): finishing last twice in a row steps you up one
  tier. A DNF counts as last.
- The game ends when someone wins a leg on the final tier, or after N legs (default 12). In the
  second case the furthest down the ladder wins; ties go to more leg wins, then the better place in
  the last leg.
- A pilot who arrives mid-game starts at tier 1.

**The ladder.** The group sets it on the staging card, the same way as the course vote:

- Preset chips (Short 4, Classic 6 by default, Long 10) are votes. A tie goes to the creator's vote.
- **Custom** is built by the game's creator. It takes 2–16 tiers from the airframes in
  `gungame.json`, plus any aircraft searched by name in `geofs.aircraftList`. A searched aircraft
  flies stock paint and gets its class's start speed (`class_defaults`, matched on the name). A
  joke model may only be the last tier.
- The creator also sets the leg count and catch-up.
- Any change resets everyone's ready.
- The card shows every tier in its heat colour before GO.

**Airframes are resolved by name** against `geofs.aircraftList` when the client loads. It tries
an exact match first, then a unique substring; the probe's `id_hint` breaks a tie and warns on a
mismatch. A name that doesn't resolve fails loudly in the console, and its presets are greyed out
on the card with the reason.

**Server.**

- `server/gungame_engine.py` is the pure engine. It handles catalog validation, `heat_for()` (a 1:1
  port of `tools/gungame_ladder.py`), ladder building, the staging vote and settings, progression,
  catch-up, both end conditions, the leg vote, and the summary.
- `app.py` wraps the two race engines through the run hooks (server/HOOKS.md):
  - staging, then the leg vote: three course-vote draws plus Surprise me, and one finished Dash
    route;
  - then the leg, through the same `_wrapped_start_leg()` the Roguelike Cup uses;
  - then `leg_results` with `hold_home`, then the next vote.
- Each finished game writes one `gungame_games` row and one `gungame_results` row per pilot
  (`pilot_id`, `won`, `tier_reached`, `counts`).
  - `GUNGAME_WINS` counts wins where `counts = 1`, meaning someone else flew a leg of that game. So
    a solo game never unlocks the champion liveries (1, 5 and 10 wins).
  - A pilot has a `pilot_id` only with the livery layer on (`joined` resolves the token), the same
    as liveries.
- Env:

  | Variable | Default | Effect |
  |---|---|---|
  | `RACE_GUNGAME` | on | `0` turns Gun Game off |
  | `RACE_GUNGAME_VOTE_S` | 20 | the leg vote; it closes early once everyone has voted |
  | `RACE_GUNGAME_LEG_LEAD_S` | 30 | gate-leg countdown (the aircraft swap happens inside it) |
  | `RACE_GUNGAME_DASH_STAGING_S` | 120 | how long a game's Dash waits for unready entrants |
  | `RACE_GUNGAME_CATALOG` | the baked-in `gungame.json` | path to the ladder data |

**Client (race.js `GunGame`).** `CONFIG.GUNGAME` (on) joins as `client_proto: 14`. At each leg start,
behind the countdown, it does this:

1. **The swap** (`CONFIG.GUNGAME_REAL_SWAP`, on). It calls `GeoPhysics.changeAircraft(id)`, which is
   `geofs.aircraft.instance.change(id)`, then waits for `instance.id` to match and settles for
   `GUNGAME_SWAP_SETTLE_MS` (1500). The swap happens only here and in the Dash line-up, never
   mid-leg, so the velocity reset never hits a flying pilot.
2. **Placement.** It uses the cup-leg grid (or the Dash line-up) at the tier's `start_kt`, by
   `GeoPhysics.airStart({flyTo: false, speedKt, throttle})`: `place()`, then velocity along the
   heading, then the throttle (default full). Each pilot is staggered for their own tier's speed.
3. **The look.**
   - Tier paint goes on through `Liveries.setOverride('gungame', factory, <factory>_gg_heat_<h> |
     <factory>_gg_final)`, or null (stock) when the catalog has no such paint.
   - A joke-model tier gets its model through `ModelSwap.setModeModel` instead. The final toilet is
     the gold one (`toilet-gold`, unlisted).
   - All of it is cleared when the game ends. Your aircraft stays as it is, and the summary offers
     *Back to my <plane>*.

**Fallback mode** (`GUNGAME_REAL_SWAP: false`):

- Every tier flies `gungame.json`'s `fallback.base` (the F-16).
- Each tier gets a `gg-cap` governor at the tier's `cap_kt` (source `gungame`, granted) and its
  `fallback_model`.
- The heat paint goes on the base, unless the tier wears a joke model.

**Everyone else** is computed locally from the server's tier state, with no new frame:

- their tier paint (`Liveries.setOthersOverride`, only with `LIVERIES_OTHERS`), matched by position;
  during a gate leg the positions come from standings;
- their joke model (`ModelSwap.setModeOthers`);
- heat-coloured map dots with a `T3/6` badge (`MapOverlay.setPilotStyle`).

Pos pings carry the tier's `aircraft_id` (in both modes), so the map and standings name the right
plane even when GeoFS multiplayer lags.

**On screen:**

- the Gate's Gun Game row;
- the staging card (preset chips, settings, the custom builder, the ladder, ready);
- the leg-vote card;
- a HUD tier badge (tier, plane, heat colour) and a ladder strip with everyone's position;
- each pilot's plane in the standings and results;
- the results card's tier move: *TIER DOWN!* with the old paint and the new one (catalog
  thumbnails when there are any, else the heat colours).

| CONFIG | Default | What |
|---|---|---|
| `GUNGAME` | `true` | Gun Game (needs `ROAM`, `ROGUE` and a proto-14 relay) |
| `GUNGAME_REAL_SWAP` | `true` | each tier flies its real aircraft; `false` = the fallback mode. Flip it if the second-client check (ACCEPTANCE GG 4) shows the old plane |
| `GUNGAME_SWAP_SETTLE_MS` | `1500` | wait after `instance.id` matches before placing (probe round 3) |
| `GUNGAME_SWAP_TIMEOUT_MS` | `5000` | give up on a swap and fly the current aircraft |

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

## Approach aids

ils-pro makes the right runway hard to miss, for a Dash arrival and for the Landing Challenge. Both
use one component, `Approach` in race.js. The Dash asks for its arrival runway (`Dash.arrivalRunway()`),
and an attempt in progress asks for its runway, which wins. A request lapses after 1.5 s unless it is
renewed, so an approach goes away when its mode stops asking. There is no relay change.

- **Runway truth.** `runwayTruth()` moves the server's runway onto the one GeoFS draws. It takes the
  `G.nearRunways()` record with the nearest threshold (within 300 m) and a heading within 10°, so
  parallels are told apart by position. GeoFS's threshold, heading, length and elevation are used
  from then on. Until nearRunways covers the airport, it's the server record, re-checked once a second.
  Guidance only: Landing Challenge scores stay against the server's runway.
- **World** (`makeApproachLayer`, `ILS_WORLD`, inside `ILS_WORLD_NM` = 20 nm, gone after touchdown):
  - the runway outlined in the theme accent, with its centreline and threshold bar
  - its ident over the threshold, fading in from 20 nm to fully shown at 15 nm
  - an approach light bar (every 60 m out to 900 m, crossbar at 300 m) with a rabbit strobe twice a second
  - lead-in lights every 0.5 nm out to the FAF (8 nm)
  - a 4-light PAPI on the left at 300 m, with transitions at 2.5 / 2.83 / 3.17 / 3.5°
  - optionally (`ILS_HIGHWAY`), highway-in-the-sky boxes every 1 nm from the FAF to 1 nm, the next one green

  It uses one PointPrimitiveCollection, one PolylineCollection and one LabelCollection, built once per
  runway and updated at 10 Hz by flipping flags and colours only.
- **HUD** (`ILS_HUD`, the Dash shows it inside `ILS_HUD_NM` = 40 nm). It extends the Landing HUD with:
  - a header: *KSEA 16L  ILS 163°*, distance and ETA
  - phases: ENROUTE → DESCEND (top of descent = FAF + height to lose / 318 nm) → INTERCEPT (heading from
    `approachSteer()`, with a chevron) → LOC CAPTURED (< 1 dot, inside 18 nm) → GS CAPTURED → MINIMUMS
    (200 ft AGL) → TOUCHDOWN. A capture holds to 1.5 dots, then falls back a step.
  - IAS against the aircraft's `approachKt`, coloured fast or slow
  - the stability pill's reasons in words
  - **WRONG RUNWAY — yours is 16L**, inside 5 nm, when another runway at the destination fits better
    (heading within 20°, cross-track under 300 m)
  - **TOO FAST**, from 15 nm, when IAS is more than approachKt + 60

  With `ILS_HUD` off, the plain Landing HUD remains.
- **Sounds** (`ILS_AUDIO`, WebAudio tone sequences through the same master gain and mute):
  - the outer marker (400 Hz dashes) at the FAF and the middle marker (1300 Hz dot-dash) at 0.5 nm
  - beeps at 500/100/50/30/10 ft AGL and a minimums tone
  - a chime on LOC and GS capture
  - a low warble each second while WRONG RUNWAY is up
- **Nav map** (the `approach` group): the chosen runway bold, the 10 nm centreline, the ±2.5-dot
  localizer feather, the FAF and the top of descent. Other runways at the destination are thin and grey.
- **Settings → Approach aids**: a per-pilot switch for each of HUD, runway lights, highway and sounds,
  default on and stored as `ils.*`. Each part fails closed on its own. A Cesium without the collections
  turns the world part off with one console warning.

## Liveries and the Garage tab (proto 12)

Garage paint shows on your jet in GeoFS, and you see the paint of the other FINSONLY pilots in your
relay room. LiverySelector only ever showed a livery to the pilot who picked it. The server side is
[server/GARAGE.md](server/GARAGE.md), and the wire format is [PROTOCOL.md](PROTOCOL.md) "Proto 12: liveries".

- **Painting.** `G.applyLivery(target, urls, slots)` and `G.restoreLivery(target)` are the only
  writes. They make the call LiverySelector makes, `geofs.api.changeModelTexture(model._model, url,
  {index})`, which probe round 4 verified in-sim on 2026-10-21. Your own model is
  `geofs.aircraft.instance.parts.root["3dmodel"]`. Another pilot's model is
  `multiplayer.users[key].model`, which only exists while GeoFS is drawing them. Before the first
  paint, the stock texture URL is read from the model's glTF image list. Restore puts it back.
- **What to wear** (`liveryResolve`): a game mode's override (`Liveries.setOverride(source,
  aircraftKey, liveryId | null)`, for Gun Game's tier paint) beats your equip, and your equip beats
  nothing. **Nothing is touched for a pilot whose livery resolves to null and who was never
  painted.** So LiverySelector keeps working for anyone who never equips in the Garage.
- **Where it comes from.** At boot the client loads `GET /liveries/catalog` and your
  `GET /garage/{pilot_id}`, sending your pilot_token as Bearer. Updates then come from the relay
  room (`joined.liveries`, `livery` frames) and from your own row in hub `presence`. That row is how
  an equip made on the web reaches you when you are not in a room. Only `/liveries/files/` URLs on
  `API_BASE` are ever loaded, because they are CORS-clean and `/static/*` is not.
- **Re-applying.** A 1 Hz tick builds a key from the aircraft id, the model object's identity, the
  joke flag and the URLs. It repaints only when that key changes. That covers your aircraft changing,
  theirs changing, a rejoin, a pilot coming back into draw range, and the joke model coming off.
  Joke-model pilots, including you, are never painted.
- **Other pilots** are matched to drawn GeoFS users by position, never by callsign: the nearest
  drawn user within 200 m, one to one (`matchDrawnUsers`, as on the nav map). Pilots are keyed by
  their `multiplayer.users` key. This only happens in a proto-12 room with `LIVERIES_OTHERS` on.
- **Texture slots.** The catalog's `texture_index` is used first. Where the catalog has none, the
  probe's values fill in (`LIVERY_PROBE_TABLE`): F-16 slot 3, Rafale `[main, spec]` into slots 1
  and 2, Rafale id 29, 757 id 238. **The 757 is held.** Its 11 part indices have not been read
  in-sim, so it is never painted, and the Garage tab says so.
- **Equipping.** In a proto-12 room an equip is a `livery` frame, sent at most one per 2.2 s with
  the newest per aircraft kept. The relay limit is 2 s. Changing aircraft in a room re-sends what
  the Garage has for the new aircraft. Outside a room, an equip is `PUT /garage/equip`.
- **The Garage tab** (dock → Garage) lists the current aircraft's liveries by category, each owned
  or locked with its unlock text. Each has Equip and Try on. Try on paints your jet only, for
  `LIVERY_TRY_ON_S` or until Close, and an equip ends it. Quick recolor offers a template, colour
  and text inputs and Render, shows the job's progress, then Try on and Equip. **Open full Garage on
  web** gets a code from `POST /garage/link`, opens `race.finsonly.net/#/garage?link=CODE` and shows
  the code.
- **Old servers.** If `/version` `features` has no `liveries`, the layer is off, with one
  status-line note and no fetches. A relay below proto 12, or one with no `liveries` in `joined`,
  never gets a `livery` frame and nobody else is painted, with one note per room. Your own paint
  still works from the Garage data.

| CONFIG | Default | |
|---|---|---|
| `LIVERIES` | `true` | the whole layer and the Garage tab |
| `LIVERIES_OTHERS` | `true` | paint the other pilots in your room |
| `LIVERY_TRY_ON_S` | `60` | how long a try-on stays on |

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
    parameter lists. Two verdicts lead `dashReadiness`:
    - `postSwapVelocity`: after the first swap and swap-back, two more swaps to the 172. Each records
      |v| and direction first, swaps, waits for the new instance (`swapDetect.detectedBy` says how: the
      id matches and `rigidBody.setLinearVelocity`/`v_linearVelocity` are usable, plus whether the
      instance or rigidBody object was replaced or mutated in place), then writes `setLinearVelocity`
      with the pre-swap direction at min(pre-swap speed, the new aircraft's cruise from its
      `definition` if a `cruise*` field with a unit in its name exists, else 60 m/s) and samples
      5 s: `holds`, `decays` or `snaps back` to the speed it had just before the write
      (`judgePostSwapVelocity`). The first run writes at once, the second after 500 ms.
      Needs more than 20 m/s of pre-swap speed.
    - `swapMultiplayer`: polls our own `multiplayer.lastRequest` every 100 ms from the swap call
      (up to 10 s) and reports whether the aircraft field (`ac`; `requestFieldsBeforeSwap` shows the
      request's fields) changed to the new id and how many ms after the swap call and after the new
      instance was usable. This is only our outgoing update: have a second client watch and confirm by eye.
  - **Run N-map attach test** (green): for 10 s wraps `ui.openMap`/`closeMap` and
    `geofs.map.startMap`/`stopMap`, adds one magenta circle to `geofs.api.map._map` and reports, for each
    open you do with N, which function fired, whether the panel became visible, whether the layer
    survived the open and whether the circle is on screen. Press N, N, N inside the 10 s.
  `window.__finsProbeTimeScale` (default 1) shortens every wait; the JSDOM smoke test uses it.
- **`recorder`**: the object holding GeoFS's flight-export `tape`: path, boolean flags, sample
  rate from the `ti` stamps, whether the tape is growing (`recordingNow`), and which live GeoFS
  values equal each `st`/`ct`/`ve`/`acc` slot of the newest entry. Start a recording first.

## Probe: livery discovery

Discovery for the livery runtime (putting a texture on our own aircraft and on other pilots'
aircraft, and the Gun Game ladder aircraft). `tools/probe.js` only; race.js is not involved. The
report gets `liveryReadiness` (right after `readMeFirst`, above `dashReadiness`), `liveries` and `liveryApply`.

**Before running:** load the **COMBINED** bookmark first so LiverySelector is loaded, wait for
your plane, then run PROBE. Have a friend online and flying the F-16 near you for part 5b.

- **Texture API** (`liveries.textureApi`): every texture-named function under `geofs.api`,
  `geofs.api.Model`, `geofs.aircraft`, the instance, `geofs` and `window`; LiverySelector's global
  `*livery*` functions with the texture calls found in their source (resolved to a path); the chosen
  call (one LiverySelector calls wins, then a `changeModelTexture` name match) with JS path, arity,
  parameter names and the first 300 characters of its source (`chosenSourceFull` and
  `modelChangeTextureSourceFull` have up to 3,500 characters, `liverySelectorFunctions[].srcFull` the
  loader). **Findings (2026-10-09 report):** `geofs.api.changeModelTexture(e, t, a)` takes the
  *Cesium* model (`part['3dmodel']._model`), a url and an options object; GeoFS's wrapper object has
  `changeTexture(url, opts)`, which is `changeModelTexture(this._model, url, opts)`. LiverySelector's
  `loadLivery(texture, index, parts, mats)` reads `definition.parts[parts[i]]['3dmodel']`. The apply
  test therefore tries the Cesium model first, then `model.changeTexture(url, opts)`.
- **Own aircraft** (`liveries.ownAircraft`): `instance.id`, the definition name, every part from
  `instance.parts` and `instance.definition.parts` (name, whether it has a 3D model object, the JS
  path to it, its texture lists: `*texture*` keys, glTF `images` uris, Cesium renderer textures,
  each as index + reference). The part and texture index LiverySelector would change are marked
  (`liveryApplyTarget`, `markedTarget`). The report lists only parts that have a model (the rest are
  names in `partsWithoutModel`) and a model shared by `instance.parts` and `definition.parts` once.
  LiverySelector's entry for the loaded aircraft comes from its own `window.getCurrentAircraft()`;
  `liveries.liveryDb` has entries for this aircraft and every ladder id, read from `liveryobj`, a
  script-scoped `const` that an indirect eval can see. LiverySelector keys `aircrafts` by aircraft path
  (and some by id, with an `acid` field), so entries are matched by id, `acid` or path
  (`matchedBy`). Failing all that, `liveryDbFetched` has the same file from jsDelivr, marked as not the
  loaded copy, and the target falls back to the F-16 slot 3 from `liveries/uv/f16.json`
  (texture.jpg in the F-16 glTF, confirmed 2026-10-09). The probe remembers each aircraft family (F-16 / 757 / Rafale) it has seen
  in `window.__finsProbeLiveryHistory`: **repeat the plain run in the 757 and the Rafale without
  reloading the page** and `liveryReadiness.ownPartAndIndex` fills in for all three.
- **Ladder aircraft** (`liveries.ladderAircraft`): id, name and every definition/model path field
  of each `geofs.aircraftList` entry whose name matches
  `/737|172|cub|glider|paraglider|su-?35|beaver|rafale|757|f-?16/i`. These feed the livery factory
  and Gun Game's name -> id resolution.
- **Other players** (`liveries.otherPlayers`): for `multiplayer.visibleUsers` (the one LiverySelector
  iterates, applying with `u.model.changeTexture(url, {index})`) and `multiplayer.users`. `users` holds every
  pilot on the server (1,066 on 2026-10-09) but only those near enough to be drawn have a `model` object
  (`model: null`, `models: []` for the rest), so the report gives a tally (`summary`: total, drawn, per aircraft)
  and describes only the drawn ones; callsigns can be empty, so the `users` key identifies a pilot. Per drawn user: JS path, the model object(s) and a descriptor, whether the structure
  matches ours (`partsLikeOurs`, `comparedToOurs`), and which field holds the aircraft id
  (`aircraft.field`, flagged `ambiguous` when the field is not aircraft-named).
- **CORS** (`liveries.cors`, runs with the report): an `Image` with `crossOrigin="anonymous"` is loaded
  from `race.finsonly.net/static/img/` and `raw.githubusercontent.com`, drawn to a canvas and read with
  `getImageData`: `loaded`, `tainted` (decoded but the canvas is tainted) or `blocked` (a missing
  `Access-Control-Allow-Origin`, a CSP, or a dead URL; `fetchCors` and `csp` say which).
- **Run livery apply test** (orange, opt-in, behind a confirm; the only write). It answers in a small
  yellow panel at the bottom centre, so the page stays live while you look at the jets:
  1. optionally wraps the texture function while you pick any livery in LiverySelector (press L) and
     records the exact call, then restores it;
  2. **own F-16**: applies `f16_starter_steve.webp` (livery-pack-2) with calls tried in turn
     (what LiverySelector was seen to do, the signature's roles, then `api(cesium, url, opts)`,
     `model.changeTexture(url, opts)` and the rest) until you say the jet changed. The report lists
     every attempt with its error, if any. Other aircraft skip this step (their parts and textures are still in the report);
  3. **another pilot's F-16** (skipped without one in range): applies `f16_gg_heat_7.webp` (bright red)
     to their model object, which is a local change on your screen only, and asks you (and your
     friend) whether it was red for you and unchanged for them;
  4. **persistence**: before each event the livery is re-applied, then you do the event and answer
     *still there* or *back to stock*: camera change, toggling the joke model on and off, the other
     pilot changing aircraft, the other pilot leaving and rejoining. A revert is followed by a
     re-apply to the current model: `survives`, `needs re-apply` (re-apply brought it back) or
     `reverts` (it did not). `modelObjectReplaced` records whether the model object itself was
     replaced, which is the usual reason a texture is lost;
  5. **restore**: applies the stock texture (the glTF image uri resolved against the model url and
     the page origin, e.g. `./texture.jpg` next to `/models/aircraft/premium/f16/f16.gltf`) on
     both and asks you to confirm. When no stock uri is readable the report says so; re-pick the stock
     livery in LiverySelector or re-select the aircraft.
- The compact copy each test button makes includes `liveryReadiness`, `liveries` and `liveryApply`.

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
