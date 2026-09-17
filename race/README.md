# FINSONLY Racing

A checkpoint racing layer for GeoFS: gates, timer, splits, personal bests, a course editor, and an optional shared leaderboard. It's a single JS file loaded by a bookmarklet, so no extension is needed.

```
race/
  race.js                 the whole client
  bookmarklet.txt         what friends paste into a bookmark
  courses/index.json      shared course list (fetched by the client)
  courses/*.json          shared courses
  models/index.json       joke-plane model list (id, file, scale, rotation offsets)
  models/*.glb            procedurally generated joke-plane models
  models/assignments.json callsign -> model id, fetched by the client
  tools/build_models.py   generates models/*.glb + models/index.json
  tools/add_course.py     validates a pasted course JSON, writes/upserts courses/
  tools/check_terrain.py  samples terrain along a course route, flags gates/legs below it
  tools/probe.js          one-shot, read-only GeoFS/Cesium internals report
  server/                 leaderboard API (FastAPI + SQLite) + Caddy/compose snippets
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

1. Create a new bookmark named `FINSONLY Racing`.
2. Paste the **COMBINED** line from `bookmarklet.txt` as the URL — it loads both this and [GEOFS-LiverySelector](https://github.com/kolos26/GEOFS-LiverySelector) in one click, so you don't need two separate pastes/bookmarks each session. If you don't use custom liveries, the plain **PRIMARY** line works too.
3. Open GeoFS, wait until the plane is on screen, then click the bookmark.

Clicking the bookmark again just re-shows the race panel. LiverySelector has its own `l` key to toggle its panel, independent of this. The primary/combined lines always pull the latest `main` of both scripts, so there's nothing to update.

**Not yet live-tested:** the COMBINED loader hasn't been run against a real GeoFS + LiverySelector session — it's built from the same fetch-and-inject pattern this repo's own loader already uses (see PRIMARY above), applied identically to LiverySelector's `main.js`, which is a self-contained IIFE with no dependency on `race.js` or vice versa. No DOM ID or keybinding overlap found on read-through (LiverySelector owns `#listDiv`/`.geofs-ui-left`/`.geofs-ui-bottom`; this owns its own `fr-`-prefixed panel). If it misbehaves, load them separately as before and report back what broke.

The FALLBACK and COMBINED FALLBACK lines pin a jsDelivr `@race-vX.Y.Z` tag rather than tracking `main`, so unlike PRIMARY/COMBINED they need that tag moved (or a new tag cut and the lines' version bumped) on every release before a friend relying on the fallback actually gets the update. The current pin is `race-v0.5.0`, an annotated tag; `test/run.js` now fails if a pinned tag doesn't exist in the repo, which is how the stale `race-v0.2.3` pin (a tag that was never cut) went unnoticed through v0.5.0. It prints a note, not a failure, when the pin merely lags `CONFIG.VERSION` — that's the normal state between releases. Cutting a release is therefore:

```bash
# after bumping CONFIG.VERSION and repointing the FALLBACK lines in bookmarklet.txt
git tag -a race-v0.5.0 -m "FINSONLY Racing v0.5.0" && git push origin race-v0.5.0
```

## Controls

| Key | Action |
|---|---|
| Alt+R | Reset run (re-arm) |
| Alt+G | Drop a gate at your position (editor) |
| Alt+U | Undo last draft gate |
| Alt+H | Hide/show panel |
| Alt+1 / Alt+2 | Use loadout slot 1 / 2 (see "Powerups") |
| Alt+3 | Use the item you got from the item box |

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
  "itemBox": { "lat": 45.57, "lon": -122.61, "alt": 1200, "radius": 120 },
  "gates": [ { "lat": 45.58, "lon": -122.6, "alt": 1200, "radius": 150 } ]
}
```

- `alt` is in meters, the same value GeoFS reports in `llaLocation[2]`.
- If gates *look* offset vertically from where they trigger, adjust `ALT_OFFSET_M`. It only moves the visuals.
- `startType` is `"ground"` (default, omit it if the course starts on a runway) or `"air"` for
  a course whose first gate is mid-air with no natural spawn point nearby — see "Racing an
  air-start course" below.
- `itemBox` is optional: at most one per course, and it's the contested powerup pickup (see
  "Powerups"). It is **not** a gate — it never counts for progress, never adds a split, and is
  deliberately excluded from the course hash, so adding or moving a box never resets a
  leaderboard. Put it slightly off the fastest line if you want taking it to cost something.

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

### Shared course status

`Course.normalize()` whitelists exactly `id`/`name`/`version`/`aircraftId`/`startType`/`gates` —
any other field (e.g. a `note`) is silently dropped by the client and by `add_course.py` on
their next save, so status notes for shared courses live here instead:

- **starter-sprint-seatac** (Starter Sprint) — carries the project's only `itemBox` so far,
  placed midway between gates 3 and 4, right on the route line to keep it easy to exercise
  while testing. Deliberately not retrofitted onto the other courses; see "Powerups".
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

**2. The contested item box (needs the relay).** A course can carry one `itemBox` (see the
course schema above). Fly through it and the relay rolls you an item, which lands in a third
slot you fire with **Alt+3**. The box triggers once per run and only while the clock is
running, so you can't farm it on the taxiway.

### Why the box is a catch-up mechanic

The **relay decides what you get, and the roll is weighted by your live race position** — the
further back you are, the better the odds. That's the whole point: the box helps whoever is
losing, instead of snowballing the leader. The weights interpolate smoothly between three
anchor tables (`weights_for_rank()` in `race/server/app.py`), so there's no cliff between
"midfield" and "last":

| Your position | nothing | banana | goop | boost | missile |
|---|---|---|---|---|---|
| Leader | 45 | 45 | 8 | 2 | 0 |
| Midfield | 5 | 20 | 25 | 35 | 15 |
| Last place | 0 | 5 | 10 | 35 | 50 |

So the leader mostly gets a banana to drop behind them (or nothing at all), and last place is
the only one with a real shot at the missile. A solo racer counts as the leader — there's
nobody to catch up to.

### The items

| Item | From | Does |
|---|---|---|
| Speed Boost | loadout or box | Temporary speed increase on your own aircraft |
| Shield | loadout | Blocks incoming offensive items for its duration |
| Banana | box only | Dropped where you are; hits whoever flies through it next — brief wobble + tint |
| Mustard missile | box only | Hits the nearest player *ahead* of you — short control loss + screen tint |
| Goop | box only | Hits the nearest player ahead — you get GRILLED: a few seconds of view-obscuring overlay |

Offensive items are **relay-only and relay-adjudicated**: your client can say "I crossed the
box" and "I fired what you gave me," but it can't pick its own item or choose who it hits. The
relay rolls, the relay targets, and it refuses a `fire` for an item it never granted you.
Effects are always applied by the *victim's* client to itself, time-boxed to a few seconds, and
they auto-recover — nothing here can stall you, force a dive, or trip the teleport DQ. Shield
is honored on receipt by the victim's own client (the relay deliberately doesn't track
shields), and everything lands in a kill feed in the panel.

### Without the relay

If `CONFIG.API_BASE` is empty, or the relay is down, or your connection drops, powerups fall
back to **loadout-only mode**: Boost and Shield keep working exactly as above, the box and all
offensive items are disabled, and the panel says so. The client reconnects with an exponential
backoff while a race is running, and a permanently dead relay just means loadout-only forever —
it can never break the race itself. The room defaults to the course hash, so everyone racing
the same course lands in the same room automatically; type a **Room** code to override that.

### Before trusting this

**Live-untested — none of this has been flown yet.** Two specific things to watch:

- **Boost now writes probe-confirmed fields, but only half of them so far.** It sets
  `trueAirSpeed`/`groundSpeed` (confirmed writable numbers) and leaves the `velocity` vector
  alone until its axis frame has been recorded from a real in-sim sample. See **Writing to the
  aircraft** below for what that means and how to finish it; the old `llaLocation` nudge is
  still in the file, now behind `CONFIG.BOOST_LLA_FALLBACK` (off). Every speed Boost writes is
  clamped under `CONFIG.MAX_SPEED_MS`, so it can't trip the teleport/slew DQ on any path.
- **Real control disruption is off by default.** `CONFIG.POWERUP_CONTROL_EFFECTS` is `false`
  because nothing in `race/tools/probe.js` has ever captured GeoFS's control inputs, and
  guessing at a writable control surface is exactly how you get a stall instead of a wobble. As
  shipped, banana/missile/goop are **screen effects only** — still disorienting, zero risk. The
  probe now has a `controls` section: run it (see "Model swaps → Before trusting this" for how)
  and paste the report back to decide whether a real, safe control hook exists.

Everything is behind `CONFIG.POWERUPS` (default `true`) at the top of `race.js`. Turning it off
means the module never subscribes to the race event bus, renders no UI, and binds no keys — not
just that it no-ops.

## Fly to start

On an air-start course, gate 1 hangs in the air miles from any runway, so everyone used to take
off, climb, and converge on it by eye. **Fly to start** (the button under the course row, enabled
only on `"startType": "air"` courses) puts you on gate 1, pointed at gate 2, already flying:

- position = gate 1's lat/lon/alt
- heading = the bearing from gate 1 to gate 2, written to `htr[0]`
- speed = `CONFIG.FLY_TO_START_SPEED_MS` (150 m/s), through the same write path Boost uses

It re-arms the run first, and the reposition is a teleport, which Race's start detector already
ignores (`detectStart`'s `jumped` guard) — so it can neither start your clock nor DQ you. Leaving
gate 1's sphere afterwards starts the clock normally, exactly as if you'd flown there.

**Two reposition paths, and `geofs.resetFlight()` is the primary one.** It goes through GeoFS's
own reset code rather than around it, so the aircraft's internal state stays self-consistent —
inconsistent state is precisely the stall risk that raw writes carry. Since its signature is
unverified, it's checked both before and after:

1. `geofs.resetFlight` must be a function, and there must already be a coordinate array
   (`geofs.lastFlightCoordinates` / `geofs.initialCoordinates`) to point at gate 1. That array is
   edited the way the velocity vector is — copy what GeoFS produced, replace only
   `[lat, lon, alt, heading]`, keep everything else.
2. After the call, position is verified: within `CONFIG.FLY_TO_START_TOLERANCE_M` (250 m) of gate
   1 horizontally **and** in altitude. Altitude is checked separately on purpose — landing at
   gate 1's lat/lon but on the ground would pass a 3D distance check and mean spawning on
   terrain at flying speed.
3. Anything short of that — no `resetFlight`, no array, a throw, or a landing somewhere else —
   falls through to the raw state writes (`llaLocation` mutated in place) in the same click.

The panel reports which path ran, so the first in-sim click answers the question: `On gate 1 via
resetFlight, heading 108°, airspeed set to 150 m/s, velocity set.`

One side effect of the primary path: it leaves GeoFS's own reset pointing at gate 1 until your
next flight overwrites those coordinates.

**Still gated:** the velocity vector half needs `CONFIG.VELOCITY_FRAME` (next section). Without
it, fly-to-start sets the confirmed airspeed scalars and says `velocity not set (no frame
recorded — you may need to power up)`; you'll arrive at gate 1 with the throttle where you left
it rather than genuinely flying, which on a cold spawn can mean a moment of sink.

## Writing to the aircraft

Boost and fly-to-start are the only two features that *write* to GeoFS rather than read it, and
they share one write path. A probe run confirmed three writable fields on
`geofs.aircraft.instance`:

| Field | Type | Confirmed | Used for |
|---|---|---|---|
| `trueAirSpeed` | number | writable | Boost, fly-to-start |
| `groundSpeed` | number | writable | Boost, fly-to-start |
| `velocity` | **vector object**, not a scalar | writable; **axis frame unknown** | gated — see below |
| `llaLocation` | `[lat, lon, alt]` array | unconfirmed | last-resort fallback only |

A number can't be malformed. A velocity vector can, and a malformed one stalls the plane — which
is why `CONFIG.SAFE_WRITES` (default `true`) draws the line there:

- **Stage 1, what ships today.** Boost writes the two scalars and does **not** touch the vector.
  Instead, the first time you boost in stable level cruise it `console.log`s the live
  `velocity` object, its shape, its numbers, and the heading/attitude/airspeed they were taken
  at. The panel says `Boost: airspeed only — velocity frame not captured yet.`
- **Stage 2, once you've pasted the frame in.** Boost also pushes the vector forward, clamped
  under `MAX_SPEED_MS`, and fly-to-start can set a flying velocity from the recorded reference
  sample.

The rule the code keeps either way: **a velocity vector is only ever derived from one GeoFS
itself produced** — scaled, or pushed along an axis the observation identifies. Nothing
synthesizes a direction. `velocityBoosted()` / `velocityFromReference()` return `null` rather
than guess, and `writeVelocity()` refuses unless the recorded frame still matches the live
object's shape, so a GeoFS update that reshapes `velocity` turns the vector write *off* instead
of corrupting it.

### Capturing the velocity frame

1. Take off, get to level cruise on about **090**, and hold it — wings level, no climb, above
   60 m/s, unpaused, for at least a second. (`CruiseWatch` enforces that: a sample taken
   mid-turn or mid-climb can't tell a body-fixed frame from an earth-fixed one, and that's the
   whole question.)
2. Open **Powerups → Log velocity frame** (or press Alt+1 with a Boost loaded, or run
   `__finsRace.logVelocityFrame()` in the console). The panel confirms `Logged velocity sample
   1/4`. Capped at 4 samples per page load.
3. Turn to about **180**, settle again, and log a second sample.
4. Compare the two in the console:
   - The three numbers **stayed put** as the heading changed → the frame is **body-fixed**. Set
     `bodyFixed: true` and set `fwd` to whichever component tracks airspeed.
   - They **swapped around** with heading → it's **earth-fixed**. Set `bodyFixed: false` and
     `fwd: null`; Boost then scales the observed vector (direction exactly as flown) and
     fly-to-start skips the vector write rather than flinging you off the course line.
5. Write it into `CONFIG.VELOCITY_FRAME` at the top of `race.js`, e.g.

   ```js
   VELOCITY_FRAME: { kind: 'object', comps: ['x', 'y', 'z'], fwd: 'x', bodyFixed: true,
                     ref: [182.4, 0.6, -1.1], refSpeedMs: 182.4, note: 'hdg 090, level, 2026-09-17' },
   ```

   `ref` is the observed sample itself — that's what fly-to-start rescales. The capture button
   disappears once the frame is set.

`CONFIG.SAFE_WRITES = false` is the in-sim escape hatch: it lets Boost scale the live vector
with no frame recorded. It still never synthesizes one. And `CONFIG.BOOST_LLA_FALLBACK = true`
brings back the 0.5.0 behavior (move the aircraft by mutating `llaLocation`) *alongside* the
confirmed writes — turn it on if the scalar writes turn out to be readouts GeoFS overwrites,
since a write can succeed and still do nothing. Its per-frame distance is limited to the
headroom left under the speed cap, so stacking it on a working scalar write still can't DQ you.

## Leaderboard server (homelab)

1. **DNS:** add `race.finsonly.net` as an A record pointing to your public IP, DNS-only (grey cloud) like the other subdomains.
2. **Files:** create the directories and copy the server code over.
   ```bash
   mkdir -p /mnt/user/appdata/stack/race-api /mnt/user/appdata/race-api
   cp race/server/{app.py,requirements.txt,Dockerfile} /mnt/user/appdata/stack/race-api/
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

Endpoints:

| Endpoint | Returns |
|---|---|
| `POST /runs` | `{ id, rank, personal_best, improved }` |
| `GET /leaderboard?course_hash=abcd1234&limit=10` | Best time per callsign |
| `GET /courses` | Courses with times, record, and racer count |
| `GET /health` | Health check |
| `WS /ws/race/{room}` | Powerups relay (see below) |

The API has no auth. Any key would ship inside public JS, so a secret is pointless. Protection comes from plausibility checks (split count, monotonic splits, speed-limit floor), a 5-second per-IP rate limit, and the geoblock plus CrowdSec at Caddy. The geoblock also means friends outside the US can't post times.

### Powerups relay

The same container also serves the powerups relay on `WS /ws/race/{room}` (see "Powerups"). It
is **ephemeral and in-memory**: no DB writes, no schema, no migration. A room is one race
session and disappears when its last socket disconnects or when the container restarts —
dropping active rooms on a restart is fine and expected, since a dropped relay just means
loadout-only mode for whoever was racing.

Messages are small JSON objects, validated with Pydantic like `RunIn`, size-capped at 2 KB and
rate-limited per connection (20/s by default, `RACE_WS_RATE_PER_S`); a sustained flood closes
the socket. Room names must match `^[a-z0-9-]{1,32}$`.

Client → relay:

| Message | Meaning |
|---|---|
| `{type:"join", callsign, room}` | Join a room. Must be the first message; the `room` must match the URL. |
| `{type:"pos", lat, lon, gate, elapsed_ms}` | Position/progress ping (~2/s while racing). This is what the relay ranks players by. |
| `{type:"box"}` | "I crossed the item box." The relay rolls the item. |
| `{type:"fire", item}` | "I used the offensive item you gave me." Rejected unless it matches what was granted. |

Relay → client:

| Message | Meaning |
|---|---|
| `{type:"joined", room}` | Join accepted. |
| `{type:"grant", item}` | Your box roll, to you only. `item` may be `"nothing"`. |
| `{type:"hit", item, from}` | You were hit, to you only. Your client applies it to itself (and honors Shield). |
| `{type:"boxed", callsign, item}` | Someone else picked up an item — drives the kill feed. |
| `{type:"standings", order}` | Room ranking, leader first. |
| `{type:"error", detail}` | Rejected message; the connection stays open. |

The relay never trusts a client's self-reported rank — it computes ranking from `pos` pings
(most gates passed, then whoever got there soonest) and owns both the roll and the targeting.

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
  refusing a reshaped object, forward-axis vs. uniform-scale derivation, every refusal case),
  `CruiseWatch` calling only real level cruise stable, Boost stage 1 writing scalars and leaving
  the vector untouched while logging a capture sample, Boost stage 2 pushing the observed
  vector, a held boost holding one target instead of compounding per frame, measured peak speed
  staying under `MAX_SPEED_MS` from five starting speeds with the `llaLocation` fallback stacked
  on top, and that fallback still working behind its flag
- Fly to start: `resetFlight` used when it exists and lands on gate 1; rejected and fallen back
  from when it lands somewhere else, or at ground level, or isn't there at all; heading written
  as the gate 1 to gate 2 bearing; the velocity half gated on a recorded body-fixed frame and
  refused for an earth-fixed one; no start and no DQ from the reposition, with the clock still
  starting normally on the way out of gate 1; and refusals (no course, ground course) that
  explain themselves and never move the aircraft
- Powerups: loadout persistence, Boost staying under `MAX_SPEED_MS` and auto-recovering,
  Shield set/clear, `itemBox` normalization (including being excluded from the course hash),
  the box rendering/clearing without leaking entities, the box not triggering while armed and
  never adding a split, relay URL/room derivation, a grant filling the box slot, a fire being
  sent as exactly the granted item, an incoming hit applying a time-boxed screen effect that
  clears itself, Shield blocking a hit, junk off the socket being ignored, relay-down →
  loadout-only with no throw, reconnect-with-backoff after a mid-race drop, and
  `CONFIG.POWERUPS = false` disabling the module entirely

The API tests cover ranking, validation, CORS, and the rate limit, plus the powerups relay:
`roll_item` fairness (expected value strictly increases from leader to last, weights normalize,
the N=1 degenerate case), deterministic sampling against a stubbed RNG, message validation
rejecting junk, a two-client room routing a `fire` to the correct target, the banana hitting
whoever crosses it next, the `boxed` broadcast, oversized frames and rate-limit floods closing
the socket, and disconnect cleanup (empty rooms dropped, populated ones kept).

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
- **The relay is ephemeral.** Restarting `race-api` drops every active powerups room. Times on
  the leaderboard are unaffected — that's SQLite — but a race in progress falls back to
  loadout-only until everyone re-crosses the start.
