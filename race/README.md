# FINSONLY Racing

A checkpoint racing layer for GeoFS: gates, timer, splits, personal bests, a course editor, and an optional shared leaderboard. It's a single JS file loaded by a bookmarklet, so no extension is needed.

```
race/
  race.js                 the whole client
  bookmarklet.txt         what friends paste into a bookmark
  courses/index.json      shared course list (fetched by the client)
  courses/*.json          shared courses
  server/                 leaderboard API (FastAPI + SQLite) + Caddy/compose snippets
  test/run.js             headless engine tests (mocked GeoFS/Cesium)
  test/test_server.py     API tests
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

The future model-swap script only needs to set `window.__finsModel = 'bratwurst'` (or whichever model). Finished runs send that value, and the leaderboard shows it next to the name.

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
cd race/test && npm i jsdom@24 && node run.js      # engine: 30 checks
cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q
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

The API tests cover ranking, validation, CORS, and the rate limit.

## Known limits

- **GeoFS updates can rename internals.** Fixes belong only in the `G` adapter.
- **Gate visuals** are translucent spheres with a pole and label. If Cesium entities fail, the HUD still works and a console warning explains why.
- **Wall-clock timing:** time spent alt-tabbed counts against you, since it's wall time minus pauses. That only ever penalizes, never helps.
