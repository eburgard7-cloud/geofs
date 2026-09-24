# FINSONLY Racing

A checkpoint racing layer for GeoFS: gates, timer, splits, personal bests, ghosts, a course editor, a shared leaderboard, and — with the relay — a lobby, Mario-Kart-style items and a shared results screen. It's a single JS file loaded by a bookmarklet, so no extension is needed.

**Playing, or hosting a night?** Start with the root [README](../README.md): the install, the lobby-to-results flow, what every item looks like and how to counter it, the key map and the hosting checklist all live there. This file is the reference underneath it — rules, mechanics, protocol and setup.

```
race/
  race.js                 the whole client
  bookmarklet.txt         what friends paste into a bookmark
  courses/index.json      shared course list (fetched by the client)
  courses/*.json          shared courses
  runways/index.json      landing-mode runway list (server-only so far)
  runways/*.json          runway defs in touchdown.js's field names — mirrored in server/app.py's RUNWAYS, which is what actually scores
  models/index.json       joke-plane model list (id, file, scale, rotation offsets)
  models/*.glb            procedurally generated joke-plane models
  models/assignments.json callsign -> model id, fetched by the client
  tools/build_models.py   generates models/*.glb + models/index.json
  tools/add_course.py     validates a pasted course JSON, writes/upserts courses/
  tools/check_terrain.py  samples terrain along a course route, flags gates/legs below it
  tools/terrain_probe.js  one-shot, read-only: checks a course against the terrain GeoFS itself renders
  tools/probe.js          one-shot, read-only GeoFS/Cesium internals report
  tools/ui_gallery.html   every UI surface on fixture data, no sim needed (see "Reviewing the UI")
  tools/physics_lab.js    debug-only bookmarklet: WRITES to sim state to test which GeoFS writes stick
  touchdown.js             pure-function touchdown detector (liftoff/touchdown/bounce/go_around/settled); not wired into race.js
  tools/recorder.js       bookmarklet: records a 20 Hz sample stream in touchdown.js's input shape
  tools/replay_landing.mjs  CLI: runs touchdown.js over a recorder.js capture, prints events + a touchdown table
  server/                 leaderboard API + relay (FastAPI + SQLite) + Caddy/compose snippets
  server/DEPLOY_CHECKLIST.md  step-by-step Unraid deploy, redeploy and smoke test
  server/migrate_modes.py proto 6: creates mode_runs and backfills it from runs (additive, idempotent)
  server/redeploy.sh      Unraid redeploy: pull, check + back up race.db, migrate, build from the repo root, swap, poll, prune on PASS (--dry-run, --no-prune)
  server/prune.sh         sourced by both deploy scripts: after a PASS, prune dangling images + keep the 10 newest race.db backups
  server/autodeploy.sh    Unraid cron (5 min): poll origin/deploy, deploy only a CI-passed SHA via redeploy.sh, roll back on a failed health check (--dry-run)
  tools/smoke_lobby.py    2-3 scripted pilots through a throwaway room: join, chat, vote, ready, GO, grid, spectate, leave, handoff
  tools/hub_smoke.py      the same for the hub socket: identity, presence, ping-the-ramp
  PROTOCOL.md             the relay's WebSocket protocol, proto 1–6, checked against app.py
  CHANGELOG.md            one line per shipped item, per version
  docs/AUDIT.md           dead-code / superseded-UI audit — a report, nothing in it is applied yet
  docs/ACCEPTANCE.md      in-sim lobby checklist (two clients, one PC), PASS/FAIL per row
  ACCEPTANCE.md           the two-client race-night script for what only the live sim can settle
  test/run.js             headless engine tests (mocked GeoFS/Cesium)
  test/test_server.py     API tests
  test/test_models.py     build_models.py output tests (valid glb, size, bounding box)
  test/test_add_course.py add_course.py validation/index-upsert tests
  test/test_check_terrain.py check_terrain.py geometry/classification/decoder tests
```

## 1. Put it in the repo

Copy this `race/` folder into the root of `eburgard7-cloud/geofs` and push to `main`. The bookmarklet loads `race/race.js` from `main`.

## 2. Test that geo-fs.com allows it (before sending to anyone)

On geo-fs.com, after the sim loads, open DevTools → Console and run:

```js
fetch('https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/race.js').then(r => r.status)
```

- **Result is `200`:** then check that `geofs.aircraft.instance.llaLocation`, `geofs.api.viewer`, and `geofs.isPaused` all return values rather than `undefined`. Those are the GeoFS internals the script depends on. If one is missing, fix the matching line in the `G` adapter near the top of `race.js`; nothing else touches GeoFS.
- **Result is a CSP error:** use the fallback bookmarklet. If that is also blocked, the page policy forbids external scripts, and a bookmarklet can't work there.

## 3. Install (each friend)

The player-facing steps are in the root README ("For players"); the short version:

1. Create a new bookmark named `FINSONLY Racing`.
2. Paste the **COMBINED** line from `bookmarklet.txt` as the URL — it loads both this and [GEOFS-LiverySelector](https://github.com/kolos26/GEOFS-LiverySelector) in one click, so you don't need two separate pastes/bookmarks each session. If you don't use custom liveries, the plain **PRIMARY** line works too.
3. Open GeoFS, wait until the plane is on screen, then click the bookmark.

Clicking the bookmark again just re-shows the race panel. LiverySelector has its own `l` key to toggle its panel, independent of this. The primary/combined lines always pull the latest `main` of both scripts, so there's nothing to update.

**Not yet live-tested:** the COMBINED loader hasn't been run against a real GeoFS + LiverySelector session — it's built from the same fetch-and-inject pattern this repo's own loader already uses (see PRIMARY above), applied identically to LiverySelector's `main.js`, which is a self-contained IIFE with no dependency on `race.js` or vice versa. No DOM ID or keybinding overlap found on read-through (LiverySelector owns `#listDiv`/`.geofs-ui-left`/`.geofs-ui-bottom`; this owns its own `fr-`-prefixed panel). If it misbehaves, load them separately as before and report back what broke.

The FALLBACK and COMBINED FALLBACK lines pin a jsDelivr `@race-vX.Y.Z` tag rather than tracking `main`, so unlike PRIMARY/COMBINED they need that tag moved (or a new tag cut and the lines' version bumped) on every release before a friend relying on the fallback actually gets the update. The current pin is `race-v1.0.0`, an annotated tag; `test/run.js` now fails if a pinned tag doesn't exist in the repo, which is how the stale `race-v0.2.3` pin (a tag that was never cut) went unnoticed through v0.5.0. It prints a note, not a failure, when the pin merely lags `CONFIG.VERSION` — that's the normal state between releases. Cutting a release is therefore:

```bash
# after bumping CONFIG.VERSION and repointing the FALLBACK lines in bookmarklet.txt
git tag -a race-v1.0.0 -m "FINSONLY Racing v1.0.0" && git push origin race-v1.0.0
```

## Controls

| Key | Action |
|---|---|
| Alt+R | Reset run (re-arm). Mid-race in a lobby race this reports a DNF |
| Alt+G | Drop a gate at your position (editor) |
| Alt+U | Undo last draft gate |
| Alt+B | Drop an item box at your position (editor) |
| Alt+Shift+B | Drop a row of three item boxes, 120 m apart across your heading (editor) |
| Alt+H | Hide/show the race HUD (with `CONFIG.HUD` off: the panel) |
| Alt+K | Collapse/reopen the panel. The reopen tab is hidden while a run is live, so this is the way back in mid-race |
| Alt+1 / Alt+2 | Use loadout slot 1 / 2 (see "Powerups") |
| Alt+3 | Use the item you got from the item box |
| Alt+Y | Toggle ready in the relay lobby (see "Lobby") |
| Alt+L | Show/hide the racing line (see "Ghost racing") |
| Esc | Close the results card (see "Results and cups") |

There's one more action with no key: **Fly to start**, the button under the course row. It only
lights up on air-start courses — see "Fly to start" below.

Keys that Chrome reserves (Alt+D/E/F) are avoided. Typing inside the panel doesn't fly the plane.

## Rules the engine enforces

- **Start:** the timer starts when you *leave* the start sphere, so standing starts on a runway and flying starts both work.
- **Gates:** they must be taken in order. A gate counts on first contact with its sphere, interpolated within the frame, so fast or low-fps flyers can't tunnel through. It stays accurate to roughly one frame.
- **Finish:** first contact with the last sphere.
- **Pause:** paused time doesn't count. Moving more than 50 m while paused is a DQ, which blocks the pause-and-relocate trick.
- **Speed limit:** anything faster than 700 m/s (about 1,360 kt) between samples is a DQ, which catches teleports. Repositioning before the start is fine and never triggers a start.
- **Optional aircraft lock:** tick "Require my current aircraft" in the editor and the course stores that aircraft id. Anyone in a different aircraft is DQ'd at the start. Use this with the F-16 base so model swaps stay physics-identical.
- **Course identity:** personal bests and the leaderboard are keyed by a hash of the gate geometry plus the aircraft lock. Renaming a course keeps its times; moving any gate starts a fresh board.
- **Not caught:** slow slew-mode cheating below the speed limit. For friends, that's the honor system.

## Building courses

1. Open **Course editor**, set a name and radius. 150 m is forgiving and 60 m is spicy.
2. Fly the route and press **Alt+G** at each gate. The first gate is the start and the last is the finish.
3. Click **Save and load** to store the course in this browser and arm it.
4. Click **Copy JSON** to share it.

To try the engine without building anything, **Build test course ahead of me** drops 6 gates in a line along your heading. It's also the fastest way to test the whole sharing loop below before recording something real: click it, then walk through steps 2 onward with the throwaway course it makes.

### Sharing a course with everyone

The full loop, start to finish:

1. Fly it and press **Alt+G** at each gate (or click **Build test course ahead of me** to skip flying and just exercise the loop).
2. Click **Copy JSON** in the editor — it's now on your clipboard (and in the JSON box below it too, if the clipboard is blocked).
3. Paste it to a file and run `race/tools/add_course.py`, which validates it the same way `Course.normalize()` does in the client and writes/updates both `race/courses/<id>.json` and `race/courses/index.json` for you:

   ```
   python race/tools/add_course.py path/to/pasted.json
   ```

   It refuses to silently overwrite an existing course whose *gate geometry* changed — that resets the course's leaderboard, since the board is keyed by a hash of the geometry — and explains why. Pass `--force` if overwriting is actually what you want.
4. Commit and push.
5. Friends click **↻** to see it.

Course schema:

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

- `alt` is in meters, the same value GeoFS reports in `llaLocation[2]`.
- If gates *look* offset vertically from where they trigger, adjust `ALT_OFFSET_M`. It only moves the visuals.
- `startType` is `"ground"` (default, omit it if the course starts on a runway) or `"air"` for
  a course whose first gate is mid-air with no natural spawn point nearby — see "Racing an
  air-start course" below.
- `itemBoxes` is optional: up to 24 per course, the contested powerup pickups (see "Powerups").
  They are **not** gates — they never count for progress, never add a split, and are deliberately
  excluded from the course hash, so adding or moving boxes never resets a leaderboard. Put them
  off the fastest line so taking one costs something.
  - The in-sim editor drops them for you: **Alt+B** puts one where the aircraft is, **Alt+Shift+B**
    puts a row of three 120 m apart across your current heading. Both are also buttons in the
    course editor.
  - Courses written before 0.10.0 have a single `itemBox` object instead. Both the client and
    `add_course.py` still read it, as a one-element list, and rewrite it as `itemBoxes`. Setting
    both keys is an error rather than a guess.

### Checking a course against terrain

Gates placed from coordinates rather than flown can end up inside a hill, and you only find out
when a racer flies into it. `tools/check_terrain.py` samples terrain height at every gate and
every ~250 m along every leg, and reports per course whether the route clears terrain:

```bash
python race/tools/check_terrain.py                                   # the three Oregon courses
python race/tools/check_terrain.py --all --cache terrain-cache.json  # everything, cached
python race/tools/check_terrain.py gorge-run --step 100 --margin 200 # tighter sampling
python race/tools/check_terrain.py --json                            # machine-readable
```

It is **read-only with respect to courses** — it never touches `race/courses/`. The only file it
writes is the `--cache` sample table you ask for (a read-through cache: it fetches only the
samples it doesn't already have, which makes re-runs instant and doubles as an offline source
via `--source file --samples-file`).

Findings, where clearance = path altitude − terrain height:

| Level | Means | Fails the course |
|---|---|---|
| `BURIED` | clearance < 0 — the route is inside the ground | yes |
| `CLIPPING` | a gate whose clearance is less than its own radius, so part of the sphere is underground | yes |
| `LOW` | above ground but under `--margin` (default 150 m) | yes, unless `--warn-low` |

Exit code is 0 if every course passed, 1 if any failed, 2 if the check couldn't run (no terrain
data, network error). Legs are sampled, not just gates, because two perfectly good gates can
have a ridge between them — and the sampled path altitude includes the sag of a straight line
between gates (~30 m over a 40 km leg), so what's checked is where the aircraft actually is.

Terrain sources (`--source`):

- **`usgs`** (default) — USGS 3DEP point queries. US-only, which covers every course here so
  far, and at 1–10 m resolution it's finer than what GeoFS draws. One request per sample, so it
  runs on a thread pool and likes a `--cache`.
- **`cesium`** — Cesium World Terrain through Cesium ion, i.e. the terrain Cesium 1.96 actually
  renders. Needs `CESIUM_ION_TOKEN`. **Unverified end to end:** `api.cesium.com` is blocked from
  the machine this was written on, so the quantized-mesh decoder has only ever run against
  synthetic tiles built by `test_check_terrain.py`. If a real tile disagrees with it, trust
  `usgs` and fix the decoder.
- **`file`** — a JSON sample table, no network at all. A missing sample is an error, not a pass.

Because the default source isn't the exact tileset GeoFS renders, treat a marginal `LOW` as
"go and look" rather than gospel. A `BURIED` by hundreds of metres is not marginal.

### Checking terrain against what GeoFS actually renders

`check_terrain.py`'s USGS source is US-only, and its `cesium` source has never run against a real
tile (see above). `tools/terrain_probe.js` is the worldwide alternative: a one-shot, **read-only**
bookmarklet that samples the terrain **GeoFS's own Cesium viewer is actually drawing**, in the
browser, the same way `tools/probe.js` reads live internals instead of guessing at them.

1. Create a bookmark with this line as the URL (same fetch-and-inject pattern as the PROBE line
   in `bookmarklet.txt`, just pointed at this file):

   ```
   javascript:(()=>{fetch('https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/tools/terrain_probe.js?t='+Date.now()).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}).then(t=>{const s=document.createElement('script');s.textContent=t;document.head.appendChild(s);}).catch(e=>alert('FINSONLY terrain probe failed to load: '+e.message));})()
   ```

2. Open GeoFS, wait for the plane and FINSONLY Racing to load, then click the bookmark. It
   prompts for a course id (read from the same `COURSE_BASE` index FINSONLY Racing itself just
   loaded from — this probe never hardcodes its own course URL), samples every gate plus every
   100 m along each leg with `Cesium.sampleTerrainMostDetailed`, and prints a `console.table`
   (point, lat, lon, route alt, terrain height, clearance, PASS/FAIL/UNVERIFIED) plus a one-line
   verdict. It then copies a JSON report to the clipboard (console.log fallback) — paste that back
   to compare against a `check_terrain.py --source usgs` run on a US course.
3. **Zero writes to sim state** — no `llaLocation`/velocity/`htr`/camera writes, no
   `resetFlight()`. If it can't find `geofs.api.viewer.terrainProvider`, or FINSONLY Racing isn't
   loaded (so there's no course loader to reuse), it prints exactly what it tried and stops —
   fail closed, like `probe.js`. A tile that fails to load marks that one sample `UNVERIFIED`
   rather than silently passing it or crashing the whole check.
4. Uses the same 150 m clearance margin as `check_terrain.py`'s `DEFAULT_MARGIN_M`, and the same
   leg-interpolation/chord-sag geometry, so a course checked by both tools is sampled at matching
   points. `race/test/run.js` has a pure-JS unit test for that geometry (no Cesium needed).

**Not yet run against the live site** — like the `cesium` source above, `Cesium.sampleTerrainMostDetailed`
being reachable and returning real heights through `geofs.api.viewer.terrainProvider` is confirmed
by nothing but this probe's own fail-closed checks so far. Paste back a run's console output (or
its JSON report) so any wrong assumption here gets corrected the same way `probe.js`'s reports
already have been.

### Recording a landing and replaying it through the touchdown detector

`touchdown.js` is a pure-function landing analyzer — feed it a stream of samples and a runway,
get back `liftoff`/`touchdown`/`bounce`/`go_around`/`settled` events (see the file's top comment
for the exact sample shape). It is **not wired into race.js**; these two tools exist so it can be
exercised against a real landing without any scoring feature depending on it yet.

1. **`tools/recorder.js`** — a read-only bookmarklet (same fetch-and-inject pattern as PROBE in
   `bookmarklet.txt`, pointed at `race/tools/recorder.js`). Alt+T starts a 20 Hz capture (Alt+T
   again stops it early; it stops itself at 5 minutes regardless), and the **Copy JSON** button on
   its small floating panel copies the capture to the clipboard.
2. Every field it reads comes from the `FIELD_MAP` constant at the top of the file, and every
   entry ships as a **TODO-PROBE** placeholder — it records real timestamps but null/false for
   every GeoFS-sourced field until `FIELD_MAP` is filled in from a fresh `tools/probe.js` report
   (or a `LANDING_SAMPLER` capture) run against a real landing. Never guess a path there and ship
   it unverified — see CLAUDE.md.
3. **`tools/replay_landing.mjs`** — a Node CLI, no browser needed: `node replay_landing.mjs
   recording.json [runway.json]`. It runs `touchdown.js` over the recording and prints the event
   list plus a table of the key numbers off each touchdown (sink rate, IAS, bank, pitch,
   centerline offset, distance from threshold). `runway.json` is optional — without it, the
   centerline/threshold columns read `n/a` instead of a fabricated number.
4. `tools/sample_landing_recording.json` and `tools/sample_runway.json` are a checked-in
   synthetic example — `node race/tools/replay_landing.mjs race/tools/sample_landing_recording.json
   race/tools/sample_runway.json` runs out of the box with no live capture needed.

### Shared course status

`Course.normalize()` whitelists exactly `id`/`name`/`version`/`aircraftId`/`startType`/`itemBoxes`/`gates` —
any other field (e.g. a `note`) is silently dropped by the client and by `add_course.py` on
their next save, so status notes for shared courses live here instead:

- **All four courses** carry item boxes as of 0.10.0: two rows of three each, on the legs into
  gates 2 and 5, 40% of the way along the leg, 120 m off the ideal line (alternating sides) and
  at the interpolated gate altitude. Same rule on every course so they read the same in the air;
  see `race/tools/` history for the placement script and "Powerups" for what they do. Adding them
  left every course hash unchanged, so no leaderboard moved.
- **gorge-run** (Columbia Gorge Run), **hood-circuit** (Mt. Hood Circuit), **crater-rim**
  (Crater Lake Rim) — added 2026-09-17, gates hand-placed from coordinates, **not yet
  flown**. `tools/check_terrain.py` has now been run against all three (2026-09-17, USGS 3DEP,
  250 m steps, 150 m margin) and **two of them don't clear terrain**:

  | Course | Result | Worst clearance | What's wrong |
  |---|---|---|---|
  | hood-circuit | **PASS** | +1333 m | nothing — 176 samples, zero findings |
  | crater-rim | **FAIL** | −72 m | gate 2 clips the rim (52 m clearance, 100 m radius); gates 1 and 5 under margin; 4 buried samples on leg 4→5 |
  | gorge-run | **FAIL** | −547 m | gate 5 buried 261 m inside a ridge; 61 buried samples, mostly legs 3→4 and 4→5 |

  So gorge-run and crater-rim are **not flyable as authored** — the route goes through the
  Gorge's walls rather than along the river. Re-fly them and re-import as a new version rather
  than hand-editing the coordinates (see the geometry-hash note above — moving a gate resets
  that course's leaderboard anyway). Re-run the check after re-importing.
- All three are marked `"startType": "air"` — none of their first gates sit at a runway. Use
  **Fly to start** to get to gate 1 (see "Fly to start" above).
  gorge-run's first gate (320 m alt, near the Sandy River mouth east of Troutdale) is the
  closest to an airport of the three, but it's still ~300 m above the valley floor and well
  off the nearest strip, not a spawn point — see "Racing an air-start course" below.

## Course on the map

When a course is loaded, its gates and route line also draw on GeoFS's own nav map
(open it with the in-sim map button). Each gate is numbered 1..N with the start and
finish gates styled distinctly, and gates dim as you pass them, mirroring the 3D
gate spheres. This is gated behind `CONFIG.COURSE_MAP` (default `true`) at the top of
`race.js`, so it can be turned off instantly if it misbehaves; turning it off means the
module doesn't even subscribe to race events, not just that it skips drawing.

**Live-untested.** The probe confirmed GeoFS's map is Leaflet 1.9.4 and found the
Leaflet library and the map's DOM container, but not a reachable live `L.Map`
instance to call `.addLayer()` on — `G.leafletMap()`'s DOM-container recovery path
(see the `G` adapter in `race.js`) is therefore unverified against the live site. If
`G.leafletMap()` can't resolve an instance (or the map has never been opened), the
overlay quietly turns itself off with a one-line status in the panel — the race and
the 3D gates are unaffected either way.

## Model swaps

Every racer still flies the stock F-16 — physics are untouched — but can be *rendered*
as a joke model: goldfish, bratwurst, traffic cone, toilet, parcel box, or cow. Friends
see each other's models too, driven by `models/assignments.json`.

### Before trusting this

The code that swaps models (the `ModelSwap` module and the new methods on `G` in
race.js) started out written against **assumed** GeoFS/Cesium internals. A probe run
against the live site (Cesium 1.96, GeoFS `v=3.9`) has since confirmed most of it:

- `Cesium.Model.fromGltfAsync` is **not** available there; `fromGltf` is — the legacy
  fallback path is the one that actually runs, and it's covered by a test.
- `animation.values.pitch`/`.roll` are real numbers — orientation reads correctly.
- The stock aircraft's visual node is `aircraft.instance.object3d`, and it uses a
  `.visible` boolean, **not** `.show` (the original guess). `G.isShowable`/`G.setShow`
  now handle both. Its `_children` array (one entry per aircraft part — body, wings,
  ...) each has its *own* `.visible` too; hiding only the root left parts still
  rendering in-game, so `stockAircraftNodes()` now hides the root and every child.
  Other players' aircraft have the same structure, so `normalizeUser()` collects root +
  children too, and `_tickOthersTransforms()` re-hides them every frame (not just at spawn).
- Multiplayer users live at the *global* `multiplayer.users` (not `geofs.multiplayer`),
  keyed by user id. Each user's position/heading is `user.lastUpdate.co = [lat, lon,
  alt, headingDeg, ?, ?]`, and their visual node is `user.model`.

Still unconfirmed / best-guess:

- `co[4]`/`co[5]` are assumed to be pitch/roll degrees — both were `0` in the sample
  probed, which is consistent but not conclusive.
- "Hide in cockpit view" (`G.isCockpitView`) — the probe now also captures
  `geofs.camera`, but that field hasn't been checked against a live cockpit-view sample
  yet.

If a guess is wrong, the swap fails closed: `ModelSwap` never throws, and a bad guess
just means "flying stock" plus a status message under **Your plane**, not a broken race.
To re-check or narrow down what's left:

1. Create a bookmark with the **PROBE** line from `bookmarklet.txt`.
2. Open GeoFS, wait for the plane to load, click the bookmark (or paste the one-liner
   from the PROBE section of `bookmarklet.txt` straight into the DevTools console).
3. It never modifies anything — only reads properties, depth-limited and capped at
   ~200 KB — and copies a JSON report to your clipboard (falls back to `console.log`
   if the clipboard is blocked).
4. Paste the report back so any remaining `TODO-PROBE` guesses in race.js can be
   corrected against what GeoFS actually exposes.

### Physics Lab: finding out which writes stick

`tools/probe.js` above is strictly read-only, so it can only report *typeof* — it can't say whether
a given write actually holds, decays back, or gets overwritten by GeoFS's own per-frame physics.
`tools/physics_lab.js` is the write-capable companion that answers that: a debug-only bookmarklet
panel, **never** referenced by any bookmarklet.txt line a player would use, and never loaded by
`race.js` itself.

1. Create a bookmark with the **LAB** line from `bookmarklet.txt`.
2. Open GeoFS on a **throwaway flight** — every button in the panel writes to sim state, and some
   (Teleport, Rails) will move or freeze the aircraft outright.
3. Click **DISCOVER** first: a read-only report of `geofs.aircraft.instance`, its `rigidBody`,
   `engine`/`engines[0]`, `window.controls`, the autopilot object, and `geofs.aircraft` — own keys
   with their typeof, every prototype-chain method with its arity (walked up to but excluding
   `Object.prototype`), and, for `rigidBody`, every numeric/array-of-numbers field with its current
   value. It never calls anything, same read-only guarantee as `probe.js`.
4. Then click one write test at a time: **Throttle** / **controls.throttle**, **Autopilot** /
   **Autopilot engage()** (calls a discovered `engage`/`enable`/`hold`-style method instead of
   poking boolean flags, and logs heading/altitude/speed follow error over 10 s), **Teleport A–E**
   (direct `llaLocation` write, `resetFlight()` off a moved `lastFlightCoordinates`, a discovered
   own-key reposition method, the full 5-element `[lat, lon, alt, hdg, keepSpeed]` + `resetFlight()`
   shape, and a discovered prototype-chain reposition method), **Speed scalar / velocity vector /
   thrust multiplier / rigidBody velocity** (+50 m/s along heading, via a discovered setter or the
   field itself), **Engine thrust boost** (×2 for 5 s, measures the kias gain, then restores it),
   and **Rails** (writes position every frame for 10 s, then releases control to see if it keeps
   flying). Each snapshots state first, applies one write, and samples the readback at
   +100 ms / +1 s / +3 s (some also add a longer window), classifying it as held / decayed / snapped
   back / unknown.
5. **Restore** reapplies the snapshot taken when the panel first loaded — including `rigidBody`'s
   velocity-shaped field and `controls.throttle`, not just `llaLocation`/`htr`/speed/velocity.
   **Copy JSON** copies the full results blob (also auto-copied after every test) — paste it back so
   the confirmed-vs-guessed writes in race.js (Boost, the speed penalty, FlyToStart) can be corrected
   or extended from real data instead of another guess.

Field discovery reuses `probe.js`'s regex-scan approach (search `geofs.controls`/`aircraft.instance`
for throttle-like fields, search for anything named `autopilot`, search for `flyTo`/`setPosition`/
`place`/`reset`-like methods) rather than hardcoding one guessed path — the panel logs every
candidate it found, not just the one it tried, distinguishing own-key candidates (Teleport C) from
prototype-chain ones found via DISCOVER's walk (Teleport E). **Not yet run against the live site.**

### Generating the models

```bash
cd race/tools && pip install pygltflib numpy && python build_models.py
```

This writes six low-poly `.glb` files (vertex-colored, no textures, no third-party
meshes, <300 KB each) and `models/index.json` to `race/models/`. Each model is
authored nose-first along +X, up along +Y (glTF's Y-up convention), then scaled so
its longest axis is ~15 m to match the F-16. If a model looks rotated once swapped in
(Cesium converts glTF's Y-up to its own Z-up and treats local +X as forward), fix it
with that model's `offset.headingDeg/pitchDeg/rollDeg` in `models/index.json` — don't
re-author the mesh.

### Assigning models to people

Edit `race/models/assignments.json` (callsign → model id from `models/index.json`,
matching `geofs.userRecord.callsign` exactly) and push. The client fetches it with a
cache-bust query, so changes show up within about a minute for everyone.

### Using it

Open **Your plane**: pick a model, tick the box to show it (unticking flies stock
without losing your selection), and optionally hide it in cockpit view. Your pick is
saved in this browser (`localStorage`) and overrides your `assignments.json` default;
leaving it unset falls back to whatever `assignments.json` says for your callsign.
`window.__finsModel` is kept in sync with the active model id — finished runs send it,
and the leaderboard shows it next to the name.

## Powerups

Mario-Kart items for the race. Two halves, and the first one works with no server at all:

**1. Loadout (no relay needed).** Before a race, pick 2 items from a defensive, self-only pool
in the **Powerups** panel: **Speed Boost** and **Shield**. Duplicates are fine — 2× Boost is a
valid loadout. Your picks are saved in this browser and refill every time the race re-arms
(Alt+R), so you get them again each run. Fire them with **Alt+1** / **Alt+2**.

- **Boost** — a few seconds of extra ground speed on your own aircraft.
- **Shield** — for its duration, incoming offensive items bounce off you.

**2. Contested item boxes (needs the relay).** A course carries a list of `itemBoxes` — the four
shipped courses have a row of three roughly every third gate, set off to one side of the ideal
line so grabbing one costs you a little. Each box is a slowly rotating yellow cube with a `?` on
it. Fly through one and the relay rolls you an item; the slot spins for a second and a half and
then reveals what you actually got, and you fire it with **Alt+3**.

Boxes are **contested**: the first pilot through a box takes it, and it goes dark for
**everyone** for six seconds before fading back in. Two of you arriving together do not both get
an item. Boxes only trigger while the clock is running, so you can't farm them on the taxiway.

### Seeing it coming (0.10.0)

Everything offensive is a thing in the world now, not a message:

- A **missile** or **goop** is a glowing projectile with a trail, launched from where the shooter
  was and steering toward where you *are* — it visibly homes. It takes 1–4 seconds to arrive
  (distance ÷ 250 m/s, clamped), and the hit only happens when it lands. You get a **MISSILE
  INBOUND from \<callsign\>** banner with a bar draining over the flight, an arrow pointing at
  the projectile even when it is off screen, and a cue that speeds up as it closes. **That is a
  real decision window: pop your Shield while it is in the air and it bounces**, in a white ring
  flash instead of a splat.
- A **banana** is a large yellow object with a pole to the ground, dim until it arms a second and
  a half after the drop (so you can't kill the wingman on your tail), pulsing after. It lands
  150 m *behind* the pilot who dropped it. It shows on the minimap. Hitting one is detected by
  your own client, per frame and in 3D, which is why it catches you at 400 kt where the relay's
  twice-a-second position pings would tunnel straight through it.
- A **Boost** trails orange behind the aircraft flying it, for everybody, and puts a speed-line
  vignette on the booster's own screen. A **Shield** is a translucent cyan bubble that flashes
  white when it eats something.
- Getting hit **shakes the view** for half a second (a quarter for a banana). It is a CSS
  transform on the render canvas and nothing else — it never touches the aircraft — and it is off
  under `prefers-reduced-motion` or with `CONFIG.HIT_SHAKE` false.

All of this needs a relay speaking **proto 3** (see `race/PROTOCOL.md`). Against an older relay
the client behaves exactly like 0.9.0 and says so on the status line.

### Why the box is a catch-up mechanic

The **relay decides what you get, and the roll is weighted by your live race position** — the
further back you are, the better the odds. That's the whole point: boxes help whoever is losing,
instead of snowballing the leader. The weights interpolate smoothly between three anchor tables
(`weights_for_rank()` in `race/server/app.py`), so there's no cliff between "midfield" and
"last":

| Your position | nothing | banana | goop | boost | missile |
|---|---|---|---|---|---|
| Leader | 30 | 45 | 15 | 10 | 0 |
| Midfield | 5 | 20 | 25 | 30 | 20 |
| Last place | 0 | 10 | 15 | 35 | 40 |

The leader mostly gets a banana to drop behind them, and last place is the only one with a real
shot at the missile. A solo racer counts as the leader — there's nobody to catch up to.

These numbers were **retuned in 0.10.0**, because the shape of the game changed under them: with
a row of boxes every third gate you draw from this table four or five times a race instead of
once. At the old weights that turned the leader's 45% "nothing" into being starved out of the
item game entirely, and last place's 50% missile into a hose. The catch-up gradient is the same
— the expected value of a roll still rises strictly from leader to last, which is what
`test_roll_item_weighting_favors_the_back_of_the_pack` pins — it is just measured over several
rolls now instead of one.

### The items

The mechanics. The player-facing version, with what each item looks like to the person it hits and how to counter it, is "Items" in the root README.

| Item | From | Does | What everyone else sees |
|---|---|---|---|
| Speed Boost | loadout or box | Temporary speed increase on your own aircraft | An orange glow trail behind you |
| Shield | loadout | Blocks incoming offensive items for its duration | A cyan bubble around you, flashing white when it eats something |
| Banana | box only | Dropped 150 m behind you, arms after 1.5 s; hits whoever flies into it — brief wobble + tint | The banana itself, in the world and on the minimap |
| Mustard missile | box only | Telegraphed 1.5–4 s flight at the nearest player *ahead*; screen tint on impact | A mustard projectile homing in, then a yellow splat (or a white ring if a Shield ate it) |
| Goop | box only | Telegraphed 1–3 s flight at the nearest player ahead — you get GRILLED: a few seconds of view-obscuring overlay | A green projectile, then a green blob riding the victim for the whole duration |

Offensive items are **relay-only and relay-adjudicated**: your client can say "I crossed that
box", "I fired what you gave me", and "I flew into that banana", but it can't pick its own item,
choose who it hits, or claim a hit on a banana it isn't near — the relay checks that last one
against your own most recent position report. The relay rolls, the relay targets, the relay
decides when a projectile lands, and it refuses a `fire` for an item it never granted you.
Firing with nobody ahead hands the item back instead of burning it.

Shield is now checked by the relay **at the moment a projectile resolves**, which is what makes
the decision window real; it still only ever believes a shield it saw you light up. Everything
lands in the HUD feed and the panel's kill feed.

### Without the relay

If `CONFIG.API_BASE` is empty, or the relay is down, or your connection drops, powerups fall
back to **loadout-only mode**: Boost and Shield keep working exactly as above, boxes and all
offensive items are disabled, and the panel says so. The client reconnects with an exponential
backoff while a race is running, and a permanently dead relay just means loadout-only forever —
it can never break the race itself. The room defaults to the course hash, so everyone racing the
same course lands in the same room automatically; type a **Room** code to override that.

### Before trusting this

**Live-untested — none of this has been flown yet.** The things to watch:

- **Boost, the speed penalty, Fly to start, the grid and the rolling start all write through
  one adapter (`GeoPhysics`) on GeoFS calls verified in-sim on 2026-09-23** — see **Writing to
  the aircraft** below. Every speed write is clamped under `CONFIG.MAX_SPEED_MS`, so none of
  them can trip the teleport/slew DQ.
- **Real control disruption is off by default.** `CONFIG.POWERUP_CONTROL_EFFECTS` is `false`
  because nothing in `race/tools/probe.js` has ever captured GeoFS's control inputs, and
  guessing at a writable control surface is exactly how you get a stall instead of a wobble. As
  shipped, banana/missile/goop are **screen effects only** — still disorienting, zero risk. The
  probe now has a `controls` section: run it (see "Model swaps → Before trusting this" for how)
  and paste the report back to decide whether a real, safe control hook exists.
- **The optional speed penalty is off too.** `CONFIG.POWERUP_SPEED_PENALTY` (default `false`)
  makes a missile hit cost you real speed: one `GeoPhysics.addSpeedAlongPath` down to
  `max(current × 0.75, CONFIG.PENALTY_FLOOR_MS)`, held for 1.5 s. It never goes below the floor,
  never applies below 150 m AGL when AGL is readable, never stacks with itself, is cancelled
  outright by a live Boost, and cannot trip the DQ (which only ever fires on going too *fast*).
  It is a speed write, not a control write — `POWERUP_CONTROL_EFFECTS` stays `false` and this
  does not touch it. Turn it on once somebody has flown a few races with the cosmetic version.
- **Matching a relay callsign to a GeoFS multiplayer user is unverified.** Item effects are
  placed on other pilots using GeoFS's own interpolated `multiplayer.users` position when the
  callsigns match, because it is smoother than the relay's twice-a-second `world` frame. The
  match is a trimmed, case-folded string compare inside the `G` adapter and it fails closed: no
  match means the relay frame is used instead, which always works.

Everything is behind `CONFIG.POWERUPS` (default `true`) at the top of `race.js`, and the 0.10.0
visible half is additionally behind `CONFIG.ITEMS` (default `true`). Turning `POWERUPS` off means
the module never subscribes to the race event bus, renders no UI, and binds no keys — not just
that it no-ops.

## Lobby

Replaces "agree a takeoff time over Teams and each type the same HH:MM:SS into a local-clock
countdown" with a relay-managed room: one host, one shared clock, and a start that's refused
until the room actually agrees to it. Needs the relay (`CONFIG.API_BASE`) and a server that
speaks protocol version 2 (`race/PROTOCOL.md` "Proto 2: lobby") — against an older relay, or
with no relay at all, the lobby overlay never appears and the old manual countdown (now tucked
under "Manual sync (no relay)") keeps working exactly as before, with one status line explaining
why.

- **Joining:** connects to the same room the powerups relay would use (course hash, or a typed
  room code) as soon as one is available — you don't need a course loaded yet to gather and
  chat. The first to join is host; hosting migrates to the next-longest-connected pilot if the
  host disconnects.
- **Ready up:** the lobby card shows every pilot with a ready badge and a host marker. Press
  **Alt+Y** or click **READY UP** to flip yours. (Not Alt+R — that's Reset run, shipped since
  0.1 and not worth relearning.)
- **Host controls:** pick the course (auto-loads for everyone, with a blocking warning if
  someone's local copy doesn't hash-match), toggle Powerups/Teleport rules, and start the
  countdown. **Start countdown** is disabled with a reason until everyone is ready; **Force
  start** skips that but turns anyone not-ready into a spectator for that race, after a confirm
  naming who.
- **Quick chat:** six fixed buttons (Ready soon, Need 2 min, GG, Rematch?, BRB, Boss incoming!)
  land in the HUD feed for the whole room — there's no free-text chat.
- **Grid start:** on an air-start course with the Teleport rule on, everyone gets placed on a
  starting grid behind gate 1 (staggered laterally and vertically) at countdown start instead of
  each pilot free-flying to converge on it by eye.
- **Jump starts:** crossing gate 1 before the synced GO costs `CONFIG.JUMP_START_PENALTY_MS`
  (5 s) added to the lobby-race clock — never a DQ. The leaderboard's own gate-1-crossing clock
  is untouched, so course records stay comparable whether or not the run came out of a lobby.
- **Spectators:** anyone force-started without readying up watches standings and the feed with
  no timer, no items — gates still render so it's still worth watching.
- **Results:** a lobby race no longer just stops mattering. It ends on a shared results screen,
  and the host can string races into a cup — see "Results and cups" below. **Start cup** sits
  with the host controls (name, 1–12 races), and the card says which race of the cup is next.

Behind `CONFIG.LOBBY` (default `true`), which also requires `CONFIG.POWERUPS` since it rides the
same relay socket rather than opening a second one.

## Results and cups

A lobby race ends on **one results screen for the whole room** — finish order, times, points,
awards and, in a cup, the running standings — instead of each pilot's own banner (0.11.0, relay
protocol 4; `race/PROTOCOL.md` "Proto 4: results and cups"). It needs a relay that speaks proto 4
and is behind `CONFIG.RESULTS` (default `true`, and it needs `CONFIG.LOBBY`). Against an older
relay nothing new is sent and a lobby race ends on a local-only card: where you stood when you
crossed the line, from the standings you already had, with your own time and no points — plus one
status-line note saying which proto the relay speaks.

- **What is reported.** Crossing the last gate of a lobby race sends `finish`; a DQ, or a reset or
  course swap while the race is on, sends `dnf`. The time in a `finish` is on the **lobby clock**
  (from the synced GO, with any jump-start penalty in it), *not* the gate-1 clock the leaderboard
  uses — that post is unchanged, so course records stay comparable whether or not a run came out of
  a lobby. The relay believes a finish only from a racer in that race, once, and only if the time
  agrees with its own clock to within 3 s. Nothing else on the table comes from a client: items
  used, hits taken and the rest are counted by the relay from the frames it already handles.
- **When a race ends.** When every racer has finished, dropped out or disconnected, or two minutes
  after the first finisher — whoever is still flying is then a DNF at the last gate they reported.
  Spectators never hold a race open. A disconnected racer is a DNF (a finisher who disconnects
  keeps their finish).
- **The card.** A winner headline ("Steve wins", or "You win!"), the winner's time and aircraft, a
  **New course record** badge when the winner's run tops the board and was posted after this race
  started (the client asks the board a moment after the results arrive, and again a few seconds
  later), a table (position, pilot and model, time, gap, items used, points), the cup standings, and
  the awards. It never covers a pilot who is still racing. A pilot who has finished sees a live
  **waiting for N pilots (mm:ss)** line counting down to the two-minute mark, with the rows
  filling in as each finish arrives. **Esc** closes it.
- **Points** are 15, 12, 10, 8, 6, 4, 2, 1 by finishing position; a DNF (or ninth and below)
  scores nothing. **Awards**, each only when someone qualifies: *most hits taken*, *sharpshooter*
  (most offensive items that landed — a blocked hit does not count), *biggest comeback* (worst
  place minus final place, at least two), *fastest sector* (the shortest gate-to-gate leg),
  *clean race* (finished with no hits taken — only when somebody in the race was hit) and *jump
  starter*.
- **After the flag.** Your banner shows your position and points (`P2 · +12 pts`), and the winner
  gets a fanfare layered over the ordinary finish cue. The host's buttons: **Next race** (back to
  the lobby with the course picker focused, everyone's ready flag cleared) and **Rematch** (the
  same course again). Everyone's: **Race the winner's ghost** (points the Ghost picker at the
  winner and goes back to the lobby — for the host that is a rematch, for a guest it is their own
  client re-arming while the room follows when the host does) and **Close**.
- **Cups.** The host types a name, picks 1–12 races and presses **Start cup** in the lobby card.
  Points add up across the cup's races; the results and the lobby both say which race it is. After
  the last race the cup ends and the next race is a one-off. Starting a new cup replaces the
  running one. A race the host calls off with *back to lobby* is not scored and does not count
  towards the cup. **Use a room code for a cup that changes course:** the relay room defaults to
  the course hash, so loading a different course (which is what Next race then asks the host to
  do) would move you into a different room. Type the same room code into the Relay room box on
  every machine first.
- **History.** Each finished lobby race (and its cup) is saved on the server — see
  `GET /races/recent`, `GET /cups` and the landing page under "Leaderboard server". Only that
  history is kept: a cup's running total lives in memory until its last race is saved.

## Ghost racing

Race against a recording of a run instead of just a number on a board: a translucent ghost
aircraft flying the line somebody actually flew, the line itself drawn ahead of you, and a live
"am I ahead or behind" readout. Behind `CONFIG.GHOST` / `CONFIG.RACING_LINE` / `CONFIG.TRACE`
(all default `true`).

### What gets recorded

While the clock is running, the client samples `[t, lat, lon, alt, heading, pitch, roll]` four
times a second (`CONFIG.TRACE_HZ`), with `t` measured from your own gate-1 crossing — the same
origin `Race.elapsed` and the leaderboard use, which is exactly why a ghost launches when *you*
launch rather than at some absolute wall-clock time.

- Coordinates are quantized (6 dp of lat/lon, 0.1 m of altitude, 0.1° of attitude): ~0.1 m of
  resolution, far finer than a gate radius, and small enough to store and upload.
- A run longer than `CONFIG.TRACE_MAX_SAMPLES` (6000 samples, 25 minutes) stops recording and is
  marked truncated. **A truncated trace is never saved** — a ghost that stops halfway down the
  course is worse than no ghost.
- A DQ or a reset throws the recording away.
- On a finish, the trace is kept **only if the run is your personal best** for that course hash,
  in `localStorage` under a per-hash key, LRU-capped at `CONFIG.TRACE_MAX_COURSES` (20) courses.
  A full `localStorage` evicts the oldest traces and then gives up silently — losing a ghost is
  never worth an error at a finish line.
- If the leaderboard is on, the trace also rides along on `POST /runs` as an optional field. An
  older server ignores the field and nothing else changes.

### Picking a ghost

**Ghost → Race against** in the panel, remembered per course hash:

| Pick | Flies |
|---|---|
| Off | nothing |
| My best | your own saved trace for this course |
| Course record | the fastest trace anyone has uploaded for this course |
| *a pilot's name* | that pilot's best trace (one entry per leaderboard row with `has_ghost`) |

Spectators get the picker too. A pick that isn't currently on offer (board not loaded yet, that
pilot dropped out of the top N, leaderboard down) is shown as "· unavailable" rather than
silently reset — it comes back on its own when the board does.

The ghost is drawn with the pilot's joke model at `CONFIG.GHOST_ALPHA` (0.45), labelled
`GHOST · <callsign> · <time>`. If that model won't load it falls back to the goldfish, and if
`Cesium.Model` isn't there at all, to a plain point and label. It is hidden until you cross gate
1 and parks at the finish gate when its trace runs out. It is a scene primitive this script owns
— never registered as a multiplayer user, never touched by the multiplayer re-hide that fixes
the model-swap flicker, and tagged `__finsGhost` so that stays assertable.

### The racing line

The selected ghost's path, drawn as one glowing polyline from where you are on it to
`CONFIG.LINE_AHEAD_M` (4000 m) of path length ahead, rebuilt at most `CONFIG.LINE_REBUILD_HZ`
(2) times a second. Its colour is the live delta: **green** when you're ahead of the ghost,
**amber** within ±`CONFIG.LINE_DELTA_BAND_MS` (300 ms), **red** when you're behind. The amber
band is deliberate — without it the line strobes every time a close race crosses zero.

With no trace for the course at all, it draws a **dashed, neutral** Catmull-Rom spline through
the gate centres instead, labelled "Suggested line (no recorded run yet)" so the two can never
be confused in the air.

**Alt+L** toggles the line, and the choice sticks.

### Race a friend's ghost (0.12.0)

Behind `CONFIG.RIVAL_GHOSTS` (default `true`) and `CONFIG.RIVAL_GHOSTS_MAX` (3): up to
`RIVAL_GHOSTS_MAX` ghosts fly at once instead of just the one. The existing **Race against**
picker above stays the **one primary ghost** — it's still what the racing line colours against and
what `#fr-hud-ghost` shows — and a new **Race a friend** section in the panel adds up to
`RIVAL_GHOSTS_MAX - 1` more, each its own picker with the same presets plus one new one:

| Pick | Flies |
|---|---|
| Off | nothing |
| My best | your own saved trace for this course |
| Course record | the fastest trace anyone has uploaded for this course |
| Next one up | whoever is *just* faster than your personal best right now — resolved to that pilot's name the moment you pick it |
| *a pilot's name* | that pilot's best trace, from `GET /ghosts` |

Every rival renders exactly like the primary ghost — its own joke model (or the goldfish, or a
point) at `GHOST_ALPHA`, labelled `GHOST · <callsign> · <time>` — and the HUD grows a compact
stack under the split chip, one line per rival, colour-coded ahead/amber/behind the same as the
racing line (`Dave −0.41s`). A rival with a missing or corrupt trace is skipped with a status line
under its picker; it never blocks the others or the race itself.

**Challenge link.** The results screen's **Copy challenge link** button copies a URL of the form
`?course=<id>&ghost=<callsign>[,<callsign>...]` — paste it into a chat or a Teams message and
whoever opens it gets the same course loaded with the same ghosts pre-picked (first name = the
primary ghost). It defaults to challenging the winner if nothing else is already picked.

**News banner.** On load, the client asks `GET /news?callsign=<you>&since=<last-seen>` (the
timestamp is kept in `localStorage`, wrapped in try/catch — a blocked or full localStorage just
means the check runs again next time) and, if anyone has beaten one of your times since then,
shows a dismissible banner: *"Dave beat your hood-circuit by 0.41s → Race their ghost"*. This is the
in-game replacement for a Teams webhook; nothing here touches the relay.

### Waypoint bracket and minimap

- **Bracket.** A bracket and caption (`GATE 4 · 1.8 km · climb 390 ft`) sit over the next gate
  in screen space, with a smaller numbered marker on the gate after it. When the gate is behind
  the camera or within `CONFIG.HUD_EDGE_INSET_PX` (60 px) of a viewport edge, it becomes an edge
  chevron on the correct side reading `turn right 74° · 1.8 km · climb 390 ft`. This is the one
  element that updates every animation frame rather than at `HUD_HZ` — a marker that lags the
  world by 100 ms reads as broken — and it does it by writing nothing but `transform:
  translate3d(...)`. The settings panel's own ▲ arrow is unchanged and still serves HUD-off mode.
- **Minimap.** An inline-SVG, north-up course map in the HUD's bottom-right corner
  (`CONFIG.MINIMAP`), updated at `CONFIG.MINIMAP_HZ` (4, capped by the HUD's own 10 Hz render, so
  3–4 Hz in practice). Local equirectangular projection, auto-fitted; gates styled done / next /
  remaining like the 3D spheres; item box, your position and heading, the ghost, and the other
  racers when the relay reports their positions (see PROTOCOL.md's `standings.positions`, which
  an older relay omits — then there is simply nothing to draw).

### Server side

`POST /runs` takes an optional `trace`. It is validated **separately from the run** and a bad
one is dropped with a reason rather than 422-ing the submission, because losing a real race
result over a cosmetic payload is the wrong trade. The checks: ≤ 6000 samples, strictly
increasing `t`, last sample within 500 ms of `time_ms`, every coordinate finite and in range,
implied speed between consecutive samples under `MAX_SPEED_MS`, encoded size ≤ 400 KB. The
response carries `trace_saved` and `trace_reason`.

Traces live in their own `traces` table, one row per (course, callsign) holding only that
pilot's best — kept out of `runs`, which is an append-only log that has to stay cheap to scan.
The migration is `CREATE TABLE IF NOT EXISTS` and touches no existing row. `GZipMiddleware` is
on, which matters: columnar traces are long runs of small numbers and compress by roughly 10×.

| Endpoint | Returns |
|---|---|
| `GET /ghost?course_hash=abcd1234&callsign=Steve` | That pilot's best trace on that course |
| `GET /ghost?course_hash=abcd1234` | The fastest *recorded* pilot's trace (404 if nobody has one) |
| `GET /ghosts?course_hash=abcd1234` | Every ghost on that course, fastest first, each with `is_course_record` (0.12.0) |
| `GET /news?callsign=Steve&since=1234567890` | Courses where Steve's best has been beaten since `since`, unix seconds (0.12.0) |

"Course record holder" here means the fastest pilot who actually has a trace, not the fastest
time on the board — someone can hold the record from before traces existed, and 404ing in that
case is less useful than handing back the best ghost that does exist. `/ghosts` and `/news` are
both additive reads over the same `traces`/`runs` tables — no migration, and existing ghost rows
are untouched.

## Landing mode scoring (server-side)

**Server-only so far — no client wiring, no in-sim landing mode yet.** This is the scoring half
of a future landing mode: given `race/touchdown.js`'s raw `touchdown` event (plus the bounce
count and settled rollout from that module's `bounce` and `settled` events) and a runway, the
server turns it into a 0–1000 score. It exists now, ahead of the client feature, because it's
fully headless-testable and the client work depends on it.

`score_touchdown(touchdown, runway, bounce_count, total_rollout_m)` in `race/server/app.py` is a
pure function: no DB, no socket, no
sim. It starts at 1000 and subtracts a penalty per component, each capped on its own so no single
bad component can zero the score by itself (only the final total is clamped to 0–1000):

| Component | What it penalizes |
|---|---|
| Vertical speed at contact | The dominant term — nothing else is weighted close to it. Softer than the ideal band costs nothing ("greaser") |
| Centerline offset | Symmetric — left and right cost the same |
| Distance from the touchdown zone | Symmetric around the zone — too short *and* too long both cost |
| Bank / crab at contact | Wings not level, or nose not aligned with the runway |
| Bounces | Flat cost per bounce, uncapped — every additional bounce always costs more |
| Rollout | Free up to a fraction of the runway remaining past touchdown, then costs — the same rollout is cheap on a long runway and expensive on a short one |

Every constant the curve uses (weights, exponents, caps, the ideal VS band, the rollout-safe
fraction) lives in one `LANDING_*` block directly above `score_touchdown()` — nothing in the
scoring math itself is a magic number.

Runway defs live twice on purpose: `race/runways/*.json` (`index.json` + one file per runway,
for whatever eventually renders them client-side) and `RUNWAYS` in `app.py`, which is what the
server actually scores against — the deployed image ships `app.py` and `migrate_modes.py` only
(see `course_catalog()`'s note in `app.py`), so the runway a landing is scored against has
to live in the file that's actually deployed. `test_runways_json_files_match_embedded_registry`
in `test_server.py` is what keeps the two from drifting apart; nothing syncs them automatically.
Three seed runways ship: `sea-tac-16c` (wide/forgiving), `friday-harbor-16` (short), and
`sisters-eagle-air-34` (terrain on approach, near the Three Sisters). A runway uses
`touchdown.js`'s runway field names (`thr_lat`, `thr_lon`, `heading_deg`, `length_m`,
`width_m`) plus `id`, `name`, `version`, `thr_alt_m` and `zone: {min_m, max_m}`, so the same file
feeds `replay_landing.mjs`.

| Endpoint | Does |
|---|---|
| `POST /landings` | Score one attempt. Body: `runway_id`, `callsign`, optional `aircraft_id`/`model`/`client_version`, `touchdown` (touchdown.js's `touchdown` event, verbatim), `bounce_count` (its `bounce` events) and `total_rollout_m` (its `settled` event's). 404s on an unknown `runway_id`. Any client-supplied `score` is silently ignored, and so are the event's own `centerline_offset_m`/`distance_from_threshold_m` — the server recomputes everything from `lat`/`lon`/`heading_deg` and the looked-up runway |
| `GET /landing-leaderboard?runway_id=sea-tac-16c` | That runway's board: `{mode, runway_id, course_hash, rows}`, one row per callsign, best score first. The same rows as `GET /modes/landing/leaderboard?course_hash=…` |

Every posted attempt is a proto 6 `mode_runs` row with `mode_id='landing'`, `course_id` = the
runway id and `course_hash` = `runway_hash()` (8 hex of the runway's id + `version`), so bumping
a runway's `version` after re-tuning it starts a fresh board. `payload_json` keeps the raw event,
bounce count, rollout and the server's breakdown. `POST /modes/landing/runs` answers `400`: a
landing score is never taken from a client.

## Fly to start

On an air-start course, gate 1 hangs in the air miles from any runway. **Fly to start** (the
button under the course row, enabled only on `"startType": "air"` courses) puts you on gate 1,
pointed at gate 2, already flying at `CONFIG.PACE_KT` (180 kt by default):

- `geofs.aircraft.instance.place([lat, lon, altM], [heading, 0, 0])` — gate 1's position, and the
  bearing from gate 1 to gate 2
- then a level velocity vector along that heading, through the rigid body (below), so you arrive
  flying rather than falling

It re-arms the run first, and the reposition is a teleport, which Race's start detector already
ignores (`detectStart`'s `jumped` guard) — so it can neither start your clock nor DQ you. Leaving
gate 1's sphere afterwards starts the clock normally, exactly as if you'd flown there.

In a lobby room on an air-start course, this same placement (plus a full holding-pattern pace
lap) is what **Rolling start** below does for everyone at once; Fly to start is its solo,
one-shot equivalent, no server or room required.

## Writing to the aircraft (GeoPhysics)

Every write to the aircraft — Boost, the missile speed penalty, Fly to start, the lobby grid, and
the rolling start — goes through one adapter, `GeoPhysics`, built only on GeoFS calls that were
verified in-sim on 2026-09-23:

| Call | Verified | Used for |
|---|---|---|
| `geofs.aircraft.instance.place([lat, lon, altM], [hdg, 0, 0])` | works in flight | every teleport |
| `geofs.aircraft.instance.rigidBody.v_linearVelocity` (read) / `.setLinearVelocity([east, north, up])` (write, m/s, local ENU) | writes persist | Boost, the speed penalty, arriving at a teleport already flying |
| `geofs.autopilot.setSpeed(kt)` / `.setAltitude(ft)` / `.setCourse(deg)` / `.turnOn()` / `.turnOff()`, state in `.on` and `.values` | flies the aircraft, drives the throttle itself | the rolling start's pace lap |
| `geofs.controls.throttle` (read) / `controls.setters.increaseThrottle` (the only throttle setter that exists) | | the green-flag throttle check |

**Verified NOT to work, and gone from the codebase:** `geofs.resetFlight()` /
`lastFlightCoordinates`, writing `trueAirSpeed`/`groundSpeed` directly, and engine thrust
multipliers. If you see any of these mentioned in an old issue or a stale comment, they describe
a write path this version no longer has — `CONFIG.VELOCITY_FRAME`, `CONFIG.SAFE_WRITES`, and
`CONFIG.BOOST_LLA_FALLBACK` are gone with them.

Callers of `GeoPhysics` speak SI units only (metres, m/s, degrees); every kt/ft conversion
happens inside the adapter. Every write is logged to the debug overlay (Alt+D). Boost is
`GeoPhysics.addSpeedAlongPath(+50, { maxMps: BOOST_MAX_KT })`, ramped over `BOOST_RAMP_MS` in
`BOOST_RAMP_STEPS` equal steps, and never stacks — a second Boost press while one is live is
ignored and the item stays in your slot.

## Rolling start (lobby, proto 8)

On an air-start course, with `rules.rolling` on (the default) and every pilot's client new
enough (proto 8), **Start** puts the room into a NASCAR-style pace lap instead of the static
grid:

- Every ready pilot is slotted, leader first, in the order they readied up.
- Each pilot is placed into a holding-pattern oval behind gate 1 — long axis on the reverse
  gate1→gate2 bearing, ~4 km legs, standard-rate turns — and the autopilot is engaged at pace
  speed/altitude/heading. **Hands off the stick**: the Launch screen says so, and shows your
  slot number.
- Every half-second, the client steers the autopilot's course and speed to hold its slot,
  correcting along-track error with a small speed nudge (never more than pace ± 25 kt).
- If the autopilot ever comes off during the pace lap — you touched the controls — you drop to
  the back of the order. **No DQ**, just OUT OF FORMATION and a fresh slot.
- 45 seconds before green, the leader's path leaves the oval onto a straight exit toward the
  start line (1.5 km before gate 1); everyone else follows in single file, trailing 3 pace-seconds
  apart.
- At the synced GO, the autopilot disengages. The client checks the throttle right after — if it
  fell back toward idle, it presses `increaseThrottle` until it clears 90%, logged to Alt+D as
  `before`/`after`/`presses`. **THROTTLE UP.**
- Crossing gate 1's actual sphere before GO is still the existing +5 s jump-start penalty,
  unchanged — the rolling start only changes how you get to the line, not how the race itself is
  timed or scored.

Against an older relay, a ground-start course, or with `rules.rolling` off, **Start** falls
straight through to the classic grid — same course, same rules, same everything else, just
without the pace lap.

## Leaderboard server (homelab)
## Leaderboard server (homelab)

1. **DNS:** add `race.finsonly.net` as an A record pointing to your public IP, DNS-only (grey cloud) like the other subdomains.
2. **Files:** create the directories and copy the server code over.
   ```bash
   mkdir -p /mnt/user/appdata/stack/race-api/static /mnt/user/appdata/race-api
   cp race/server/{app.py,requirements.txt,Dockerfile} /mnt/user/appdata/stack/race-api/
   cp race/server/static/* /mnt/user/appdata/stack/race-api/static/
   cp race/bookmarklet.txt /mnt/user/appdata/stack/race-api/
   chown -R 99:100 /mnt/user/appdata/race-api
   ```
   The container runs as `nobody:users` (99:100), so the data dir must be writable by that user.
3. **Compose:** merge `server/compose.snippet.yml` into the stack compose file. It joins the existing `proxy` network.
4. **Caddy:** add `server/Caddyfile.snippet`, copying in the geoblock and CrowdSec directives from the jellyfin block. Don't use Authelia here, because the browser calls this API from geo-fs.com and can't follow a login redirect.
5. **Start it:**
   ```bash
   docker compose up -d --build race-api && docker restart caddy
   curl https://race.finsonly.net/health
   ```
   If Compose Manager is still missing after the crash, reinstall it from Apps first.
6. **Point the client at it:** in `race.js`, set `API_BASE: 'https://race.finsonly.net'` and push.
   This is already set as of 1.3.1 — it was left empty through 1.3.0, which silently disabled the
   entire relay and hub layer in every shipped client (no room could be created, no ramp could
   connect, and every guard that noticed failed closed without a console line). If you ever point
   a build at a different server, this is the one line to change; setting it to `''` is still
   supported and means "Solo only", which the panel now says out loud rather than just doing.

Endpoints:

| Endpoint | Returns |
|---|---|
| `POST /runs` | `{ id, rank, personal_best, improved }` |
| `GET /leaderboard?course_hash=abcd1234&limit=10` | Best time per callsign, each with `has_ghost` |
| `GET /ghost?course_hash=abcd1234[&callsign=Steve]` | One pilot's ghost trace, or the record holder's |
| `GET /ghosts?course_hash=abcd1234` | Every ghost on a course, fastest first, each with `is_course_record` |
| `GET /news?callsign=Steve&since=1234567890` | Courses where Steve's best has been beaten since `since` (unix seconds) |
| `GET /courses` | Courses with times, record, racer count, plus `cup`/`difficulty`/`length_km`/`gate_coords` joined from the shared catalog |
| `GET /courses/catalog` | Every course in the shared list, raced or not, same catalog fields |
| `GET /races/recent?limit=10` | The latest finished lobby races (max 100), newest first, each with its results best-first and the cup it belonged to |
| `GET /cups/{id}` | One cup: standings so far (points, races, wins) and the races behind them |
| `GET /cups?room=&open=1&limit=20` | Cups, newest first; `room` filters to one room, `open=1` to unfinished ones. Each carries its standings |
| `GET /stats` | `{races, pilots, gates, missiles_hit}` — homepage hero tiles, cached a few seconds |
| `GET /rooms/live` | Live rooms for the homepage departures board — never a join code or `pilot_token` |
| `GET /bookmarklet` | `{label, href}` — the real install bookmarklet, built from `race/bookmarklet.txt` at server start |
| `GET /` | The public site (see below) |
| `GET /health` | Health check |
| `WS /ws/race/{room}` | Powerups relay (see below) |

The `races`/`cups`/`stats`/`rooms/live` endpoints are read-only, share the same CORS policy as the
rest, and only ever read: the single write to the `races`/`race_results`/`cups` tables is the relay
saving a lobby race when it ends (`PROTOCOL.md` "Proto 4: results and cups"); `/rooms/live` reads
the relay's in-memory room state directly and touches nothing. `/stats` and `/rooms/live` are
cached a handful of seconds in memory and rate-limited per IP (`RACE_GET_MIN_INTERVAL_S`), since
every open tab of the public site polls them.

**`GET /`** is the public site — `race/server/static/{index.html,site.css,site.js}`, served as
plain static files (no template, no build step): a hero record replay (the most recent course
record's ghost trace, animated over an SVG route map), a live departures board, course records
grouped by cup with a mini route map and difficulty chip per course, recent races and open cups,
and the real install bookmarklet built from `race/bookmarklet.txt`. Every section has its own
loading skeleton, empty state and error state, and times out after 8 s rather than sitting on
"Loading…" forever. It builds everything with `textContent`, never `innerHTML`, because callsigns
and course names are typed by pilots. Google Fonts (Saira, Saira Condensed) is the one deliberate
external request; the `Content-Security-Policy` on `/` is otherwise locked to same-origin
(`default-src 'none'`, `script-src 'self'`, `connect-src 'self'`). No login, read-only, same as the
API behind it, and marked `noindex` (it's a friend-group page, not a public listing).

The API has no auth. Any key would ship inside public JS, so a secret is pointless. Protection comes from plausibility checks (split count, monotonic splits, speed-limit floor), a 5-second per-IP rate limit, and the geoblock plus CrowdSec at Caddy. The geoblock also means friends outside the US can't post times.

### Powerups relay

The same container also serves the powerups relay on `WS /ws/race/{room}` (see "Powerups"). Its
room state is **ephemeral and in-memory**: a room is one race session and disappears when its last
socket disconnects or when the container restarts — dropping active rooms on a restart is fine and
expected, since a dropped relay just means loadout-only mode for whoever was racing. The one
exception is the end of a lobby race (0.11.0, protocol 4): its results, and its cup if it has one,
are written to SQLite exactly once, in a worker thread, when the race ends (`races`,
`race_results` and `cups` tables, created idempotently at start-up like everything else). A race in
flight and a cup's running total are still in memory and die with the container; the races already
finished do not. See `PROTOCOL.md` "Proto 4: results and cups".

Messages are small JSON objects, validated with Pydantic like `RunIn`, size-capped at 2 KB and
rate-limited per connection (20/s by default, `RACE_WS_RATE_PER_S`); a sustained flood closes
the socket. Room names must match `^[a-z0-9-]{1,32}$`.

Every frame the relay speaks, by the protocol version that introduced it. **`race/PROTOCOL.md` is the
reference** — fields, ranges, refusals and the trust model are there, and it is checked against
`app.py`; this is only the index.

| Proto | Client → relay | Relay → client |
|---|---|---|
| 1 powerups | `join`, `pos`, `box`, `fire` | `joined`, `grant`, `hit`, `boxed`, `standings`, `error` |
| 2 lobby | `ping`, `hello`, `ready`, `course`\*, `rules`\*, `start`\*, `abort`\*, `chat`, `back_to_lobby`\* | `pong`, `lobby`, `start`, `abort`, `chat` |
| 3 items | `fx`, `tripped` (plus optional fields on `pos`, `box`, `fire`) | `world`, `fired`, `resolved`, `dropped`, `cleared`, `box_state`, `refund`, `fx` |
| 4 results | `finish`, `dnf`, `cup`\*, `rematch`\* | `results_progress`, `results` |

\* host only; anyone else gets `{type:"error", detail:"host only"}`.

The relay never trusts a client's self-reported rank — it computes ranking from `pos` pings
(most gates passed, then whoever got there soonest) and owns both the roll and the targeting.

## Matchmaking hub (1.2.0, server side)

Finding a race used to happen entirely outside the game: you agreed a code over voice chat and
everyone typed the same thing into their own client. 1.2.0 adds a **second socket**,
`WS /ws/hub`, that carries who is around and what rooms are open — plus the identity everything
else keys on.

**This release is the server half only.** The panel UI that talks to it is a separate piece of
work; `race.js` is unchanged in 1.2.0 apart from the version string. A 1.2.0 server runs every
existing client exactly as before (see "Compatibility" in `PROTOCOL.md`), so it is safe to deploy
ahead of the panel. `PROTOCOL.md` is the reference for every frame below.

### Pilot identity

A callsign used to be a string anyone could type. It is now a display name **owned** by a
`pilot_id` the server issues:

- First hub connect mints `{pilot_id, pilot_token}`; the client keeps both in `localStorage` and
  presents the token on later connects. The server stores only the token's sha256 — a copy of
  `race.db` is not a set of working credentials.
- A missing or unknown token is **never an error**. It just means a new pilot.
- Ownership ignores case, so `Eric` and `eric` are one pilot. Claiming a name someone else holds
  is **refused and says who holds it**; the socket stays open so you can pick another.
- **Your history follows your name.** The 1.2.0 migration mints one pilot per distinct callsign
  already on the board and leaves it *unclaimed*; the first pilot to prove that name adopts it and
  inherits every run, ghost and race result posted under it.
- Freeing a callsign is a deliberate **admin SQL step**, not a button — see
  `server/DEPLOY_CHECKLIST.md`. There is no auth in this server by design, and a name-release
  endpoint would need a secret that protects nothing.
- Leaderboards, ghosts and results still key on **callsign** in every read endpoint. Nothing about
  the existing API changed shape; `pilot_id` is written alongside and not yet read.

### The ramp: presence and rooms

Once on the hub you see, and are seen in, two lists pushed as they change (coalesced to at most
once a second per client, so a busy Friday cannot flood anyone):

- **presence** — every pilot on the hub: callsign, aircraft, what they are doing
  (`idle`/`gate`/`racing`/`solo`), which room, and how long they have been idle. Busy pilots sort
  first. You drop off after two missed heartbeats (~15 s). It is **in-memory only** — a server
  restart empties it, which is correct, because presence that outlives the process is a lie.
- **rooms** — every open room: code, host, course or cup, format, pilot count and callsigns, and
  a live status line: `boarding`, `launching` ("starts in 4s"), `racing`
  ("gate 3 of 7 — Maggie leads") or `results`.

A room registers itself the first time anyone joins it, and **keeps its code and its host for ten
minutes after the last pilot leaves**, so reopening after everyone drops out lands back in the same
room rather than a new one. The room itself is still dropped the instant it empties — the registry
entry is what outlives it.

Every room is listed to everyone on the hub. **There are no private rooms in this version**; it is
noted as future work in `PROTOCOL.md`.

### Ping the ramp

`ping_ramp` pokes everyone else on the hub once — "I'm here, come fly". Deliberately scarce, so it
keeps meaning something: **three per pilot per day** (`RACE_RAMP_PING_PER_DAY`), resetting at
midnight PT, and no more than one a minute. Going over says when you get more. It is not
configurable per room on purpose, and the counter lives in the database rather than in memory so a
redeploy cannot hand everyone their pings back.

### Lobby chat

The room socket now carries **free text**, not just the six canned phrases:

- 240 characters, truncated rather than refused, control characters stripped, whitespace collapsed.
- Its own rate limit (2/s, burst 4) separate from the socket's, so typing cannot starve the `pos`
  frames a race depends on.
- **Never stored.** Not in SQLite, not on disk, not in a log. It is forwarded and forgotten — the
  one string in this whole project that one pilot typed at another, and there is a comment in
  `app.py` at the handler asking you not to "just add a log for debugging".
- Only sent to clients that speak proto 5, so an older client never renders a half-broken line.
  The six canned codes still go to everyone, unchanged.

### Spectating

A join can say `spectate: true`. A spectator sees the standings and everyone's positions, and is
out of everything else: no rank, no grid slot, no results row, and they never hold a race open or
count toward the room's pilot cap (**12 by default**, `RACE_ROOM_MAX_PILOTS`). Trying to race
anyway is refused rather than half-accepted.

This is not the same as the spectator role a mid-race joiner already gets — that behavior is
unchanged from 1.1.0 on purpose, since those clients never asked for it.

### Course vote

Instead of the host just picking, a room can vote:

- The **server** draws three candidates plus a "surprise me" wildcard when the room opens,
  weighted toward the courses the pilots present have flown **least** — so a Friday night does not
  keep landing on the same sprint. It draws from courses that have at least one posted time, which
  is the only catalog the server has (the course files ship to the *client*, not the container).
- Anyone can vote, one vote each, changeable right up to the launch. You cannot vote for something
  that was not drawn — the relay picks the options and counts the ballots.
- Most votes wins; a tie goes to whichever the room has raced least, then to chance.
- The vote is **binding only if the host never picked a course by hand**. A host who sets one
  overrides it, and the winner is announced either way when the race launches.

### Deploying it

`server/DEPLOY_CHECKLIST.md` has the full order of operations. Two things are new:

1. **1.2.0 is the first release with a real migration** (`ALTER TABLE ADD COLUMN` plus a backfill,
   both additive and idempotent). Back up `race.db` first — §7 step 1 — even though it rewrites
   no existing row.
2. There is a **hub smoke test**: a `curl` one-liner that proves the WebSocket upgrade survives
   Caddy, then `python race/tools/hub_smoke.py wss://race.finsonly.net/ws/hub` for the actual
   frame exchange. `curl` alone cannot do the second part — it never sends the upgrade handshake.

## Tests

```bash
cd race/test && npm i jsdom@24 && node run.js      # engine + model swap + powerups client
cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q
cd race/test && python -m pytest test_add_course.py -q
cd race/test && python -m pytest test_check_terrain.py -q
cd race/test && pip install pygltflib numpy pytest && python -m pytest test_models.py -q
```

The engine tests cover:

- Flying and standing starts
- Split and finish timing
- Frame-rate independence (20 fps vs 60 fps)
- Tunneling at 600 m/s and 5 fps
- Missed gates
- Pause exclusion
- Teleport DQs, including teleporting while paused
- Teleporting through the start
- The aircraft lock
- Reset and re-run
- Hashing
- The editor
- Double-load idempotence
- Model swap: loading (both `fromGltfAsync` and legacy `fromGltf`), per-frame
  modelMatrix updates, switching models, hide/restore of the stock model, fallback
  on load failure, assignment validation, and multiplayer add/remove
- Course map: drawing gates + route on a mocked Leaflet map, cleanup on course change,
  highlight styling on gate/reset, `G.leafletMap()` resolving to `null` with no map
  present, a forced draw-path throw degrading to a status line without breaking the
  3D gates, and `CONFIG.COURSE_MAP = false` disabling the module entirely
- The aircraft write path: the pure velocity helpers (shape detection, a recorded frame
  GeoPhysics: every kt/ft/m/s unit conversion round-trips, `placeAircraft`/`setVelocityENU`/
  `addSpeedAlongPath`/the autopilot calls go through the verified GeoFS calls only and are
  logged, `addSpeedAlongPath` respects both clamps and falls back to heading direction at a
  standstill, and every call fails closed (returns false/null, never throws) with no `geofs` or
  a throwing one
- Boost: the ramp is exactly 10 steps of +5 m/s over 1.0 s (the first on the arming frame),
  capped at `BOOST_MAX_KT`, never stacking while live and working again the moment it expires,
  and measured peak speed staying under `MAX_SPEED_MS` from four starting speeds
- Formation (the rolling-start holding pattern): the track's reported heading matches its own
  numeric derivative everywhere (straight, both turns, across the lap seam) to within 3°; slot
  targets are distinct, evenly spaced, and count down at exactly pace speed; along-track error
  sign; the speed controller stays inside pace ± 25 kt and converges on a first-order aircraft
  model; start-line crossing in the right direction only; the oval's altitude clears terrain
  given a mock height function and never drops below gate 1; and `projectS` recovers a pilot's
  real `s` from a nearby seed
- Fly to start: `GeoPhysics.placeAircraft` puts the aircraft on gate 1 heading gate 2 at pace
  speed; no start and no DQ from the reposition, with the clock still starting normally on the
  way out of gate 1; and refusals (no course, ground course, a missing `place()`) that explain
  themselves and never move the aircraft
- Rolling start (client wiring, against the same GeoFS mock): a `formation` frame places the
  aircraft and engages the autopilot exactly once; a reorder for the same race updates the local
  slot but never re-teleports; the steering loop keeps commanding real numbers inside the speed
  clamp; an autopilot found off mid-pace-lap sends `formation_drop` exactly once and shows OUT
  OF FORMATION; green disengages the autopilot and presses `increaseThrottle` until it clears
  90%; and a spectator is never placed or steered
- Powerups: loadout persistence, Boost staying under `MAX_SPEED_MS` and auto-recovering,
  Shield set/clear, relay URL/room derivation, a grant filling the box slot, a fire being
  sent as exactly the granted item (with the heading proto 3 added), an incoming hit applying a
  time-boxed screen effect that clears itself, Shield blocking a hit, junk off the socket being
  ignored, relay-down → loadout-only with no throw, reconnect-with-backoff after a mid-race
  drop, and `CONFIG.POWERUPS = false` disabling the module entirely
- Items (proto 3): `itemBoxes` normalization including the legacy single `itemBox` and the
  24-box cap, and that adding boxes never changes the course hash; boxes drawing as spinning
  cubes, going dark on a pickup and fading back in, on the relay's clock; each crossing naming
  its own box; Alt+B / Alt+Shift+B dropping one box and a row of three 120 m apart;
  `projectilePos` endpoints, homing and the short way round the antimeridian; `rouletteFrames`
  always ending on the item the relay actually rolled, for every seed and item; `penaltyTarget`
  taking 25% off but never going under the floor; `makeItemLayer` holding its entity budget with
  oldest-evicted-first, enforcing a TTL, replacing rather than stacking a key, and failing closed
  on a Cesium throw; the whole layer staying dark against a proto-2 relay; a grant spinning
  before it is fireable; a missile drawn as a homing projectile that lands in an expanding splat,
  a blocked one as a white ring, and a lost one as nothing; a projectile whose resolution never
  arrives cleaning itself up; the MISSILE INBOUND banner, its draining bar and its edge arrow; a
  banana as a visible object with a pole that arms late, trips client-side at 600 m/s through 5
  fps frames, is never your own, is never claimed twice, and dies on its own TTL if the clearing
  frame is lost; goop's trailing blob on the victim and the overlay's centre-outward wipe; Boost
  and Shield fx drawn for me without waiting for the echo and for other pilots from the frame;
  the shake jittering the render canvas and always restoring it, including on reset, and doing
  nothing under `prefers-reduced-motion` or `CONFIG.HIT_SHAKE = false`; and the speed penalty
  being off by default, holding one target, never stacking, never going below the floor, never
  applying below 150 m AGL and being cancelled by a Boost
- Lobby (proto 2): `clockOffset` picking the minimum-RTT sample over a noisy one, `lobbyReduce`
  folding `lobby`/`start`/`abort`/`chat` frames into room state purely (and passing unrelated
  frames through untouched), `gridSlot`'s starting-grid geometry (heading, lateral/vertical
  stagger, behind-not-ahead placement), the relay connecting for the lobby independent of
  Race.state, the proto gate (an old server's `joined` with no/low `proto` keeps the lobby
  hidden with one status note; a proto-2 server turns it on and triggers a `hello`), `pong`
  driving the clock offset and a `start` frame arming the existing `Countdown` module from it
  (including ignoring a duplicate `start` for the same race_id), the two clocks staying
  independent (`Race.elapsed` for the leaderboard, `Race.goElapsed` for a lobby race) and a jump
  start costing the configured penalty with no DQ, and ready flips/host detection/the chat enum/
  spectator gating (no relay `box`, HUD drops to standings+feed).
- Results (proto 4): the `finish`/`dnf` frame builders (the interpolated finishing crossing on the
  lobby clock, a jump start reported, splits dropped when the frame would not fit the relay's 2 KB
  cap while the best sector stays, ids and gates clamped); `resultsReduce` folding progress into
  final frames, ignoring a late or older race's frame, and validating and clamping everything that
  arrives off the socket; the row, headline, waiting-line, record-badge and local-card formatting as
  pure functions; one `finish` per lobby race on the lobby clock while the `/runs` post still
  carries the gate-1 clock; nothing sent by a spectator, a plain Alt+R run, `CONFIG.RESULTS = false`
  or a relay below proto 4 (which gets the local card and one status note instead); the overlay
  never covering a still-racing pilot but appearing the frame they stop, its waiting line ticking
  once per frame and its rows filling in; the final table, cup column and awards; the host's and a guest's buttons, the ghost pick, Next
  race, Rematch and Close, and the picker keeping focus through the lobby's re-render; a `dnf` on a DQ,
  a mid-race reset, a reset before the start and a reset during the countdown (held until the race
  is on, and never sent into a newer race); results cleared by the lobby, a new start or a
  disconnect; the record badge, including one that only shows on the second look; and the lobby's
  cup line and Start cup controls, which survive the lobby frames that rebuild the host's card.

The ghost tests cover, client-side: the pure trace functions (quantization, the 4 Hz/6000-sample
append gates, encode/decode round trip and every malformed-input refusal, interpolation across the
heading wrap, forward-only nearest with a hint, delta sign and sub-sample interpolation, the LRU
index), recording end to end (4 Hz while running, saved only on a personal best, discarded on DQ,
never saved when truncated, a full localStorage evicting then giving up), the ghost renderer (the
picker's options, "My best" replaying off `Race.elapsed`, hidden before the start and parked at the
finish, the model → goldfish → point fallback chain, the pick remembered per course hash, a named
pilot fetched from `/ghost`, and the ghost never being registered as or mistaken for a multiplayer
user while the flicker fix still re-hides real users), the racing line (window length, colour
bands, the Catmull-Rom fallback including a date-line segment, one entity rebuilt at most twice a
second with a callback that returns the same array every frame, Alt+L, and the HUD readout), the
waypoint bracket (shortest-arc turns, bracket/edge/behind-camera placement and side selection, both
`SceneTransforms` spellings plus neither, the caption formats, and the marker following on the very
next frame with transform-only writes), and the minimap (north-up auto-fit, one shared scale,
degenerate and date-line courses, gate states, item box, ghost, other racers from relay positions
and junk being dropped).

The rival-ghost tests (0.12.0, "race a friend's ghost") cover the pure half — `nextOneUpCallsign`
picking the closest faster time (and null with no personal time or nobody faster), the picker's
option ordering (Off / My best / Course record / Next one up / every pilot, the record holder
flagged), the per-rival HUD delta formatter including the zero-delta case, and challenge-link
`?course=&ghost=` parsing/building (capped at `RIVAL_GHOSTS_MAX`, blank entries dropped, a
round trip) — and end to end: each extra slot fetching its own trace from `/ghost` independently
of the primary picker (which stays untouched), its own ghost layer, its own forward-only delta
computation, clearing a pick dropping just that slot, `applyChallenge()` driving the primary pick
and filling the extra slots in order, and `CONFIG.RIVAL_GHOSTS = false` removing the picker, the
news banner and the whole feature's race-bus subscription.

The API tests cover ranking, validation, CORS, and the rate limit, plus the powerups relay:
`roll_item` fairness (expected value strictly increases from leader to last, weights normalize,
the N=1 degenerate case), deterministic sampling against a stubbed RNG, message validation
rejecting junk, a two-client room routing a `fire` to the correct target, the banana hitting
whoever crosses it next, the `boxed` broadcast, oversized frames and rate-limit floods closing
the socket, and disconnect cleanup (empty rooms dropped, populated ones kept). The lobby (proto
2) tests cover host assignment and migration on disconnect, ready gating (refused without a
course, refused until everyone's ready, force start turning stragglers into spectators), a
course or rules change clearing every ready flag, abort returning to the lobby with ready flags
kept and the countdown task actually cancelled, a late joiner landing as a spectator until
`back_to_lobby`, successive starts handing out monotonically increasing race_ids and
server-clock start times, the chat enum rejecting anything off-list, and an old-style client
that never sends `hello`/`ready` still getting standings and items exactly as before.

`GET /ghosts` (0.12.0) is covered for sorting fastest-first and flagging exactly the fastest row as
`is_course_record`, and for a course with no ghosts at all returning `[]` rather than 404. `GET
/news` is covered for reporting a beat only when it lands strictly after `since`, reporting only
the single fastest beat per course (not every run that undercut the old best), sorting newest
first across courses, and answering `[]` for a callsign with no runs at all rather than an error.

The items (proto 3) tests cover: the flight-time clamp and the banana offset as pure functions;
a fired missile telegraphed first and resolving later with one id and one flight time for the
whole room; a shield raised **during** the flight blocking it, and one the relay never saw (or
whose window has passed) blocking nothing; the shield claim capped at `SHIELD_MS`; `fx`
rate-limited to one per two seconds per player and rebroadcast to the sender too; the leader's
fire refunded instead of burned; a banana dropped behind its dropper, arming late and refusing a
`tripped` until it does; a `tripped` claim from 100 km away refused and one inside radius + slack
accepted; a shielded pilot clearing a banana with no hit; the banana list capped oldest-first and
expiring on TTL; a taken box going dark for everyone, refusing a second grab with no grant, and
granting again once relit; a joiner being told about live bananas and dark boxes; `world`
coalesced to at most one every half second and omitting a player who never sent a position; every
new frame's validation; the server-side 2D banana check still firing for a client that omits
`alt` and never firing for one that sends it; and a target that leaves mid-flight resolving as
lost. Plus the retuned odds keeping the leader in the game and last place off the missile hose.

The results (proto 4) tests cover the pure half — the points table, the finish-time window
including the jump-start shift, the best sector derived from the splits, row ordering with the
tie-break, each of the six awards and its skip-when-no-data rule, cup standings, frame
validation, and the largest finish frame fitting the relay's cap — and the relay half: a race
ending when every racer has finished, when a `dnf` or a disconnect takes the last one, and at the
deadline (stragglers out at the last gate they reported); spectators not holding a race open; a
finisher keeping their finish after disconnecting; every finish refusal (no race, wrong race, over,
not a racer, already out, not started, time off the relay's clock — including a jump-start claim
that must not move the window earlier); an exact tie; items, hits, blocks and rank history tallied
from frames the relay already handles and nothing thrown outside a race leaking in; a cup carrying
points across races, ending after its last, and being replaced; rematch and back-to-lobby (which
does not score); a joiner during the results being shown them; an old client that never finishes
not stranding the room; and the SQLite side — a race and its cup round-tripping, a one-off having no
cup, an abandoned cup being closed, the write running off the event loop, a failed write being
logged and swallowed, and the new tables migrating idempotently. The REST tests cover
`/races/recent`, `/cups/{id}` and `/cups` (shapes, ordering, filters, validation, 404), that all of
them are read-only and share the CORS policy, and that `GET /` is one self-contained document with
no external URL, no `innerHTML`, and a policy header.

The terrain tests (`test_check_terrain.py`) are fully offline and cover: the route geometry
(great-circle interpolation, leg spacing, altitude interpolation, chord sag, coincident and
very short legs), the finding levels including a ridge between two clear gates and `--warn-low`,
the CLI's exit codes / JSON output / finding truncation, that the tool never writes
`race/courses/` (hashed before and after), that a missing sample is an error rather than a pass,
the read-through cache fetching only what it lacks and treating a corrupt cache as a miss, and
the quantized-mesh decoder round-tripping synthetic tiles (zigzag deltas, high-water-mark
indices, barycentric height, tile x/y/u/v).

The model tests (`test_models.py`) cover: `build_models.py` produces all six models,
each is a valid glTF binary (`glTF` magic header, parseable, under the 300 KB cap),
and each has a ~15 m bounding-box length along its nose axis.

## Known limits

- **The 1.2.0 hub is server-side only.** `/ws/hub`, identity, the registry, chat, spectating
  and the vote are all implemented and tested on the relay, but no shipped client talks to
  them yet — the panel UI is separate work. Deploying 1.2.0 changes nothing a current client
  can see beyond `joined.proto` becoming 5.
- **The course vote can only offer courses somebody has already raced.** The candidate pool
  comes from the `runs` table because the container ships `app.py` alone — the course JSON is
  fetched by the client from `COURSE_BASE`. A brand-new course is unvotable until it has one
  posted time.
- **Proto-5 detection for chat delivery is conservative.** A client proves it speaks proto 5
  by sending `pilot_token`/`spectate` on its join, or a free-text chat line of its own. A
  proto-5 client that has never visited the hub can therefore be treated as older and not be
  sent free-text chat. It errs toward withholding, never toward sending an old client
  something it would render badly.
- **GeoFS updates can rename internals.** Fixes belong only in the `G` adapter.
- **gorge-run and crater-rim don't clear terrain** as authored (see "Shared course status").
  They need re-flying; `tools/check_terrain.py` says where.
- **Gate visuals** are translucent spheres with a pole and label. If Cesium entities fail, the HUD still works and a console warning explains why.
- **Wall-clock timing:** time spent alt-tabbed counts against you, since it's wall time minus pauses. That only ever penalizes, never helps.
- **Model swaps are mostly probe-confirmed, not fully live-tested** (see "Before trusting this" above). The internals it reads are verified; whether the visual result actually looks right in-game (orientation offsets, cockpit-view hiding) still needs an in-game check.
- **Powerups are entirely live-untested.** Boost writes probe-confirmed speed scalars and
  fails closed on everything else; the `velocity` vector half stays off until its axis frame is
  captured in-sim (see "Writing to the aircraft"). Real control disruption is off by default, so
  offensive hits are screen effects until a probe says otherwise.
- **The relay is ephemeral.** Restarting `race-api` drops every active powerups room — including
  every live banana, dark box and in-flight projectile. Times on the leaderboard are unaffected —
  that's SQLite — but a race in progress falls back to loadout-only until everyone re-crosses the
  start.
- **The visible items layer (0.10.0) is live-untested too, and it is the first thing in this
  project that draws a lot of entities.** The budget (`CONFIG.ITEM_ENTITY_BUDGET`, 40, oldest
  evicted first) and the per-entity TTL are there because a ten-minute race with five pilots
  throwing everything they pick up is exactly the case nobody has flown yet. `ACCEPTANCE.md`
  steps 2.25 and 2.26 (and the A/B under "Not in the run") are the entity-count and frame-rate
  checks that decide whether the budget is right.
- **Placing an effect on another pilot depends on matching a relay callsign to a GeoFS
  multiplayer user**, which is an unverified string compare in the `G` adapter. It fails closed to
  the relay's own twice-a-second `world` frame, so the worst case is effects that step at 2 Hz
  instead of moving smoothly — never effects in the wrong place.
- **Ghost racing is live-untested.** Every pure function and every module boundary is covered by
  `test/run.js` against a mocked Cesium, but nothing here has been flown. The two things most
  likely to be wrong are both in the `G` adapter: `Cesium.SceneTransforms.wgs84ToWindowCoordinates`
  (the waypoint bracket's projection — feature-checked against the renamed API, so a miss means no
  bracket rather than a throw), and whether `Cesium.Model.color` really applies `GHOST_ALPHA` on
  this build (a miss means a solid ghost). See `race/ACCEPTANCE.md` steps 3.2 and 3.9.
- **A ghost is only as good as the trace behind it.** Traces are 4 Hz, so a ghost interpolates
  between samples a quarter-second apart; it is a pace reference, not a frame-accurate replay.
- **Shared results are live-untested.** Everything is covered against a mocked socket and a real
  relay in `test_server.py`, but no two people have finished a race on it yet; `ACCEPTANCE.md`
  Parts 2–4 list what only a real session can settle. The relay checks that a finish time agrees
  with its own clock, not that the flight was honest — a modified client could claim a finish
  without flying the course, which is this project's usual friend-group trust. A pilot who loses
  their connection mid-race is a DNF and comes back as a spectator. The "new course record" badge
  is inferred from the board (the winner tops it with a run posted after GO) rather than reported,
  so a winner whose leaderboard post failed simply gets no badge.

## Reviewing the UI

Every FINSONLY surface shares one theme: the `--fr-*` tokens in `THEME_CSS` near the top of the UI
section of `race.js`, scoped to `.fr-ui` so nothing leaks into GeoFS's own page. Colors, type
sizes (11/12/14/16/20/28/40/72 px, nothing under 12 px in the HUD), spacing, radii and z-layers
all come from there; a test in `test/run.js` fails on a literal z-index, an off-scale font size,
or a color literal outside the theme (the goop/missile/banana art is the listed exception).

`tools/ui_gallery.html` mounts every surface with fixture data so it can be reviewed without
flying: the Ramp, the Gate, Launch, the HUD mid-race with six pilots and all three item slots,
solo and cup results, three toasts and the news card. Open it from disk in Chrome:

- `ui_gallery.html` shows every scene at 1366×768 and 1920×1080 side by side, with a toggle
  for the webfont (`CONFIG.THEME_WEBFONT`).
- `ui_gallery.html?scene=hud` shows one scene at the window's size (`ramp`, `gate`, `launch`,
  `hud`, `results-solo`, `results-cup`, `toasts`, `news`).

It runs the real `race.js` behind stubs for GeoFS, Cesium, Leaflet, `fetch` and `WebSocket`, so it
never touches the network or the relay. Drop a GeoFS screenshot at `tools/gallery_bg.jpg` for a
real terrain background; without one it paints a sky and horizon. `test/run.js` mounts every
scene in jsdom too, so a change that breaks a scene fails the suite.
