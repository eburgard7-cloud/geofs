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
  tools/probe.js          one-shot, read-only GeoFS/Cesium internals report
  server/                 leaderboard API (FastAPI + SQLite) + Caddy/compose snippets
  test/run.js             headless engine tests (mocked GeoFS/Cesium)
  test/test_server.py     API tests
  test/test_models.py     build_models.py output tests (valid glb, size, bounding box)
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
2. Paste the **PRIMARY** line from `bookmarklet.txt` as the URL.
3. Open GeoFS, wait until the plane is on screen, then click the bookmark.

Clicking the bookmark again just re-shows the panel. The primary line always pulls the latest `main`, so there's nothing to update.

## Controls

| Key | Action |
|---|---|
| Alt+R | Reset run (re-arm) |
| Alt+G | Drop a gate at your position (editor) |
| Alt+U | Undo last draft gate |
| Alt+H | Hide/show panel |

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

To try the engine without building anything, **Build test course ahead of me** drops 6 gates in a line along your heading.

### Sharing a course with everyone

1. Save the JSON as `race/courses/<id>.json`.
2. Add it to `race/courses/index.json`:

```json
[
  { "id": "steve-sprint", "name": "Steve Sprint", "file": "steve-sprint.json" }
]
```

3. Push. Friends click **↻** to see it.

Course schema:

```json
{
  "id": "steve-sprint",
  "name": "Steve Sprint",
  "version": 1,
  "aircraftId": null,
  "gates": [ { "lat": 45.58, "lon": -122.6, "alt": 1200, "radius": 150 } ]
}
```

- `alt` is in meters, the same value GeoFS reports in `llaLocation[2]`.
- If gates *look* offset vertically from where they trigger, adjust `ALT_OFFSET_M`. It only moves the visuals.

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
  now handle both.
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

The API has no auth. Any key would ship inside public JS, so a secret is pointless. Protection comes from plausibility checks (split count, monotonic splits, speed-limit floor), a 5-second per-IP rate limit, and the geoblock plus CrowdSec at Caddy. The geoblock also means friends outside the US can't post times.

## Tests

```bash
cd race/test && npm i jsdom@24 && node run.js      # engine + model swap: checks
cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q
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

The API tests cover ranking, validation, CORS, and the rate limit.

The model tests (`test_models.py`) cover: `build_models.py` produces all six models,
each is a valid glTF binary (`glTF` magic header, parseable, under the 300 KB cap),
and each has a ~15 m bounding-box length along its nose axis.

## Known limits

- **GeoFS updates can rename internals.** Fixes belong only in the `G` adapter.
- **Gate visuals** are translucent spheres with a pole and label. If Cesium entities fail, the HUD still works and a console warning explains why.
- **Wall-clock timing:** time spent alt-tabbed counts against you, since it's wall time minus pauses. That only ever penalizes, never helps.
- **Model swaps are mostly probe-confirmed, not fully live-tested** (see "Before trusting this" above). The internals it reads are verified; whether the visual result actually looks right in-game (orientation offsets, cockpit-view hiding) still needs an in-game check.
