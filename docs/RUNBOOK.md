# FINSONLY Racing runbook

The one place for *how to do things*: helping a player, running a race night, adding content,
shipping a release, and keeping `race.finsonly.net` alive. For *what things are*, see
[REFERENCE.md](REFERENCE.md) (hotkeys, `CONFIG`, endpoints, env vars, all generated from the code),
[race/PROTOCOL.md](../race/PROTOCOL.md) (the wire protocol) and
[race/README.md](../race/README.md) (the module guide).

Each task has the same shape: **When** to use it, the **Steps**, how to **Verify** it worked, and
what to do **If it breaks**.

> **House rules (from [CLAUDE.md](../CLAUDE.md)):** never edit the live Caddyfile or restart
> containers without explicit approval, and never add Authelia to `race.finsonly.net`. Treat every
> `docker exec caddy caddy reload` and every container build or start below as a live change you
> confirm before running.

## Contents

- [Quick reference card](#quick-reference-card)
- [Player support](#player-support)
- [Race night](#race-night)
- [Content](#content)
- [Release](#release)
- [Deploy and server ops](#deploy-and-server-ops)
- [Backup, restore and rollback](#backup-restore-and-rollback)
- [Troubleshooting](#troubleshooting)
- [Debug tools](#debug-tools)
- [Dev environment](#dev-environment)
- [Working with Claude Code](#working-with-claude-code)

## Quick reference card

| What | Where |
|---|---|
| Public site and leaderboard | <https://race.finsonly.net/> |
| Health | `curl -sS -m 5 https://race.finsonly.net/health` → `{"ok":true,"courses":N,"tiles":{"proxy":true,"cache_writable":true,"imagery":"esri"}}`, N > 0 |
| Which build is live | `curl -s https://race.finsonly.net/version` → `{"sha", "version", "proto", "courses", "started_at"}` |
| API docs (FastAPI default) | <https://race.finsonly.net/docs> |
| Bookmarklet lines | [race/bookmarklet.txt](../race/bookmarklet.txt), also served by `GET /bookmarklet` |
| Ship to production | merge to `main`, then `git push origin main:deploy` (autodeploy picks it up within ~5 min) |
| Lobby smoke test | `python race/tools/smoke_lobby.py` (needs `pip install websockets` locally) |
| Hub smoke test | `python race/tools/hub_smoke.py wss://race.finsonly.net/ws/hub` |
| Redeploy by hand (on the box) | `race/server/redeploy.sh --dry-run`, then `race/server/redeploy.sh` |
| Autodeploy by hand (on the box) | `race/server/autodeploy.sh --dry-run` |
| Pause autodeploy | `touch <DATA_DIR>/.autodeploy_paused` |
| Deploy log | `<DATA_DIR>/deploy.log` |
| Client version in the browser | DevTools console: `__finsRace.version` |
| Debug overlay | **Alt+D**, or `__finsRace.debug.toggle()` |
| Robot test pilot | the **ROBOT** line after race.js; see [Robot test pilot](#robot-test-pilot) |
| Approach terrain check | `python race/tools/check_terrain.py --approach --source global --cache t.json` |
| Air-start spawn check | `python race/tools/check_terrain.py --starts --source global --cache t.json` |
| Tests | see [Dev environment](#dev-environment) |

`/version.version` is the **server** version (`SERVER_VERSION` in `app.py`, `1.5.0` at the time of
writing). The client version is `CONFIG.VERSION` in `race.js`. `DATA_DIR` is
`/mnt/user/appdata/stack/race/data` for the git-checkout layout the deploy scripts use (see
[Two layouts](#two-layouts-on-the-box)).

## Player support

### Install the bookmarklet

**When:** a new pilot, a new browser, or someone who has "an old bookmark".

**Steps**
1. Open [race/bookmarklet.txt](../race/bookmarklet.txt) and copy one line:
   - **COMBINED**: racing and LiverySelector in one click. This is the day-to-day one.
   - **PRIMARY**: racing only. It always pulls the latest `main`.
   - **FALLBACK** / **COMBINED FALLBACK**: the same, loaded from jsDelivr at the pinned tag
     `race-v1.0.0`. Only use these if the page blocks PRIMARY with a fetch/CSP error.
2. Create a new bookmark named `FINSONLY Racing` and paste the line as its URL.
3. On [geo-fs.com](https://www.geo-fs.com), wait until the plane is on screen, then click it.

**Verify:** the panel opens on the Ramp. In DevTools, `__finsRace.version` prints the current
`CONFIG.VERSION` and `__finsRace.config.API_BASE` is `https://race.finsonly.net`.

**If it breaks**
- `FINSONLY Racing failed to load: HTTP …` → GitHub is unreachable from that network. Try the
  FALLBACK line.
- A fetch/CSP error in the console → the page policy blocks the direct fetch. Use FALLBACK. If
  that is blocked too, a bookmarklet can't work on that page.
- A quick pre-check from the GeoFS console:
  `fetch('https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/race.js').then(r => r.status)`
  should print `200`.

### Stale code after a push (the CDN cache gotcha)

**When:** you pushed a fix and a pilot still has the old behavior.

- **PRIMARY / COMBINED** read `main` from `raw.githubusercontent.com`, which caches for about
  5 minutes. Wait, reload the GeoFS tab, and click the bookmark again.
- **FALLBACK** lines are pinned to `@race-v1.0.0` on jsDelivr, so they will **never** get anything
  newer until the tag in `bookmarklet.txt` moves (see [Release](#release)). A pilot on an old
  pinned FALLBACK sees the old UI and can't ready up in a current room. Have them switch to
  COMBINED.
- To pin a specific build on jsDelivr, the FALLBACK URL's `@race-v1.0.0` can be swapped for
  another tag or a commit SHA (`…/gh/eburgard7-cloud/geofs@<sha>/race/race.js`). *(Unverified:
  the `@<sha>` form is standard jsDelivr syntax but isn't used anywhere in this repo.)*
- Clicking a bookmark for a **different** version while one is already running tears the old one
  down and boots the new one. If the console says *v… is already running and cannot be replaced
  in place — reload the page*, reload the tab first.

### Rename a callsign

**When:** a pilot wants a different name, or two pilots collide.

**Steps:** click the callsign chip in the panel's top bar (any screen, including the Gate), type
the new name and press Enter. Or use **Settings → Leaderboard → Your name on the board**.

**Verify:** the room relabels the pilot at once (`<old> is now <new>` in the feed). Past runs follow
the pilot by `pilot_id`.

**If it breaks**
- *"callsign 'X' belongs to another pilot"* → someone else owns that name (ownership ignores
  case). To hand a name back, see [Free a callsign](#free-a-callsign-admin).
- *"callsign already connected in this room"* → someone in the room is using it right now.
- On a relay older than proto 7, the rename applies locally and takes effect at the next join.

### "It doesn't work" checklist

1. Is the plane actually on screen? The client waits up to `READY_TIMEOUT_MS` (180 s) for GeoFS to
   load, then gives up with *GeoFS never finished loading…*. Reload and try again.
2. Does `__finsRace.config.API_BASE` say `https://race.finsonly.net`? If it's empty, the panel
   opens straight into Solo with no Ramp at all.
3. Is the server up? Check `https://race.finsonly.net/health`.
4. Old bookmark? See [Stale code after a push](#stale-code-after-a-push-the-cdn-cache-gotcha).
5. **Alt+D** does nothing? The browser grabbed it. Run `__finsRace.debug.toggle()` instead.
6. A *COURSE MISMATCH* banner → that pilot's course list is out of date. Click **↻** (Solo's course
   picker) or reload.
7. Still stuck? Collect what [Debug tools](#what-to-paste-back-to-claude) lists and paste it back.

## Race night

### Before anyone flies

**Steps**
1. `curl -sS -m 5 https://race.finsonly.net/health` answers `{"ok":true,"courses":N}`, N > 0.
   Just redeployed? Run the [smoke test](#smoke-test-after-every-deploy) first.
2. Pick courses from [race/courses/CUPS.md](../race/courses/CUPS.md). Stick to ones it lists as
   flyable.
3. Pick a **room code** for the night (e.g. `friday-night`) and send it round. Room codes match
   `^[a-z0-9-]{1,32}$`.

### Host a lobby

**Steps**
1. The host goes first. The first pilot into a room is its host. From the Ramp, press **+ New
   room**, or type the code under **Have a room code?**.
2. On the Gate, **Copy invite** puts a `?room=…` link on the clipboard for everyone else. They can
   also **Join** the room from their Ramp, or use **Quick Match** (it drops you into the fullest
   boarding room).
3. The Gate draws three courses plus a *surprise me* wildcard. Everyone votes. As host, **Set
   course** picks one outright and overrides the vote. Changing the course or the rules clears
   every ready flag.
4. Everyone presses **READY UP** (or **Alt+Y**). About 3 s after the last engaged pilot readies up,
   the host's client starts the countdown on its own. A pilot idle for 60 s at the Gate shows as
   **Away** and doesn't hold the room up.
5. **Start anyway** (host) force-starts. Anyone not ready becomes a spectator for that race.

**Verify:** everyone lands on **Launch**, sees the same *Green light in N* and goes at the same
moment. The two countdowns should be within ~150 ms of each other.

**If it breaks**
- The countdown's going wrong → the host's **Abort to gate** on Launch returns everyone to the Gate.
  Ready flags are kept.
- *Relay: host only* → a guest tried a host action.
- Someone never sees the Gate or can't ready up → old bookmark (see above).

### Rules, cups and the rolling start

The default shell (`LOBBY_V2` on) has **no UI for rules or cups** yet. Those controls only exist in
the rollback UI (`LegacyUI`, see `race/docs/AUDIT.md` B2). The host can drive both from the DevTools
console:

```js
// host only; relay proto >= 4; only in the lobby or results phase
__finsRace.lobby.startCup('Friday Night', 4)        // name 1-32 chars, 1-12 races

// host only; clears every ready flag
__finsRace.lobby.setRules({ powerups: true, teleport: true })
```

- **Cups:** points (15, 12, 10, 8, 6, 4, 2, 1) add up across the cup's races. The results card and
  the room say which race is next. Starting a new cup replaces the running one. A race called off
  with back-to-lobby isn't scored. A cup's running total lives in the relay's memory, so a server
  restart loses it (finished races are already saved).
- **Rolling start:** on an **air-start** course, when every racer's client speaks relay proto 8,
  **Start** runs a hands-off pace lap on autopilot instead of the static grid. Pilots must keep
  their hands off the stick. Touching the controls drops you to the back (*Out of formation*, no
  DQ). At green, the autopilot disengages and the client checks the throttle. The server defaults
  `rules.rolling` to on, and the client's `setRules` doesn't send it, so there's no way to turn it
  off from the client today. A ground-start course, an older relay or any racer below proto 8 gets
  the classic grid.

### During and after a race

- **Jump start:** crossing gate 1 before GO adds `JUMP_START_PENALTY_MS` (5 s) to the lobby clock.
  It's never a DQ.
- **The race ends** when every racer has finished, dropped out or disconnected, or 2 minutes after
  the first finisher. Anyone still flying then is a DNF at the last gate they reported.
- **Results card:** **Esc** or **Close** dismisses it. The host picks **Next race** (back to the Gate)
  or **Rematch** (same course). Anyone can pick **Race the winner's ghost** or **Copy challenge
  link** (`?course=<id>&ghost=<callsign>`).
- **Call off a race that's already running** (not scored): `__finsRace.lobby.backToLobby()` in the
  host's console.
- **History:** finished races and cups show up on <https://race.finsonly.net/>, `GET /races/recent`
  and `GET /cups?open=1`.

### When someone disconnects

| What happened | What the relay does | What to do |
|---|---|---|
| A racer drops mid-race | They're a DNF at their last reported gate. A finisher who drops keeps their finish | They rejoin as a spectator until the host returns the room to the lobby |
| The host drops | Host passes to the longest-connected pilot | Nothing. The new host has the controls at once |
| Someone joins mid-race | They join as a spectator | Wait for Next race / Rematch |
| The server restarts | Every room, the lobby state and any running cup are wiped. Clients reconnect on their own, backing off to a 30 s cap (`POWERUP_RECONNECT_MAX_MS`) | Whoever's back first is host. Start a fresh cup. Finished races are safe in SQLite |

### Landing night

The **Landing** tab (`CONFIG.LANDING`) is solo: no room, no relay. Everyone flies the same runway or
cup and compares scores on the board afterwards.

1. **Landing** tab. Runways are grouped by landing cup (the leading word of each runway's `notes`,
   see [LANDING_CUPS.md](../race/runways/LANDING_CUPS.md)). The chips show the difficulty and what
   makes a runway hard. Under them are your best and the top 3 from `GET /landing-leaderboard`.
2. **Fly approach** spawns you on the runway's approach: 3 nm out on a 3° glidepath by default, or
   the runway's own `approach` override. You're at your aircraft's approach speed
   (`AIR_START_PROFILES.approachKt`) with the throttle at `APPROACH_THROTTLE`, hands on. A runway
   with an `aircraftId` refuses to spawn you in anything else and names the aircraft to switch to.
3. The **Landing HUD** (left edge) shows the runway ident, distance to the threshold, a localizer
   and a glidepath scale (real-ILS sense: fly toward the diamond), height against the path, sink
   rate, IAS, height above ground, and a STABLE / CHECK / UNSTABLE pill (±1 dot, 1000 ft/min,
   -5/+20 kt). **Alt+H** hides it along with the race HUD. Race.js leaves **Alt+I** alone, so it
   still reaches GeoFS.
4. Land and roll to a stop. When you've slowed below 15 m/s the detector's raw touchdown goes to
   `POST /landings`, the server scores it, and the **scorecard** shows the server's breakdown: zone,
   sink, centreline, crab/bank, rollout and bounces, with your PB and rank. **Retry** respawns at
   once, and **Next runway** goes to the next one in the picker. A touchdown that never slows down
   within `LANDING_SETTLE_TIMEOUT_MS` (60 s) isn't scored.
5. **Landing Cup:** pick a cup and **Start cup** to fly its four runways back to back, one attempt
   each, with no Retry. The last scorecard is the cup total. Bush Strips and "More runways" are
   practice only.

A runway's optional `env` (the same schema as a course's) is applied at spawn and your own weather
is put back when the attempt ends. Against a server without `/runways` the tab says so once. One
without `/landings` still flies, and the scorecard shows the detector's own numbers marked not scored.

## Content

### Add a course

**When:** someone flew a new route and wants it shared.

**Steps**
1. In the sim, open the **Course editor**. Set a name and radius (150 m is forgiving, 60 m is
   spicy).
2. Fly the route and press **Alt+G** at each gate. The first gate is the start and the last is the
   finish. **Alt+U** undoes the last gate. **Alt+B** / **Alt+Shift+B** drop item boxes (one, or a
   row of three 120 m apart).
3. **Save and load**, then **Copy JSON**. If the clipboard is blocked, it's also in the JSON box.
4. Save it to a file and import it:
   ```bash
   python race/tools/add_course.py path/to/pasted.json
   python race/tools/add_course.py path/to/pasted.json --cup "Alpine Cup" --difficulty medium
   ```
   This validates like `Course.normalize()`, writes `race/courses/<id>.json` and upserts
   `race/courses/index.json`, which it keeps sorted by id. `--cup` and `--difficulty`
   (`easy`/`medium`/`hard`/`tight`) are written to the index entry. A re-import without them keeps
   the entry's existing values.
5. Pin its hash for the cross-language test. Add `"<id>": "<hash>"` to
   `race/test/course_hashes.json`, with the hash from:
   ```bash
   python -c "import json,sys; sys.path.insert(0,'race/tools'); import add_course; print(add_course.course_hash(json.load(open('race/courses/<id>.json'))))"
   ```
6. If it belongs to a cup, import it with `--cup`/`--difficulty` (step 4) and list it in
   [race/courses/CUPS.md](../race/courses/CUPS.md).
7. [Check it against terrain](#terrain-check), run the tests, then commit and push. Pilots press
   **↻** to see it.

**Never overwrite a course's geometry in place.** The leaderboard is keyed by a hash of the gate
geometry plus the aircraft lock, so moving any gate starts a fresh board. `add_course.py` refuses
to overwrite a course whose geometry changed unless you pass `--force`. For a re-flown route, bump
`version` in the JSON and re-import it deliberately, like the gorge-run and crater-rim repairs to
version 2. Item boxes are left out of the hash, so adding or moving them never resets a board.

**Designing a course without flying it:** `race/tools/design_course.py` turns a hand-picked
waypoint list into a course whose gate altitudes hug the terrain. It fits each gate as low as the
[terrain check](#terrain-check) margin allows, can snap waypoints to the valley floor, places item
boxes, supports circuit laps and ground starts, and can draw a hillshade preview PNG. The spec
format is in the script's docstring. Every course it writes passes `check_terrain.py` at the same
`--margin` and `--source`. Then import it with `add_course.py` as above. Most of the 17 cups in
CUPS.md were built this way.
```bash
python race/tools/design_course.py spec.json --out course.json --preview route.png
python race/tools/design_course.py spec.json --out course.json --margin 60 --pad 20   # bush / pylon rules
```

**Verify:** `python -m pytest race/test/test_add_course.py race/test/test_design_course.py -q`, then the full
[test suite](#run-the-tests). `test_server.py` and `run.js` both fail if `course_hashes.json` doesn't
list every indexed course with the right hash.

**If it breaks**
- *"already exists with different gate geometry"* → see the rule above.
- Any field other than `id`/`name`/`version`/`aircraftId`/`startType`/`itemBoxes`/`gates` is
  silently dropped by both the client and `add_course.py`. Keep course notes in CUPS.md. That
  includes lap counts: a Pylon Cup circuit is stored unrolled (every lap's gates in order), and its
  laps × gates live in CUPS.md's Pylon table. The planned native `laps` field is designed in
  [race/docs/LAPS.md](../race/docs/LAPS.md).
- A Bush Cup course ships `aircraftId: null` until the real GeoFS ids are known. Set it with
  `add_course.py --force` **before** anyone sets a time, because the aircraft lock is part of the
  hash. The ids come from [Physics Lab A0/A1](#physics-lab-sections), and the design is in
  [race/docs/BUSH_MODE.md](../race/docs/BUSH_MODE.md).

### Terrain check

**When:** before any new or hand-placed course goes on a race night.

**Steps**
```bash
python race/tools/check_terrain.py                                   # the default course ids
python race/tools/check_terrain.py --all --cache terrain-cache.json  # every course, cached
python race/tools/check_terrain.py gorge-run --step 100 --margin 200 # tighter sampling
python race/tools/check_terrain.py --json                            # machine-readable
```

It samples every gate and every `--step` metres (default 250) along each leg. It never touches
`race/courses/`. The only file it writes is the `--cache` you ask for.

| Finding | Means | Fails the course |
|---|---|---|
| `BURIED` | the route is inside the ground | yes |
| `CLIPPING` | part of a gate's sphere is underground | yes |
| `LOW` | above ground but under `--margin` (150 m by default) | yes, unless `--warn-low` |

Exit codes: 0 all passed, 1 something failed, 2 the check couldn't run.

#### Start corridors (`--starts`, `--fix-starts`)

**When:** after adding or moving any air-start course (a moved gate 1 or gate 2 makes its `start`
block stale; `--starts` says STALE), and before a race night on a new course.

The gate/leg check above never looked at where an air start actually puts people. `--starts` does:
for every air-start course it samples the grid's straight-in line to gate 1, out to 180 kt × 45 s
(the longest lead preset), across all 12 grid slots at 80 m spacing, plus the rolling start's
whole path and oval. Clearance under 150 m at the lowest spawn altitude is a FAIL. Ground-start
courses are SKIP.

```bash
python race/tools/check_terrain.py --starts --source global --cache t.json          # report
python race/tools/design_course.py --fix-starts --source global --cache t.json --dry-run  # what it would write
python race/tools/design_course.py --fix-starts --source global --cache t.json      # write start blocks for every FAIL
python race/tools/design_course.py --fix-starts crater-rim --force --source global --cache t.json  # redo one
```

`--fix-starts` writes a `start` block into the course file (never type one by hand). It searches
inbound bearings within ±75° of gate1->gate2 for a line that clears, else keeps the nearest good one
and sets a spawn altitude floor; it also records the highest terrain under the corridor and the
formation, which the rolling start holds 300 m + 150 m above. The block is **not** part of
`course_hash`, so leaderboards and ghosts are untouched, and the tool refuses to write if the hash
would change. The client also re-places any air start that lands under 120 m AGL
(`SPAWN_TERRAIN_GUARD`), since GeoFS's terrain can differ from the Terrarium tiles. Commit the
changed course files; no `course_hashes.json` change is needed.

**Sources (`--source`):**
- `auto` (default): `usgs` inside the CONUS bounding box, `global` everywhere else. If USGS
  can't be reached at all, CONUS points fall back to `global` and the source name in the report
  says `[USGS unreachable: CONUS fell back to global]`.
- `global`: AWS Terrain Tiles (Terrarium PNG, `s3.amazonaws.com/elevation-tiles-prod`),
  worldwide, zoom 12 (`--zoom`), bilinear, decoded as `R*256 + G + B/256 − 32768`. Tiles are
  cached in `<cache>.tiles/z/x/y.png` next to `--cache`, so a re-run is offline. Coarser than
  USGS (~38 m/px at the equator, ~27 m at 45°), so it smooths narrow canyon walls and
  sea stacks. A `global` PASS on a slot canyon still wants a fly-through.
- `usgs`: USGS 3DEP point queries. US-only, and at 1–10 m resolution it's finer than what
  GeoFS draws. One request per sample, so it runs on a thread pool and likes a `--cache`.
- `cesium`: needs `CESIUM_ION_TOKEN`. **Don't use it from the work network.** `api.cesium.com` is
  unreachable there (CLAUDE.md), and this source has only ever run against synthetic tiles.
- `file`: a JSON sample table via `--samples-file`, no network.

Neither source has buildings, bridges or other structures in it. CUPS.md's terrain-status section
lists the courses where that matters (Kai Tak, Budapest, Paris, Tokyo Bay and others). To check
against what GeoFS itself renders, use the in-browser
[terrain probe](#terrain_probejs-read-only).

**If it breaks:** treat a marginal `LOW` as "go and look". A `BURIED` by hundreds of metres is
real. Re-fly the route and re-import it as a new version. Don't hand-edit coordinates.

### Add a runway

**When:** a new landing runway is needed (the Landing tab, the robot's APPROACH mode and landing scoring all read it).

A runway is `race/runways/<id>.json` plus an entry in `race/runways/index.json`, using
`touchdown.js`'s field names: `thr_lat`, `thr_lon`, `heading_deg`, `length_m`, `width_m`, plus
`id`, `name`, `version`, `thr_alt_m` and `zone: {min_m, max_m}`. The server reads that directory
at startup (`load_runways()` in `app.py`, from `RACE_RUNWAYS_DIR`) and skips a broken entry with a
warning. Its `EMBEDDED_RUNWAYS` (the three launch runways) are only a fallback for a missing or
empty directory. The current set and the landing cups are in
[race/runways/LANDING_CUPS.md](../race/runways/LANDING_CUPS.md).

**Steps**
```bash
python race/tools/add_runway.py TNCM 10 --notes "Maho Beach approach"
python race/tools/add_runway.py LOWI 26 --name "Innsbruck 26 (Inn valley)" --dry-run
```
`add_runway.py ICAO END` builds that end from OurAirports data. It downloads the CSVs to
`~/.cache/finsonly-ourairports` on first use (`--csv-dir`, `--refresh`). It applies a displaced
threshold, converts ft to m (falling back to the airport elevation, noted), cross-checks the
heading against the end coordinates, and uses the same zone rule as Physics Lab's `defaultZone`.
It matches FAA local codes (e.g. `S10`) and ignores leading zeros in end idents. It keeps the index
sorted, and it refuses closed runways, unknown ends and geometry changes without `--force`.
`--derive-missing-end` computes a missing end from the other one (opt-in, noted in the file). The
running server picks up a new runway on its next restart (the next deploy).

**Verify:** `python -m pytest race/test/test_add_runway.py -q`, then
`test_runways_json_files_match_embedded_registry` and the `test_load_runways_*` tests in
`race/test/test_server.py`. Add the new id to the pinned hash table in `test_add_runway.py`.
Bumping a runway's `version` after re-tuning starts a fresh board (`runway_hash()` covers id +
version). Fly one landing on it in-sim to confirm GeoFS's runway sits where OurAirports says.

**Optional fields** (none of them part of `runway_hash()`, so adding one never resets a board;
`validate_runway()` rejects bad values and the server skips that runway with a warning):
- `aircraftId`: a GeoFS aircraft id string (`"13"` Beaver, `"1"` Cub, `"2"` C172, `"7"` F-16). The
  Landing tab won't spawn anything else there.
- `approach`: `{distNm 0.5-10, angleDeg 2-8, altOffsetM -300-1500, headingOffsetDeg -90-90}`, each
  optional. It's the spawn for a terrain-constrained airport. `headingOffsetDeg` swings the whole
  inbound line about the threshold (arrive down a valley), still aimed at the threshold. Choose it
  with the approach terrain check below, then confirm it with the robot's APPROACH mode.
- `env`: a course-style env block (weather, time, buildings), applied for the attempt.

### Approach terrain check

**When:** a new runway, or a runway whose `approach` changed.

```bash
python race/tools/check_terrain.py --approach --source global --cache t.json        # every runway
python race/tools/check_terrain.py --approach vnlk-06 vqpr-15 --source global --cache t.json
```
It profiles the path `landingSpawn()` puts a pilot on (3 nm / 3° or the runway's `approach`), every
100 m from the threshold out to max(spawn, 5 nm), against AWS Terrarium z12 tiles. `api.cesium.com`
and opentopodata are unreachable from the work network, and Terrarium isn't. The path must clear
terrain by min(60 m, half its own height) outside 0.5 nm, and the spawn by 150 m. These are the same
rules the robot's TERRAIN and SPAWN_LOW use. Terrain beyond the spawn and inside short final is
reported, never failed. A FAIL prints the shallowest clearing angle, and past 8° it says the runway
needs a custom path (`headingOffsetDeg`). The 2026-09-24 run over all 26 runways led to the
provisional overrides on `vnlk-06`, `vqpr-15`, `lpma-05`, `3u2-17`, `3u2-35`, `s81-04` and `s81-22`
(each marked PROVISIONAL in its `notes`). `lflj-22` clears at the default 3°. Treat these as a
starting point, then fly them with the robot.

### Add or assign a joke model

**Assign a model to a pilot:** edit [race/models/assignments.json](../race/models/assignments.json)
(callsign → model id, case-sensitive, matching `geofs.userRecord.callsign`) and push. The client
fetches it with a cache-bust query, so it shows up within about a minute. A pilot's own pick under
**Your plane** overrides it.

**Add or regenerate models:**
```bash
cd race/tools && pip install pygltflib numpy && python build_models.py
```
This writes twelve low-poly `.glb` files (vertex-colored, no textures, no third-party meshes,
<120 KB and <5k triangles each) and `race/models/index.json`. There are the original six
(goldfish, bratwurst, traffic cone, toilet, parcel box, cow) plus the v2 pack (rubber duck, cheese
wedge, beer stein, pizza slice, flying couch, shopping cart). Models are nose along +X, up along +Y,
scaled so the longest axis is about 15 m, to match the F-16. The v2 six are also re-centred on
their area-weighted centroid (origin ≈ CG). The first six are left byte-for-byte as shipped.
Regenerating on a different numpy can drift the old files by float noise, so `git checkout` them if
only their bytes changed. If a model looks rotated in-sim, fix its
`offset.headingDeg/pitchDeg/rollDeg` in `index.json`, not the mesh.

`python race/tools/render_models_preview.py` (needs matplotlib) redraws
[race/models/preview.png](../race/models/preview.png), a front/side/top contact sheet of every
indexed model.

**Verify:** `cd race/test && pip install pygltflib numpy pytest && python -m pytest test_models.py test_models_pack.py -q`.
`test_models_pack.py` checks the committed files: the glTF header, no textures, the size and
triangle caps, extents relative to the goldfish, the centroid, and that the index and
assignments resolve.

### Addons

Third-party GeoFS addons that can run next to FINSONLY Racing are pinned by commit SHA in
[race/addons.json](../race/addons.json) and documented in [race/ADDONS.md](../race/ADDONS.md) (what
each one does, its hotkeys, its license status). None of them is wired into `race.js`.
```bash
python race/tools/check_addons.py            # schema, pinned SHAs, hotkey collisions with race.js
python race/tools/check_addons.py --offline  # skip the SHA check (no network)
```
`--strict` treats a hotkey collision as an error. **Verify:** `python -m pytest race/test/test_check_addons.py -q`.

### Add a livery

**When:** a new Finsonly Air skin.

**Steps**
1. Add the texture image at the repo root (or under `rafale/` for the Rafale). **Never rename or
   move an existing texture.** `airline.json` and LiverySelector load them by raw GitHub URL.
2. In [airline.json](../airline.json), add `{ "name", "texture": ["https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/<file>"], "credits" }`
   to the right aircraft's `liveries` list. The aircraft keys are `GXD04N_126645_238` (757-200),
   `7` (F-16) and `rafale` (Rafale M, which takes four textures in its `labels` order).
3. Commit and push to `main`.

**Verify:** load COMBINED, press `l` in GeoFS, and find the new skin under Finsonly Air.

## Release

**When:** a user-visible change is ready to go live.

**Rule:** no version bump without proof on the live system. Neither `PROTO` in `app.py` nor
`CONFIG.VERSION` in `race.js` gets bumped unless **both** of these passed against the deployed
relay for that build: a full [race/ACCEPTANCE.md](../race/ACCEPTANCE.md) run (two clients on
geo-fs.com), and `python race/tools/smoke_lobby.py` (all 12 steps). Green test suites are necessary
but not enough (race/PROTOCOL.md "Versioning").

**Steps**
1. Work on a branch. Run the [tests](#run-the-tests) before every commit.
2. Open a PR. CI (`.github/workflows/test.yml`) runs the JS suite, the server pytest suite, ruff
   and shellcheck.
3. Run the ACCEPTANCE rows for what changed in-sim, plus `smoke_lobby.py`, and fill in the
   "Last passed" column.
4. Bump `CONFIG.VERSION` in `race.js` (user-visible change) and add a
   [race/CHANGELOG.md](../race/CHANGELOG.md) entry.
5. Merge the PR to `main`.
6. Ship it:
   ```bash
   git push origin main:deploy
   ```
7. *(Optional)* To move the FALLBACK pin, cut a tag and repoint the two FALLBACK lines in
   `race/bookmarklet.txt`:
   ```bash
   git tag -a race-vX.Y.Z -m "FINSONLY Racing vX.Y.Z" && git push origin race-vX.Y.Z
   ```
   `race/test/run.js` fails if a pinned tag doesn't exist. It only prints a note when the pin
   merely lags `CONFIG.VERSION`.

**Verify:** within ~5 minutes, `curl -s https://race.finsonly.net/version` shows the new `sha`, and
a changed `started_at` confirms the container actually restarted. Then run the
[smoke test](#smoke-test-after-every-deploy).

**If it breaks:** see [Autodeploy](#autodeploy) (`deploy.log`) and
[Roll back](#roll-back-a-deploy).

## Deploy and server ops

### Two layouts on the box

The repo describes two ways the server can be laid out on Unraid. **Check which one is live before
running anything:** `docker inspect <container> --format '{{json .Mounts}}'`.

| | Git-checkout layout (the scripts) | scp layout (manual) |
|---|---|---|
| Code | `/mnt/user/appdata/stack/race/app` (a checkout of this repo, on `deploy`) | `/mnt/user/appdata/stack/race-api/` (repo-shaped copy) |
| Data (`race.db`) | `/mnt/user/appdata/stack/race/data`, mounted at `/app/data` with `RACE_DB=/app/data/race.db` | `/mnt/user/appdata/race-api`, mounted at `/data` (the image default `RACE_DB=/data/race.db`) |
| Image / container | `race` / `race` | `race-api` / `race-api` |
| Used by | `redeploy.sh`, `autodeploy.sh` | `compose.snippet.yml`, the [manual deploy](#first-time-or-manual-deploy-scp-layout) |

Both run on the external **`proxy`** network that Caddy fronts, as user **`99:100`** (Unraid's
`nobody:users`, the Dockerfile's `USER`). Both mount the checkout's `race/courses` read-only at
`/app/courses` with `RACE_COURSES_DIR=/app/courses`, so a `git pull` updates the course list with no
rebuild. The server re-reads it whenever a room draws its vote. Both also mount `race/runways`
read-only at `/app/runways` with `RACE_RUNWAYS_DIR=/app/runways`. Those are the landing-mode runways,
read once at startup. If the directory is missing or empty, the server falls back to its three
embedded runways and `docker logs` shows `runways loaded: 3`. Both also mount `race/models`
read-only at `/app/models` with `RACE_MODELS_DIR=/app/models`, served at `GET /models/*` for the
site's own globe view (joke-plane `.glb` files, `index.json`, `assignments.json`) — this is what
lets the site's CSP stay `connect-src 'self'` instead of reaching across to raw.githubusercontent.com.

Pointing a deploy at the wrong data directory starts a fresh, empty `race.db`, with no runs, no
pilots and a new token for everyone. That's the 2026-09-23 incident. Set `RACE_DATA_DIR=` if the
live data isn't at the default.

### Autodeploy

**When:** always on. This is how `main` reaches production.

`race/server/autodeploy.sh` runs every 5 minutes from the Unraid **User Scripts** plugin as
`race-autodeploy`. Each run:
1. Exits quietly if `<DATA_DIR>/.autodeploy_paused` exists, or another run holds the lock.
2. `git fetch origin deploy`, and exits quietly if `origin/deploy` equals `<DATA_DIR>/.deployed_sha`.
3. Reads GitHub's check-runs for that SHA (public API, no token). Pending, failed or no CI gets a
   `SKIP <sha> ci=pending|failed|none` line in `deploy.log` and nothing else. A commit pushed
   straight to `deploy` that was never on `main` has no CI and sits at `ci=none` forever, by design.
4. Checks out the SHA, tags the current image `race:prev`, and runs `redeploy.sh`.
5. On success it writes `.deployed_sha` and logs `DEPLOY <sha> ok`. On failure with a healthy
   container it logs `FAIL <sha> redeploy-error-pre-swap`. On failure with an unhealthy container
   it runs `race:prev` with the same flags, re-polls `/health`, and logs `ROLLBACK <sha> to prev
   ok` (or `FAILED`, which needs a manual look). A rollback that comes up healthy then runs the
   same step-7 prune as `redeploy.sh` (see [below](#redeploy-by-hand-redeploysh)), which protects
   the `race:prev` image it's now running. `.deployed_sha` is left alone on failure, so the next
   tick retries.

Flags other than `--dry-run` (e.g. `--allow-empty-db`, `--no-prune`) and env vars such as
`RACE_ALLOW_EMPTY_DB=1` pass straight through to `redeploy.sh`. `--no-prune` is also honoured by
`autodeploy.sh` itself for the rollback path. The env overrides are listed in
[REFERENCE.md](REFERENCE.md#deploy-scripts).

**Install (once)**
1. Community Apps → search **User Scripts** (by Squid) → Install.
2. Settings → User Scripts → **Add New Script** → name it `race-autodeploy`.
3. Put exactly one line in it:
   ```bash
   /mnt/user/appdata/stack/race/app/race/server/autodeploy.sh
   ```
4. Schedule **Custom** → `*/5 * * * *`.
5. Run it once by hand with `--dry-run` first, to confirm `APP_DIR` really is a checkout of this repo
   on `deploy`.

**Pause it:** `touch <DATA_DIR>/.autodeploy_paused` before any manual work on the box, and remove
the file to resume. Its lock only guards against itself, not against a hand-run `redeploy.sh`.

**Verify:** `deploy.log` gets one line per *eventful* run (a skip, deploy, failure or rollback), and
nothing when nothing changed.

**If it breaks:** the User Scripts plugin has gone missing before. `autodeploy.sh` and
`redeploy.sh` are both safe to run by hand from the box, `--dry-run` first.

### Redeploy by hand (`redeploy.sh`)

**When:** autodeploy is paused or broken, or you want to watch a deploy step by step. (Pause
autodeploy first.)

**Steps**
```bash
race/server/redeploy.sh --dry-run   # print every command, run nothing (and what step 7 would prune now)
race/server/redeploy.sh             # do it
race/server/redeploy.sh --no-prune  # do it, but skip step 7
```

What it does, in order:
1. `git pull` in `APP_DIR`.
2. **2a:** checks `race.db` is the live board. It aborts only on a real wrong-`DATA_DIR` signal:
   `race.db` is missing but `.deployed_sha` says a board was deployed here, or the file has no
   `runs` table, or the running container's `RACE_DB` isn't `/app/data/race.db`. Zero runs alone
   just logs *board is empty*. Override with `--allow-empty-db` or `RACE_ALLOW_EMPTY_DB=1`.
3. **2b:** `chown -R 99:100` the data dir, then proves a `99:100` write works.
4. **2c:** backs up `race.db` with SQLite's online backup to `race.db.bak-<YYYYmmdd-HHMMSS>`, and
   aborts if the copy is empty.
5. **3:** runs `migrate_modes.py` (if present) in a throwaway `python:3.12-slim`.
6. **4:** `docker build -f race/server/Dockerfile --build-arg GIT_SHA=<sha> -t race` from the
   checkout root.
7. **5:** replaces the container (`--user 99:100`, `--network proxy`, the data, courses and
   runways mounts). If `<DATA_DIR>/race.env` exists it's passed with `--env-file` (see
   [Secrets for the container](#secrets-for-the-container-raceenv)); if not, the container starts
   exactly as before.
8. **6:** polls `https://race.finsonly.net/health` for up to 30 s, tolerating 502 during boot.
   `PASS` needs a 200 **and** `courses > 0`.
9. **7 (PASS only):** `race/server/prune.sh`, sourced by both deploy scripts. It runs
   `docker image prune -f` (dangling images only, never `-a`) and keeps only the 10 newest
   `race.db.bak-*` backups. Skip it with `--no-prune`.

A failed backup or migration stops the script before anything is rebuilt, with the old container
still serving. It never touches Caddy.

#### Secrets for the container (`race.env`)

**When:** you want `RACE_ADMIN_TOKEN` (the robot's House ghost upload) or any other secret env on
the `redeploy.sh`-layout container without committing it.

```bash
cd /mnt/user/appdata/stack/race/data          # DATA_DIR: outside the git checkout
printf 'RACE_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" > race.env
chmod 600 race.env
race/server/redeploy.sh --dry-run             # step 5 says "Passing .../race.env" and shows --env-file
```

One `KEY=value` per line (Docker `--env-file` format: no quotes, no `export`). The script prints
the file's path, never its contents. Delete the file and redeploy to drop the secrets. The
compose layout sets the same variables in its own `environment:` block instead.

Step 7 never runs after a FAIL, so a failed deploy keeps every image and backup. Because it prunes
dangling images only, Docker's rules stop it from removing `race:prev` or the image a container is
using. If either of those IDs ever shows up as dangling, it skips the image prune entirely. It
prints a `PRUNE images_reclaimed=… backups_removed=… backup_bytes_freed=… backups_kept=…` line and
appends it to `DATA_DIR/deploy.log`.

**Verify:** it prints `PASS`, and `docker logs race` shows `courses loaded: N from /app/courses`
and `runways loaded: M from /app/runways`, where M is the number of entries in
`race/runways/index.json`. M = 3 means it fell back to the embedded runways, so check the runways
mount. Then run the [smoke test](#smoke-test-after-every-deploy). The poll
only proves `/health` answered.

### First-time or manual deploy (scp layout)

**When:** bringing the server up on a fresh box, or the scripts can't run. This is the old
`DEPLOY_CHECKLIST.md` path. Don't run it unattended.

1. **DNS:** `race.finsonly.net` as an A record to the public IP, DNS-only, like the other
   subdomains.
2. **Copy the app** as a repo-shaped directory. The image builds from the repo root and copies
   `race/server/*`, `race/bookmarklet.txt`, `race/courses/`, `race/runways/` and `race/models/`. The
   server refuses to start with zero courses, and falls back to its three embedded runways if
   `race/runways/` is missing:
   ```bash
   mkdir -p /mnt/user/appdata/stack/race-api/race/server/static /mnt/user/appdata/stack/race-api/race/courses /mnt/user/appdata/stack/race-api/race/runways /mnt/user/appdata/stack/race-api/race/models
   scp race/server/{app.py,migrate_modes.py,requirements.txt,Dockerfile} unraid:/mnt/user/appdata/stack/race-api/race/server/
   scp race/server/static/* unraid:/mnt/user/appdata/stack/race-api/race/server/static/
   scp race/bookmarklet.txt unraid:/mnt/user/appdata/stack/race-api/race/
   scp race/courses/*.json unraid:/mnt/user/appdata/stack/race-api/race/courses/
   scp race/runways/*.json unraid:/mnt/user/appdata/stack/race-api/race/runways/
   scp race/models/* unraid:/mnt/user/appdata/stack/race-api/race/models/
   scp .dockerignore unraid:/mnt/user/appdata/stack/race-api/
   ```
   Check it landed: `ls -la /mnt/user/appdata/stack/race-api/race/server/ /mnt/user/appdata/stack/race-api/race/courses/ /mnt/user/appdata/stack/race-api/race/runways/ /mnt/user/appdata/stack/race-api/race/models/`.
3. **Data directory**, owned by the container user:
   ```bash
   mkdir -p /mnt/user/appdata/race-api
   chown 99:100 /mnt/user/appdata/race-api
   ls -ld /mnt/user/appdata/race-api      # must show 99 100 (nobody users)
   ```
4. **Compose (preferred):** merge [race/server/compose.snippet.yml](../race/server/compose.snippet.yml)
   into `/mnt/user/appdata/stack/docker-compose.yml` under `services:` with an editor, not a shell
   append. `export GIT_SHA=$(git -C race-api rev-parse HEAD)` first, or `/version` reports
   `unknown`. Optional 1.2.0 env: `RACE_ROOM_MAX_PILOTS`, `RACE_RAMP_PING_PER_DAY`,
   `RACE_CHAT_RATE_PER_S` (defaults in [REFERENCE.md](REFERENCE.md#server)); `RACE_ADMIN_TOKEN` enables the
   admin-only House ghost upload ([Robot test pilot](#robot-test-pilot)). The snippet sets
   `RACE_RUNWAYS_DIR: /app/runways` and mounts `./race-api/race/runways:/app/runways:ro` next to
   the courses mount, and `RACE_MODELS_DIR: /app/models` mounting `./race-api/race/models:/app/models:ro`
   the same way. An existing compose file from before this feature series needs those lines added.
   ```bash
   cd /mnt/user/appdata/stack
   docker compose up -d --build race-api
   docker compose ps race-api
   docker compose logs --tail=50 race-api
   ```
   **No Compose Manager** (it has gone missing before)? Build and run directly:
   ```bash
   cd /mnt/user/appdata/stack/race-api
   docker build -f race/server/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t race-api .
   docker rm -f race-api 2>/dev/null  # only if re-running this step
   docker run -d \
     --name race-api \
     --restart unless-stopped \
     --network proxy \
     -e RACE_ORIGINS=https://www.geo-fs.com,https://geo-fs.com \
     -e RACE_MAX_SPEED_MS=700 \
     -e RACE_MIN_INTERVAL_S=5 \
     -v /mnt/user/appdata/race-api:/data \
     -v /mnt/user/appdata/stack/race-api/race/courses:/app/courses:ro \
     -e RACE_COURSES_DIR=/app/courses \
     -v /mnt/user/appdata/stack/race-api/race/runways:/app/runways:ro \
     -e RACE_RUNWAYS_DIR=/app/runways \
     -v /mnt/user/appdata/stack/race-api/race/models:/app/models:ro \
     -e RACE_MODELS_DIR=/app/models \
     race-api
   ```
   Either way, confirm it's on `proxy`:
   `docker inspect race-api --format '{{json .NetworkSettings.Networks}}' | grep -o '"proxy"'`.
5. **Caddy** (see [below](#caddy)).
6. **Verify:** the [smoke test](#smoke-test-after-every-deploy). `docker logs race-api` should show
   `courses loaded: N from /app/courses` and `runways loaded: M from /app/runways`, where M is the
   number of entries in `race/runways/index.json`. M = 3 means it fell back to the embedded
   runways, so check the runways mount. A container that logs `no courses loaded` and exits means
   the courses mount or snapshot is missing.

### Caddy

**When:** first deploy only. The block never needs to change for a redeploy.

- The stack's Caddyfile is at **`/mnt/user/appdata/stack/Caddyfile`** on the box. Inside the
  `caddy` container it's **`/etc/caddy/Caddyfile`**. `validate` and `reload` take the in-container
  path.
- Copy the **exact** geoblock and CrowdSec directive lines from the live jellyfin block. Don't
  retype them:
  ```bash
  grep -A 20 '^jellyfin' /mnt/user/appdata/stack/Caddyfile
  ```
- Add the block from [race/server/Caddyfile.snippet](../race/server/Caddyfile.snippet). **No
  Authelia `forward_auth`:** the browser calls this API cross-origin from geo-fs.com and can't
  follow a login redirect.
  ```text
  race.finsonly.net {
  	# <geoblock directive — copied from the jellyfin block>
  	# <crowdsec directive — copied from the jellyfin block>
  	reverse_proxy race-api:8000
  }
  ```
  If you append with a heredoc, quote it (`<<'CADDYEOF'`) and `tail -8` the file afterwards to read
  it back. Pasted commands on this box have picked up stray characters before.
- Validate, **then** reload. The live Caddyfile is off-limits without explicit approval
  (CLAUDE.md):
  ```bash
  docker exec caddy caddy validate --config /etc/caddy/Caddyfile
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile
  ```
- The same block fronts both WebSockets (`/ws/race/{room}` and `/ws/hub`). Caddy 2's
  `reverse_proxy` upgrades them automatically. What to check is that the geoblock/CrowdSec lines
  don't eat the `Upgrade` handshake. Plain `curl` can't tell you that (see the smoke test).
- The upstream name depends on the layout: `race-api:8000` for the scp layout. For the
  git-checkout layout, the container is named `race`. *(Unverified: which upstream the live
  Caddyfile uses isn't recorded in the repo.)*

### Smoke test (after every deploy)

Run these from **your own machine**, not the box, so the geoblock is exercised the way a friend
would hit it.

1. **Health:** `curl -sS -m 5 https://race.finsonly.net/health` → `{"ok":true,"courses":N,"tiles":
   {"proxy":true,"cache_writable":true,"imagery":"esri"}}`, N > 0. `tiles.cache_writable: false`
   with the proxy on means the tile cache dir isn't writable in this deploy (see the 2026-09-24
   incident row in [Troubleshooting](#troubleshooting)) — every 3D globe view falls back to 2D.
2. **Version:** `curl -s https://race.finsonly.net/version`. Check that `sha` is what you pushed.
   **Tile cache on disk:** `ls -ld <DATA_DIR>/tiles` (redeploy.sh layout) or `<DATA_DIR>/tiles`
   under the compose layout's `/data` — should exist, owned `99 100`, and grow after a globe view.
   `curl -o /dev/null -w '%{http_code} %{content_type}\n' https://race.finsonly.net/tiles/imagery/0/0/0`
   → `200 image/png` (or `image/jpeg` under `RACE_IMAGERY=eox`).
3. **`/ghost` route and `traces` table:**
   ```bash
   curl -sS -m 5 -w '\nHTTP %{http_code}\n' 'https://race.finsonly.net/ghost?course_hash=0000dead'
   ```
   Pass is `{"detail":"No ghost recorded for that course yet."}` with `HTTP 404`.
   `{"detail":"Not Found"}` means an old image is serving. A `500` means `traces` is missing.
4. **Public site:** `curl -sS -m 5 -D - -o /dev/null https://race.finsonly.net/ | head -8` → a
   200 with `content-type: text/html` and a `content-security-policy` starting `default-src 'none'`.
5. **WebSocket upgrade through Caddy:** expect `HTTP/1.1 101`.
   ```bash
   curl -i -N -o - -s --max-time 5 \
     -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==" -H "Origin: https://www.geo-fs.com" \
     https://race.finsonly.net/ws/hub | head -1
   ```
6. **Lobby, end to end** (`pip install websockets` locally, never on the server):
   ```bash
   python race/tools/smoke_lobby.py                # 2 pilots against wss://race.finsonly.net
   python race/tools/smoke_lobby.py --clients 3
   ```
   It drives scripted pilots through a throwaway `smoke-<hex>` room (join, presence, typed chat
   both ways, vote, ready, GO, grid, abort, spectate, leave, handoff) and prints `all 12 steps
   passed`. It aborts before GO, so nothing is scored or written.
7. **Hub, end to end:**
   ```bash
   python race/tools/hub_smoke.py wss://race.finsonly.net/ws/hub
   ```
   It checks a fresh `welcome`, a reconnect keeping the same `pilot_id`, a callsign refusal naming
   the holder, `where`/`list`, and `ping_ramp` reaching the other client. It spends one of the test
   pilot's three daily ramp pings, so don't loop it. Clean up afterwards if you like:
   ```bash
   sqlite3 <DATA_DIR>/race.db "DELETE FROM pilots WHERE callsign_key LIKE 'hub-smoke%';"
   ```

A quick relay check by hand, with [`websocat`](https://github.com/vi/websocat): connect to
`wss://race.finsonly.net/ws/race/smoke-test` and send `{"type":"join","callsign":"DEPLOY-TEST"}`.
The reply is `joined` with `"proto"` equal to the server's `PROTO` (8 today), then a `lobby` frame.

**After a proto-6+ deploy:** `curl -s https://race.finsonly.net/modes` lists `race` (`asc`) and
`landing` (`desc`), and
`curl -s "https://race.finsonly.net/landing-leaderboard?runway_id=sea-tac-16c"` answers
`{"mode":"landing",…,"rows":[…]}`.

**Optional write test (`POST /runs`):** posts a fake run to the starter course (hash `1b352c3c` as
pinned in `race/test/course_hashes.json`). A 429 means you re-ran it within `RACE_MIN_INTERVAL_S`
(5 s). Clean it up afterwards. There's no DELETE endpoint by design.
```bash
curl -sS -m 5 -X POST https://race.finsonly.net/runs -H 'Content-Type: application/json' -d '{
  "course_id": "starter-sprint-seatac", "course_hash": "1b352c3c",
  "course_name": "Starter Sprint (Sea-Tac test course)", "callsign": "DEPLOY-TEST",
  "aircraft_id": "7", "model": "", "time_ms": 90000,
  "splits": [18000, 36000, 54000, 72000, 90000], "gates": 6, "length_m": 10000,
  "client_version": "smoke" }'
sqlite3 <DATA_DIR>/race.db "DELETE FROM runs WHERE callsign='DEPLOY-TEST';"
```
*(The `DELETE` leaves the run's mirrored `mode_runs` row in place. It's harmless, but it's there.)*

### What's in `race.db`

The app creates every table itself on start (`CREATE TABLE IF NOT EXISTS`, WAL mode), then runs its
idempotent `migrate()`. Rolling back to an older image is safe: it ignores tables and columns it
doesn't know.

| Table | Since | Written by | Holds |
|---|---|---|---|
| `runs` | 0.1 | `POST /runs` | Every posted attempt, append-only |
| `traces` | 0.9.0 | `POST /runs` with a `trace` | One best ghost trace per (`course_hash`, `callsign`) |
| `cups` | 0.11.0 | the relay | Cups: `name`, `race_count`, `closed_at` (NULL while open) |
| `races` | 0.11.0 | the relay, once per finished lobby race | `room`, `course_hash`, `course_name`, `started_at`, `cup_id` |
| `race_results` | 0.11.0 | same write as `races` | Per-pilot rows: `pos`, `go_time_ms`, `status`, `points`, `stats_json` |
| `mode_runs` | proto 6 | `POST /runs` (`race`), `POST /landings` (`landing`), `POST /modes/{mode}/runs` | Every mode's runs in one shape |
| `pilots` | 1.2.0 | the hub | Identity: `pilot_id`, `callsign`, `callsign_key` (UNIQUE), `token_hash`, ramp-ping counters |

Presence, the room registry, the vote, rooms in flight and **every chat line** live in memory only.
Chat is never written anywhere.

`sqlite3 <DATA_DIR>/race.db ".tables"` should list all seven.

### Free a callsign (admin)

There's **no endpoint** for this (no auth, by design). On the box, with the container running:

```bash
# Who holds it? (token_hash NULL = nobody has claimed it yet)
sqlite3 <DATA_DIR>/race.db \
  "SELECT pilot_id, callsign, token_hash IS NOT NULL AS claimed, last_seen FROM pilots
   WHERE callsign_key = lower(trim('TheName'));"

# Release the name. The row and its history stay; the next pilot to prove the name adopts it.
sqlite3 <DATA_DIR>/race.db \
  "UPDATE pilots SET token_hash = NULL WHERE callsign_key = lower(trim('TheName'));"
```

Never `DELETE` a pilot row. `runs`, `traces` and `race_results` reference its `pilot_id`.

## Backup, restore and rollback

### Backups

- **Every deploy** through `redeploy.sh` writes `<DATA_DIR>/race.db.bak-<YYYYmmdd-HHMMSS>` using
  SQLite's online backup, and aborts if the copy is empty.
- **By hand** (safe with the container running). Never use `cp`: the database is in WAL mode, and a
  plain copy can miss what's still in `race.db-wal`.
  ```bash
  sqlite3 <DATA_DIR>/race.db ".backup '<DATA_DIR>/race.db.$(date +%Y%m%d-%H%M).bak'"
  sqlite3 <DATA_DIR>/race.db.<stamp>.bak "PRAGMA integrity_check;"      # expect: ok
  ```
- **Pruning:** after every passing deploy, and after a healthy autodeploy rollback,
  `race/server/prune.sh` keeps the **10 newest** `race.db.bak-*` files and deletes the rest. It
  logs a `PRUNE … backups_removed=… backups_kept=…` line to `deploy.log`. A failed deploy prunes
  nothing. Pass `--no-prune` to `redeploy.sh` or `autodeploy.sh` to keep everything, and copy a
  backup somewhere else first if you need one older than the last ten deploys.

### Restore

**When:** `PRAGMA integrity_check` says the live file is damaged, or data was lost.

**Steps** (not scripted in the repo, so go carefully):
1. Pause autodeploy (`touch <DATA_DIR>/.autodeploy_paused`), then stop the container
   (`docker stop race`, or `race-api`).
2. Move `race.db`, `race.db-wal` and `race.db-shm` aside. Don't delete them.
3. Copy the chosen backup to `<DATA_DIR>/race.db` and `chown 99:100` it.
4. `sqlite3 <DATA_DIR>/race.db "PRAGMA integrity_check;"` → `ok`.
5. Start the container again (`docker start race`), then remove the pause file.

**Verify:** the [smoke test](#smoke-test-after-every-deploy), and the leaderboard on the public site
looks right.

### Roll back a deploy

- **Automatic:** autodeploy already rolls back to `race:prev` when a deploy leaves the container
  unhealthy (see [Autodeploy](#autodeploy)).
- **To a previous commit (preferred):** revert the bad commit on `main`, let CI pass, then
  `git push origin main:deploy`. Autodeploy ships the revert like any other change.
- **Fast, to the previous image:** pause autodeploy, then run `race:prev` with the flags
  `redeploy.sh` step 5 uses:
  ```bash
  docker rm -f race
  docker run -d --name race --restart unless-stopped --network proxy --user 99:100 \
    -v /mnt/user/appdata/stack/race/data:/app/data -e RACE_DB=/app/data/race.db \
    -v /mnt/user/appdata/stack/race/app/race/courses:/app/courses:ro -e RACE_COURSES_DIR=/app/courses \
    -v /mnt/user/appdata/stack/race/app/race/runways:/app/runways:ro -e RACE_RUNWAYS_DIR=/app/runways \
    -v /mnt/user/appdata/stack/race/app/race/models:/app/models:ro -e RACE_MODELS_DIR=/app/models \
    race:prev
  ```
- **The database doesn't need rolling back.** Every migration so far is additive, and older code
  ignores new tables and columns. Restore a backup only if `integrity_check` fails. A pre-proto-6
  build writes race runs to `runs` only, and the next proto-6 start backfills `mode_runs`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `502` from `race.finsonly.net` right after a deploy | The container is still booting | Wait. `redeploy.sh` tolerates 502 for up to 30 s. If it persists, `docker logs --tail=50 race` |
| HTTP works but the WebSocket fails at the handshake (Ramp never connects, WS 502) | The server image lacks WebSocket support, or a Caddy directive eats the `Upgrade` header | `requirements.txt` must pin `uvicorn[standard]`, not plain `uvicorn` (the `[standard]` extra brings WebSocket support). Test the edge with the `curl -i -N` check (expect `101`), and check the geoblock/CrowdSec lines first |
| Container logs `no courses loaded` and exits, or the vote only offers *surprise me* | The courses mount or the image snapshot is missing | Check the `/app/courses` mount and `RACE_COURSES_DIR`. The image must be built from the **repo root** with `-f race/server/Dockerfile` so `race/courses` is in it |
| `redeploy.sh` aborts with *…is DATA_DIR right?* | The empty-DB guard (2a) saw a wrong-`DATA_DIR` signal | `docker inspect <container> --format '{{json .Mounts}}'`, set `RACE_DATA_DIR=` correctly, and only then consider `--allow-empty-db` |
| SQLite permission errors, or the migration fails to write | The data dir or `race.db` is root-owned | `chown -R 99:100 <DATA_DIR>`. `redeploy.sh` 2b does this on every deploy and always runs the container as `--user 99:100` |
| Every 3D globe view falls back to 2D; `/health`'s `tiles.cache_writable` is `false` | The tile cache dir isn't writable as `99:100` (the 2026-09-24 incident: a hardcoded `RACE_TILE_CACHE_DIR` pointed at a root-owned volume `redeploy.sh` never mounts) | `_default_tile_cache_dir()` now follows `RACE_DB`'s directory by default — confirm nothing overrides `RACE_TILE_CACHE_DIR` to a path outside the mounted data dir, then `chown -R 99:100 <DATA_DIR>` and redeploy. Cache errors fail open (tiles still serve, just uncached) so this is a performance/cost issue, not an outage, but `redeploy.sh` step 6 now fails the deploy on it |
| `/ghost?course_hash=0000dead` returns `{"detail":"Not Found"}` | The old image is still serving | Check `/version`'s `sha` and `started_at`, then look at `deploy.log` |
| `deploy.log` shows `SKIP <sha> ci=none` forever | That commit was pushed straight to `deploy` and never ran CI | Merge through `main`, then `git push origin main:deploy` |
| `POST /runs` → 429 | The per-IP rate limit, `RACE_MIN_INTERVAL_S` (5 s) | Wait a few seconds |
| A pilot still has old behavior after a push | The raw GitHub ~5 min cache, or a pinned FALLBACK | See [Stale code](#stale-code-after-a-push-the-cdn-cache-gotcha) |
| The old floating lobby card or old UI shows, or a pilot can't ready up | An old bookmark (FALLBACK pinned to `race-v1.0.0`), or `LOBBY_V2` is off | Switch them to COMBINED. Check `__finsRace.version` |
| Console: *v… is already running and cannot be replaced in place* | Two client versions in one tab | Reload the tab, then click the bookmark once |
| Panel opens straight into Solo, with no Ramp | `API_BASE` is empty, or the server is unreachable | Check `__finsRace.config.API_BASE` and `/health` |
| Red banner `Server proto X, client needs 5` | The relay is older than the client | Deploy the current server |
| Teleport or Fly to start doesn't move the plane | An old client still using `resetFlight()` (verified broken). 1.7.0+ uses `geofs.aircraft.instance.place()` through `GeoPhysics`; later builds use `geofs.flyTo` (`AIR_START_FLYTO`) with `place()` as the fallback | Update the client. Check the teleport and `air start` lines in the Alt+D overlay. If the sim stays paused after an air start, press P |
| `finish rejected: time does not match the relay's clock` | The lobby clock and relay clock disagree by more than 3 s | Note `__finsRace.lobby.offsetMs` on both machines and report it |
| *COURSE MISMATCH* banner | That pilot's copy of the course differs | **↻** in Solo's course picker, or reload |
| Alt+D does nothing | The browser took it for the address bar | `__finsRace.debug.toggle()` |
| Alt+L toggles something odd with PROBE loaded | `tools/probe.js` also binds Alt+L (its landing sampler) | Don't load PROBE during a race |

## Debug tools

| Tool | Loads with | Writes to the sim? | Use it to |
|---|---|---|---|
| Debug overlay | **Alt+D** or `__finsRace.debug.toggle()` | No | See version, relay proto, course count, which UI mounted, socket count, frames in/out, clock offset, GO time, grid slot, teleport result |
| `tools/probe.js` | the **PROBE** line | **No**, read-only | Dump GeoFS/Cesium internals to a JSON report on the clipboard (`console.log` fallback, ~200 KB cap) |
| `tools/physics_lab.js` | the **LAB** line | **Yes**, on purpose | Find out which writes stick (throttle, autopilot, teleports, speed, rails). **Throwaway flights only**, never during a race |
| `tools/terrain_probe.js` | its own bookmarklet (below) | No | Check a course against the terrain GeoFS actually renders |
| `tools/recorder.js` | the **RECORDER** line | No | Capture a 20 Hz landing (**Alt+T** start/stop, 5 min cap, **Copy JSON**) |
| `tools/replay_landing.mjs` | `node race/tools/replay_landing.mjs rec.json [runway.json]` | n/a (CLI) | Run `touchdown.js` over a recording. Try it with `race/tools/sample_landing_recording.json race/tools/sample_runway.json` |
| `tools/ui_gallery.html` | open from disk in Chrome | n/a | Review every UI surface on fixture data. `?scene=hud` (also `ramp`, `gate`, `launch`, `results-solo`, `results-cup`, `toasts`, `news`) shows one scene |
| `tools/robot_pilot.js` | the **ROBOT** line, **after** race.js | **Yes**, it flies the aircraft | Fly courses and runway approaches on the autopilot and report what fails. See [Robot test pilot](#robot-test-pilot) |
| `tools/robot_report.py` | `python race/tools/robot_report.py report.json` | n/a (CLI) | Turn the robot's report into `docs/reports/<date>/ROBOT.md` with suggested fixes |

**probe.js vs physics_lab.js:** the probe only reads, so it can report *what exists* and its type,
but not whether a write holds. The lab writes: click **DISCOVER** first (read-only), then one test
at a time. Each test snapshots state, applies one write, and samples it at +100 ms, +1 s and +3 s.
**Restore** puts the snapshot back, and **Copy report (JSON)** copies the results. Allowed aircraft
writes in `race.js` are only the ones the lab verified on 2026-09-23 (see CLAUDE.md).

#### Physics Lab sections

Besides the physics tests, the lab has four discovery sections. **None of them has been run
against the live site yet**, and every GeoFS path they read is unverified.

**GRAPHICS (G0–G2)**
- **G0. GRAPHICS DISCOVER** (read-only) reports the Cesium viewer GeoFS uses (`geofs.api.viewer`,
  falling back to `window.viewer`). It reads the current value of `viewer.resolutionScale`,
  `scene.globe.maximumScreenSpaceError`, `scene.fog.enabled/density/screenSpaceErrorFactor`,
  `scene.msaaSamples`, `scene.postProcessStages.fxaa.enabled`, `scene.highDynamicRange`,
  `scene.postProcessStages.bloom.enabled`, `scene.globe.enableLighting`, `scene.shadowMap.enabled`,
  `scene.globe.tileCacheSize` and `scene.globe.preloadSiblings`. It also lists the canvas size and
  DPR, any graphics-looking leaves under `geofs.preferences`/`geofs.userRecord`, every
  options-panel input bound to a preference (any `data-*pref*` attribute, believed to be
  `data-gespref`, unverified), and graphics/preference-named functions on `geofs`/`geofs.api`/`ui`
  with their source head.
- **G1. write …** (opt-in, one button per setting, or **write ALL** for the whole list, ~6 min)
  measures A/B/A: a frame-rate window before the write, one with it, and one after restoring.
  Each window is at least `FPS_WINDOW_MS` (10 s), with a 2 s settle after each write. During a
  window, rendering is forced continuous (`scene.requestRenderMode` off, `requestRender()` every
  frame, restored after), and `geofs.debug.fps` is sampled once a second next to the rAF count.
  The baseline is the mean of the two A windows, and their disagreement is the noise floor: a delta
  no bigger than it reads "within noise". The run records whether you were in straight-and-level
  cruise (bank < 5°, pitch < 10°, vertical speed < 300 fpm) and flags `NOT STEADY` if not, so fly
  level on autopilot while it runs. The written value is visibly different (booleans flip,
  `resolutionScale` 1↔0.5, other numbers ×2), and the readback is **STICKS / REVERTED /
  CHANGED**. `msaaSamples`, `highDynamicRange` and bloom are **never written**: raw writes caused
  visible glitches (2026-09-24). G0 still reads them.
- **G2. Toggle one GeoFS graphics setting** flips the first graphics checkbox (or advances the
  first graphics select) in GeoFS's own options panel and fires `input`/`change` so GeoFS's handler
  applies it, measured A/B/A like G1. It lists which Cesium settings GeoFS's setting drove, then
  puts the input back. If no such input exists in the DOM yet, open GeoFS *Options → Graphics* once
  and retry.

**ENV (E0–E2)**: course env (race/README "Course env")
- **E0. ENV DISCOVER** (read-only) returns a copy of `geofs.preferences.weather` (manual, localTime,
  season, advanced), `graphics.buildings`, every function on the `weather` global, whether
  `geofs.api.setBuildings`/`geofs.buildings.init/destroy`/`geofs.api.setTimeAndDate` exist, and
  `geofs.debug.fps`.
- **E1. Apply sample env** asks `confirm()`, snapshots the prefs, then applies overcast 85, fog 20,
  wind 270/15, turbulence 10, precip 30, 18:30, season 75 and buildings on. It uses race.js's recipe
  (`manual: true`, `advanced.*` + `weather.setAdvanced()`, `localTime`/`season` +
  `weather.setDateAndTime()`, `geofs.api.setBuildings()`) and reports the readback 2 s later.
- **E2. Restore env** writes the snapshot back, calls `weather.refresh()` (and `setDateAndTime`,
  `setBuildings` for what E1 changed), and reports whether the prefs are identical again.
  `geofs.savePreferences()` is never called.

Physics test **4d** writes with `rigidBody.setLinearVelocity([E, N, U])` explicitly. It used to call
the first `/vel/`-named method it found, which was `getLinearVelocity`.

**RUNWAYS (R0–R2)**
- **R0. RUNWAYS DISCOVER** (read-only) scans `geofs.*`, `geofs.nav`, `geofs.api`, `geofs.runways`
  and `window` for runway/airport/nav-named containers, reporting each one's size, first key, first
  entry's shape and a JSON sample. It collects every record it can place: lat/lon as named fields
  or a location/threshold-ish array, and heading/length/width by name. **Units are unverified**, so
  the raw record is printed next to the guess. It reports the nearest 5 to the aircraft. It also
  lists every approach/takeoff/final/flyTo/location-named function on `geofs`, `geofs.runways`,
  `geofs.nav`, `geofs.api`, `ui` and `ui.panel` (path, arity, signature, source head). Finally it
  lists every DOM element whose text looks like a takeoff/approach/runway button, with inline
  `onclick`, `data-*` attributes and jQuery-bound handler source. That's how to find what GeoFS's
  own takeoff and final-approach start buttons call.
- **R1. Export nearest runway** copies the nearest record in `race/runways/*.json` shape (`id`,
  `name`, `version: 1`, `thr_lat`, `thr_lon`, `thr_alt_m`, `heading_deg`, `length_m`, `width_m`,
  and `zone {min_m, max_m}`). The zone is 10–30 % of the length, clamped to 60–450 m and at least
  60 m deep, the same rule as [`add_runway.py`](#add-a-runway). A field GeoFS doesn't carry is
  exported as `null` (default width 45 m) rather than guessed. Check the threshold and elevation
  before committing.
- **R2. Try approach start here** moves the aircraft, so it asks `confirm()` first. It calls the
  first approach/final-named function R0 found, passing the nearest runway's raw record as its only
  argument (or no argument if its arity is 0). It reports what the function returned and where the
  aircraft ended up.

**AIRCRAFT (A0–A1)**
- **A0. AIRCRAFT DISCOVER** (read-only) dumps GeoFS's aircraft catalogue as `{id, name, type}`. It
  tries `geofs.aircraftList`, then `geofs.aircraft.list`, then anything list/catalog-named under
  `geofs`/`geofs.aircraft`, then the aircraft picker's DOM (`[data-aircraft]`). It adds the current
  aircraft's id (`geofs.aircraft.instance.id`) and a raw sample of each catalogue found.
- **A1. Copy aircraft list** copies `{current, aircraft: [...]}` as JSON.

The **Bush Cup** courses ([CUPS.md](../race/courses/CUPS.md)) ship with `aircraftId: null` and
name the intended aircraft only. Fill in the real GeoFS ids from A0/A1 before locking them. A
changed `aircraftId` changes the course hash, so do it before anyone sets a time.

The lab's new pure helpers (`GRAPHICS_PATHS`, `getPath`, `setPath`, `testValueFor`,
`classifyStick`, `fpsFromTimestamps`, `haversineM`, `defaultZone`, `slugId`, `runwayExportShape`,
`guessRunway`, `nearestN`, `normalizeAircraftList`) have no `run.js` cases yet.

#### terrain_probe.js (read-only)

Make a bookmark from this line, load FINSONLY Racing first, then click it and enter a course id:

```text
javascript:(()=>{fetch('https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/tools/terrain_probe.js?t='+Date.now()).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}).then(t=>{const s=document.createElement('script');s.textContent=t;document.head.appendChild(s);}).catch(e=>alert('FINSONLY terrain probe failed to load: '+e.message));})()
```

It samples every gate and every 100 m of each leg, prints a `console.table` with a verdict, and
copies a JSON report. It uses the same 150 m margin as `check_terrain.py`.

#### Robot test pilot

The **ROBOT** bookmarklet (`race/tools/robot_pilot.js`) flies the aircraft through race.js's
dev-only `window.__finsRace.dev` (`CONFIG.DEV_API`). Every write goes through `GeoPhysics`
(airStart, the Guidance autopilot targets, full throttle for a go-around) and every read through
the G adapter. It never loads a course into the race, so it never posts a run. **Throwaway flights
only**, never during a race. Load FINSONLY Racing first, then click ROBOT.

- **COURSE mode:** pick one course, a cup, or all 69, then **Start**. For each course it applies the
  env, air-starts before gate 1 on the gate1->gate2 bearing (FlyToStart's spot and speed), and flies
  gate to gate on the autopilot. The next gate is picked at max(radius, turn lead), and the altitude
  follows the gate-to-gate line with climb/descent limits. It aborts below 15 m AGL, on ground
  contact, or on the per-course timeout (2 x length/speed + 120 s). Per gate it logs crossed, miss
  distance vs radius, the side it passed on, the lowest AGL on the leg, AGL at the gate and leg
  time. Results: **PASS**, **FAIL(reason)**, **UNREACHABLE(gate n)** (buried gate or leg timeout) or
  **SKIPPED(aircraft)**.
- **Aircraft:** a course is flown in its locked aircraft, else the Beaver (13) for the Bush Cup,
  else the F-16 (7). There's no verified way to switch aircraft from code, so a batch is grouped by
  aircraft and **pauses** for you to switch in GeoFS and press **Continue**. A course whose aircraft
  still doesn't match is SKIPPED, never flown.
- **APPROACH mode:** one runway, a landing cup, or all 26. It uses the Landing tab's own spawn
  (`landingSpawn()`, including the runway's `approach` override), flies the virtual ILS down to
  50 ft AGL, then goes around (runway heading, threshold + 1500 ft, full throttle). It logs spawn
  AGL, the glidepath's clearance over terrain, LOC/GS dots at 1 nm, 0.5 nm and 50 ft, cross-track at
  50 ft, the last-mile AGL profile, and GeoFS's own runway record (`geofs.runways.getNearestRunway`,
  TODO-PROBE) with its offset from the JSON threshold. Results: **PASS**, **TERRAIN**, **OFFSET(m)**,
  **SPAWN_LOW** or **FAIL**.
- **Report:** **Download JSON** (or Copy JSON), then
  `python race/tools/robot_report.py robot-report-<date>.json`. That writes
  `docs/reports/<date>/ROBOT.md`: the results table, per-gate detail for everything that didn't
  pass, and **suggested fixes**. The fixes are gate raises for terrain, a lateral shift or radius for
  a miss, a steeper `approach` angle for TERRAIN, and a threshold re-check for OFFSET. **Nothing is
  applied.** A course fix ships as a new course version through `add_course.py` after review. A
  runway fix is an `approach` block in `race/runways/<id>.json`.
- **House ghost:** a PASS row has **Upload as House ghost**. Paste the admin token (kept in
  sessionStorage only). It sends `POST /ghosts/house` with `Authorization: Bearer <token>`. The
  trace is stored under callsign `HOUSE`, is listed in `/ghosts` (`is_house`, never the course
  record) and plays on the site's replay. It is on no leaderboard, record history, medal table,
  news feed, pilot page or cup. The server keeps the fastest House ghost unless `force`. The
  callsign `HOUSE` is reserved on every write path. **Server setup:** set `RACE_ADMIN_TOKEN` (a long
  random string) in the stack's env file for the `race-api` service, and never commit it. Unset
  means the route answers 503. Changing the live compose/env and restarting the container needs the
  owner's go-ahead, like every live change.

#### What to paste back to Claude

- `__finsRace.version` and the relay proto from the debug overlay.
- The console lines starting `[finsRace]`, especially any `teleport` or `frame error`.
- For GeoFS-internals questions: the **PROBE** JSON report. For "did the write stick" questions: the
  **LAB** Copy report (JSON). For Bush Cup aircraft ids: the lab's **A1** aircraft list.
- For an acceptance failure: the row id (e.g. `LB 2.5`) and what you actually saw.

## Dev environment

### Run the tests

CLAUDE.md requires both core suites before every commit:

```bash
cd race/test && npm install && node run.js                     # JS: engine, UI, relay client
cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q
```

The rest, when you touch their area:

```bash
cd race/test && python -m pytest test_add_course.py -q                                  # add_course.py
cd race/test && python -m pytest test_check_terrain.py -q                               # check_terrain.py (offline)
cd race/test && pip install pygltflib numpy pytest && python -m pytest test_models.py -q # build_models.py
cd race/test && python -m pytest test_models_pack.py -q                                 # committed models, preview.png
cd race/test && python -m pytest test_check_terrain_global.py -q                        # the Terrarium decoder (offline)
cd race/test && python -m pytest test_design_course.py test_add_runway.py -q            # design_course.py, add_runway.py (offline)
cd race/test && python -m pytest test_check_addons.py -q                                # check_addons.py
cd race/test && python -m pytest test_gen_docs.py -q                                    # docs/REFERENCE.md is fresh
python -m pytest race/test -q        # every Python suite at once
shellcheck race/server/*.sh          # what CI lints (redeploy.sh, autodeploy.sh, prune.sh)
python race/tools/gen_docs.py        # regenerate docs/REFERENCE.md after changing CONFIG, hotkeys, routes or env vars
ruff check race/server race/tools    # what CI lints
```

On the Windows work PC, Node isn't on `PATH`. Use the portable Node at
`C:\Users\Eric.Burgard\AppData\Local\nodejs\node-v22.14.0-win-x64` for `race/test/run.js`
(CLAUDE.md).

`test_server.py` also runs `tools/smoke_lobby.py` against a local uvicorn. To run the server
yourself: `cd race/server && RACE_DB=/tmp/race-dev.db uvicorn app:app --port 8000`, then
`python race/tools/smoke_lobby.py --url ws://127.0.0.1:8000`.

### Parallel sessions

Nearly every feature touches the same three files: **`race/race.js`** (the single-file client),
**`race/test/run.js`** and **`race/test/test_server.py`**. Two sessions editing them at once will
conflict. Give each session its own branch, keep each one's change to one feature, and merge one
before rebasing the next. `race/PROTOCOL.md` and `race/ACCEPTANCE.md` are the next most likely
collision points.

On the work PC, parallel sessions each get a git worktree next to the main checkout (e.g.
`git worktree add -b <branch> ../geofs-<name> origin/main`). Claude Code sessions there can't push
(permission denied), so the session prints the push command and you run it from the VS Code
terminal. Clean up with `git worktree remove ../geofs-<name>` (or `git worktree prune` after
deleting the folder). *(Confirmed by Eric, 2026-09-24.)*

## Working with Claude Code

### The rules that bind every session ([CLAUDE.md](../CLAUDE.md))

- Liveries at the repo root are off-limits unless asked.
- `race/race.js` stays one self-contained file: no build step, no external deps, no downloads beyond
  `COURSE_BASE`/`MODEL_BASE`/`API_BASE`. Audio is WebAudio-synthesized.
- GeoFS/Cesium internals only inside `G`, `GeoPhysics` or a `make*Layer` factory, and new rendering
  layers fail closed (`layer.ok`, `clear()`, `console.warn`).
- Aircraft writes are limited to the GeoFS calls verified in-sim on 2026-09-23.
  `POWERUP_CONTROL_EFFECTS` stays `false`. `resetFlight()`, direct speed writes and thrust
  multipliers are verified broken and must never come back.
- Pure logic gets pure functions and tests. Anything that needs the sim gets a row in
  [race/ACCEPTANCE.md](../race/ACCEPTANCE.md).
- Relay changes are additive and versioned in [race/PROTOCOL.md](../race/PROTOCOL.md). A new client
  must still work against an old server.
- Every feature has a `CONFIG` flag. Add a test for every bug fix. Run both suites before every
  commit, one commit per task, short imperative messages, and bump `CONFIG.VERSION` on user-visible
  changes.
- Pushing feature branches and opening PRs is allowed. Never push to `main` or `deploy`.
- Never touch the live Caddyfile or containers, and never add Authelia to `race.finsonly.net`.
- `api.cesium.com` and `opentopodata.org` are unreachable from the work network.

### Writing a session prompt

A good prompt pins down:

1. **Branch:** the branch name, created from current `origin/main`.
2. **Scope:** the feature, and the files it may touch.
3. **Off-limits files:** anything another session is editing tonight, the liveries, the live
   server.
4. **Tests:** "run both suites before every commit; add a test for every bug fix". Mention
   `python race/tools/gen_docs.py` if `CONFIG`, hotkeys, routes or env vars change.
5. **Docs:** new in-sim checks go in `race/ACCEPTANCE.md`, protocol changes in
   `race/PROTOCOL.md`, operations in this runbook, and a line in `race/CHANGELOG.md`.
6. **Git:** "push the branch; never merge; never push to `main` or `deploy`".
7. **Report:** commits, `CONFIG` flags added, protocol frames added, tests added, ACCEPTANCE rows
   added, and anything skipped and why.
