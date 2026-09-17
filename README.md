# FINSONLY

*A custom multiplayer air-racing mode built on top of GeoFS — FINSONLY liveries, joke planes, timed gate courses, a live leaderboard, and Mario-Kart-style powerups.*

## What is this

This repo is two things layered on top of each other. At the root, it's a set of custom liveries for Finsonly Air — a joke airline flying a Boeing 757, an F-16, and a Rafale M — read by [GEOFS-LiverySelector](https://github.com/kolos26/GEOFS-LiverySelector) via [airline.json](airline.json). Inside [race/](race/), it's FINSONLY Racing: a full checkpoint-racing mode bolted onto the same sim — gates, a timer, splits, a shared leaderboard, joke-plane model swaps, and Mario-Kart-style powerups — all loaded with a single bookmarklet, no build step, no browser extension.

This is an unofficial hobby project for a friend group, built on top of the free browser flight sim [GeoFS](https://www.geo-fs.com) — it isn't affiliated with or endorsed by GeoFS.

## Screenshots

- **A livery in GeoFS** — *TODO: screenshot of one of the FINSONLY liveries (e.g. the F-16 "Steve's Revenge" or the B757 "Brathaus") loaded on the aircraft.*
- **The race panel / HUD** — *TODO: screenshot of the FINSONLY Racing panel mid-run — timer, splits, powerups.*
- **A course on the nav map** — *TODO: screenshot of a loaded course's numbered gates and route line drawn on GeoFS's own Leaflet nav map.*
- **The leaderboard** — *TODO: screenshot of the leaderboard panel showing best times for a course.*

## For players — race with us

**Why a bookmarklet?** Tampermonkey (and browser extensions generally) are blocked on the machine this is meant to run on, so there's no extension to install. Instead the whole client is one JS file that gets fetched and injected into the page by a tiny bookmarklet — click a bookmark, get the racing UI.

**Install it:**

1. Open [race/bookmarklet.txt](race/bookmarklet.txt).
2. Create a new browser bookmark named "FINSONLY Racing" and paste the **COMBINED** line in as the URL. It loads both FINSONLY Racing and [GEOFS-LiverySelector](https://github.com/kolos26/GEOFS-LiverySelector) with one click, so you get the custom liveries too. If you don't care about liveries, the **PRIMARY** line alone works.
3. Go to [geo-fs.com](https://www.geo-fs.com), let your plane load, then click the bookmark.

If that fails with a fetch/CSP-looking error, the page's security policy is blocking the direct fetch — use the **FALLBACK** or **COMBINED FALLBACK** line instead, which loads the same code from jsDelivr's CDN. Clicking the bookmark again just re-opens the panel if it's already loaded.

**Pick a livery, pick a plane:** with LiverySelector loaded, press `l` to open its panel and choose one of the FINSONLY skins (F-16, B757, or Rafale). Racing itself always uses real F-16 physics — the "joke planes" (goldfish, bratwurst, traffic cone, toilet, parcel box, cow) are purely cosmetic. Open **Your plane** in the race panel to fly around looking like one instead; everyone else in the room sees it too.

**Join a course:** the race panel lists the shared courses fetched from this repo — pick one and it arms, click **↻** if you don't see a course a friend just added. Picking a course also drops you into that course's powerups room automatically, so everyone racing the same course shares one room with no separate lobby to join. Want to group with specific friends instead? Type a matching **Room** code in the Powerups panel to override the default.

**Fly it:** the timer starts the moment you leave the start gate, hit every gate in order, cross the finish. `Alt+R` resets and re-arms a run, `Alt+H` hides/shows the panel. Bail out and retry as many times as you want — only your best time is kept. Before you launch, pick your two loadout items in **Powerups** and fire them with `Alt+1` / `Alt+2`; if the course has an item box, flying through it rolls you a third item you fire with `Alt+3` (see below for what everything does).

## Powerups

| Item | Where from | Type | Effect |
|---|---|---|---|
| Speed Boost | Loadout or box | Self | Temporary speed increase on your own aircraft |
| Shield | Loadout | Defensive | Blocks incoming offensive items for its duration |
| Banana | Box only | Offensive | Drops where you are; hits whoever flies through it next |
| Mustard Missile | Box only | Offensive | Hits the nearest racer ahead of you |
| Goop | Box only | Offensive | Hits the nearest racer ahead of you — screen gets "grilled" |

The box is a catch-up mechanic: the item you get is weighted by your live race position, so the further back you are the better your odds of a missile or goop, while the leader mostly gets a banana or nothing. Right now every offensive hit (banana, missile, goop) is **visual only** — a brief tint, wobble, or view-obscuring overlay on the victim's own screen. None of them can knock you off course, stall the plane, or trip the speed-limit disqualification.

Powerups need the leaderboard server to be reachable for the box and offensive items to work at all. If it's unreachable or your connection drops, your loadout (Boost/Shield) keeps working exactly the same, but the box and offensive items just turn off and the panel says so.

## Courses

| Course | Difficulty | Notes |
|---|---|---|
| Starter Sprint (Sea-Tac test course) | Test course | Ground start near Sea-Tac; the only course with an item box so far |
| Columbia Gorge Run | Easy | Air start |
| Crater Lake Rim | Medium | Air start |
| Mt. Hood Circuit | Tight | Air start |

Columbia Gorge Run, Crater Lake Rim, and Mt. Hood Circuit are new and hand-placed from coordinates rather than flown end-to-end yet — if a gate looks buried in terrain or oddly placed, say something.

---

*Everything below this line is about running or hacking on FINSONLY Racing itself — not what you need to go race.*

## Architecture

FINSONLY Racing has two halves. The client is [race/race.js](race/race.js) — a single self-contained file with no build step and no dependencies, injected into the GeoFS page by the bookmarklet; it reads and writes GeoFS/Cesium internals only through a small `G` adapter, so a GeoFS update only ever needs a fix in one place. It fetches static content — courses, joke-plane models, callsign assignments — as plain JSON from `main` on GitHub (or a pinned jsDelivr tag via the FALLBACK bookmarklet). For anything shared between players — the leaderboard and the powerups relay — it talks over HTTPS/WSS to a small FastAPI + SQLite server ([race/server/app.py](race/server/app.py)) that runs behind Caddy at `race.finsonly.net`. The server has no auth (any key would just ship inside public JS anyway); instead it leans on plausibility checks, a per-IP rate limit, and Caddy-level geoblocking/CrowdSec.

```
Browser (geo-fs.com)
  bookmarklet
    └─ race.js  (single file, injected — reads/writes GeoFS+Cesium via the `G` adapter)
         ├─ fetches courses/models JSON from GitHub (main, or a pinned tag)
         └─ HTTPS/WSS ──▶  Caddy (race.finsonly.net)
                              └─ race-api (FastAPI, Docker)
                                   ├─ SQLite /data/race.db  — leaderboard (/runs, /leaderboard, /courses)
                                   └─ in-memory rooms       — powerups relay (WS /ws/race/{room})
```

## Repo layout

- [CLAUDE.md](CLAUDE.md) — conventions for this repo used by AI coding assistance.
- [airline.json](airline.json) — the Finsonly Air livery manifest read by GEOFS-LiverySelector.
- Root-level `*.png` / `*.webp` files — livery textures for the B757 and F-16, referenced from `airline.json`.
- [rafale/](rafale/) — the Rafale M livery source art (chrome/vaporwave) and its test textures.
- [tools/](tools/) — `build_spec.py`, a helper that builds the Rafale's specular/metallic map from a paint mask.
- [race/](race/) — the racing mode; see [race/README.md](race/README.md) for the full detail:
  - `race.js` — the entire client, one file.
  - `bookmarklet.txt` — the bookmarklet lines (PRIMARY, COMBINED, FALLBACK, COMBINED FALLBACK, PROBE).
  - `courses/` — shared course JSON files plus `index.json`.
  - `models/` — joke-plane `.glb` models, `index.json`, and `assignments.json` (callsign → model).
  - `server/` — the FastAPI leaderboard/relay (`app.py`), `Dockerfile`, Compose/Caddy snippets, and `DEPLOY_CHECKLIST.md`.
  - `test/` — `run.js` (headless engine tests) and the three pytest suites.
  - `tools/` — `probe.js` (read-only GeoFS/Cesium probe), `add_course.py`, `build_models.py`.

## Running the server

The full, step-by-step sequence — exact Compose/Caddy blocks, every verification command, the WebSocket smoke test — lives in [race/server/DEPLOY_CHECKLIST.md](race/server/DEPLOY_CHECKLIST.md); this is just the shape of it, on an Unraid box:

1. Copy `app.py`, `requirements.txt`, and `Dockerfile` to the box, and create a data directory owned `99:100` (the container's `nobody:users`).
2. Merge [race/server/compose.snippet.yml](race/server/compose.snippet.yml) into the stack's compose file — it joins the existing external `proxy` network that Caddy fronts.
3. Add [race/server/Caddyfile.snippet](race/server/Caddyfile.snippet) as its own block, copying the same geoblock/CrowdSec directives already used elsewhere in the stack. No Authelia here — the browser calls this API cross-origin from geo-fs.com and can't follow an Authelia login redirect. The same block also fronts the powerups relay's WebSocket upgrade at `/ws/race/{room}`; Caddy 2 proxies WS upgrades automatically, so nothing extra is needed for it.
4. `docker compose up -d --build race-api`, then confirm `https://race.finsonly.net/health` returns `{"ok":true}`.

Two things matter more than they look: the `-v /mnt/user/appdata/race-api:/data` volume mount, and `RACE_DB` (baked into the image as `/data/race.db`, overridable with `-e RACE_DB=...`). SQLite writes to whatever `RACE_DB` points at, and the volume mount is what makes that path survive a container rebuild or restart instead of vanishing with the rest of the container's writable layer — skip the mount and every run ever recorded disappears the next time the container is rebuilt. `requirements.txt` also pins `uvicorn[standard]`, not plain `uvicorn`, because the `[standard]` extra is what actually brings WebSocket support — without it, the powerups relay at `/ws/race/{room}` can't run at all.

## Development

Run all four test suites before committing anything — the project convention is to never commit with a failing suite:

```bash
cd race/test && npm i jsdom@24 && node run.js                                            # engine + model swap + powerups client
cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q   # leaderboard + relay API
cd race/test && python -m pytest test_add_course.py -q                                   # course validation/import
cd race/test && pip install pygltflib numpy pytest && python -m pytest test_models.py -q # generated joke-plane models
```

Because the GeoFS/Cesium internals in the `G` adapter are guesses until someone checks them against the live site, there's a separate, read-only verification loop: load the **PROBE** line from `race/bookmarklet.txt` (or paste it straight into DevTools) on geo-fs.com after the plane has loaded. It only reads properties — it never writes anything — and copies a JSON report to the clipboard (or logs it if the clipboard is blocked); paste that report back so any `TODO-PROBE` guess in `race.js` can be corrected or confirmed against what the live site actually exposes. See [race/tools/probe.js](race/tools/probe.js) and `race/README.md`'s "Model swaps" and "Before trusting this" sections for the current state of what's confirmed vs. guessed.

Releases: bump `CONFIG.VERSION` in `race.js` on any user-visible change, then cut a tag:

```bash
git tag -a race-vX.Y.Z -m "FINSONLY Racing vX.Y.Z" && git push origin race-vX.Y.Z
```

The **FALLBACK** and **COMBINED FALLBACK** bookmarklet lines pin a jsDelivr `@race-vX.Y.Z` tag rather than tracking `main` (the current pin is `race-v0.5.0`), so a release also means repointing those two lines in `race/bookmarklet.txt` to the new tag. `race/test/run.js` fails the suite if the pinned tag doesn't actually exist in the repo — that's how a stale, never-cut pin went unnoticed for a while.

## Config

The flags at the top of [race/race.js](race/race.js) that control client behavior:

| Key | Default | Meaning |
|---|---|---|
| `VERSION` | `'0.6.0'` | Client version string shown in the panel; bump on user-visible changes |
| `COURSE_BASE` | raw.githubusercontent `.../race/courses/` | Where `courses/index.json` and course files are fetched from |
| `MODEL_BASE` | raw.githubusercontent `.../race/models/` | Where joke-plane models, `index.json`, and assignments are fetched from |
| `API_BASE` | `''` | Leaderboard/relay server URL; empty disables the leaderboard, the item box, and offensive items entirely |
| `DEFAULT_RADIUS_M` | `150` | Default gate radius in the course editor |
| `MAX_SPEED_MS` | `700` | Speed between samples (~1360 kt) that triggers a teleport/slew disqualification |
| `PAUSE_MOVE_TOLERANCE_M` | `50` | How far you can drift while paused before it's a disqualification |
| `ALT_OFFSET_M` | `0` | Visual-only vertical nudge for how gates render |
| `COURSE_MAP` | `true` | Draw the loaded course's gates/route on GeoFS's Leaflet nav map |
| `COUNTDOWN_LEAD_S` | `10` | Default lead time for a host-armed countdown |
| `TEST_SPACING_M` | `2000` | Gate spacing used by "Build test course ahead of me" |
| `TEST_COUNT` | `6` | Number of gates the test-course builder drops |
| `HUD_HZ` | `10` | HUD refresh rate |
| `READY_TIMEOUT_MS` | `180000` | How long a host-armed countdown waits before giving up |
| `POWERUPS` | `true` | Master switch for the whole Powerups module (loadout + relay box/offensive items) |
| `POWERUP_BOOST_MS` | `4000` | Boost effect duration |
| `POWERUP_BOOST_ADD_MS` | `35` | Extra ground speed (m/s) while boosted |
| `POWERUP_SHIELD_MS` | `6000` | Shield effect duration |
| `POWERUP_BANANA_MS` | `2500` | Incoming-banana effect duration |
| `POWERUP_MISSILE_MS` | `3000` | Incoming-missile effect duration |
| `POWERUP_GOOP_MS` | `4000` | Incoming-goop effect duration |
| `POWERUP_POS_HZ` | `2` | How often the client pings the relay with position/progress while racing |
| `POWERUP_RECONNECT_MS` | `2000` | Relay reconnect backoff base (doubles per attempt) |
| `POWERUP_RECONNECT_MAX_MS` | `30000` | Cap on the reconnect backoff |
| `POWERUP_ROOM` | `''` | Fixed relay room code; empty means derive one from the course hash |
| `POWERUP_CONTROL_EFFECTS` | `false` | Real control disruption on a hit; off means offensive items stay screen-effect-only |
| `SAFE_WRITES` | `true` | Only write GeoFS fields the probe has confirmed safe; `false` allows a riskier in-sim escape hatch |
| `VELOCITY_FRAME` | `null` | Recorded shape/axis of `geofs.aircraft.instance.velocity`; `null` means no vector writes happen at all |
| `SPEED_WRITE_MARGIN_MS` | `50` | Safety margin every speed write stays under `MAX_SPEED_MS` |
| `BOOST_LLA_FALLBACK` | `false` | Opt-in fallback: move the aircraft via `llaLocation` instead of the confirmed scalar writes |

## License

No LICENSE file yet — this is a personal/friends project, so treat it as all-rights-reserved unless that changes.
