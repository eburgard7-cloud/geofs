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

### Install (once)

1. Open [race/bookmarklet.txt](race/bookmarklet.txt).
2. Create a new browser bookmark named "FINSONLY Racing" and paste the **COMBINED** line in as the URL. It loads both FINSONLY Racing and [GEOFS-LiverySelector](https://github.com/kolos26/GEOFS-LiverySelector) with one click, so you get the custom liveries too. If you don't care about liveries, the **PRIMARY** line alone works.
3. Go to [geo-fs.com](https://www.geo-fs.com), let your plane load, then click the bookmark.

If that fails with a fetch/CSP-looking error, the page's security policy is blocking the direct fetch — use the **FALLBACK** or **COMBINED FALLBACK** line instead, which loads the same code from jsDelivr's CDN. Clicking the bookmark again just re-opens the panel if it's already loaded. PRIMARY and COMBINED always pull the latest code (GitHub caches it for up to ~5 minutes), so there is nothing to update.

**Pick a livery, pick a plane:** with LiverySelector loaded, press `l` to open its panel and choose one of the FINSONLY skins (F-16, B757, or Rafale). Racing itself always uses real F-16 physics — the "joke planes" (goldfish, bratwurst, traffic cone, toilet, parcel box, cow) are purely cosmetic. Open **Your plane** in the race panel to fly around looking like one instead; everyone else in the room sees it too.

### A race night, start to finish

1. **Click the bookmarklet** once your plane is on screen. The FINSONLY panel opens.
2. **Enter your callsign and the room.** Open **Leaderboard** and type your name in *Your name on the board* — it's remembered, and left blank it falls back to your GeoFS callsign. Then open **Powerups** and type the **Room** code the host gave you. Every pilot types the *same* code, and callsigns have to be unique within a room. (Leave Room empty and you land in a room named after the course you loaded, which only works once a course is loaded and only groups people on that course — use a code for a race night.)
3. **Lobby.** The moment you're connected to a room the lobby card appears, listing every pilot with a ready badge and a marker on the host. The first pilot into a room is the host; if the host leaves, it passes to whoever has been there longest. The host picks the course (it loads for everyone — if you don't have it the status line says so, and **↻** refreshes the list), chooses whether Powerups and Teleport are on, and can start a cup. Six quick-chat buttons (*Ready soon, Need 2 min, GG, Rematch?, BRB, Boss incoming!*) talk to the room.
4. **READY.** Click **READY UP** or press **Alt+Y**. Whenever the host changes the course or the rules, everyone's ready flag is cleared — so ready up *after* the host has settled. When everybody is ready the host presses **Start countdown**. (**Force start** skips waiting: anyone not ready becomes a spectator for that race.)
5. **Race.** Every machine counts down to the same GO. On an air-start course with Teleport on, you're placed on a starting grid behind gate 1. Cross gate 1 before GO and you pick up a 5-second penalty — never a disqualification. Take the gates in order, cross the last one to finish. Before the start, pick two loadout items in **Powerups**; fly through item boxes for more (see below).
6. **Results.** When everyone has finished or dropped out — or two minutes after the first finisher, whichever comes first — every pilot gets the same results card: finish order, times, points (15, 12, 10, 8, 6, 4, 2, 1 down the order), awards, and the cup standings if the host started a cup. **Esc** or **Close** dismisses it. The host can pick **Next race** or **Rematch**; anyone can **Race the winner's ghost**. Ready up again for the next one.

No server, or the server is down? The panel still times solo runs, records and replays ghosts, and fires your loadout Boost and Shield. There is no lobby, item box, offensive item or shared results — the panel says so.

### Items

Two come from the **loadout** you set in **Powerups** before a race (Speed Boost and Shield — pick either twice if you like — refilled every time you re-arm). The rest come from **item boxes**: rotating yellow cubes with a `?`, off to one side of the racing line. Fly through one and the item slot spins for about a second and a half, then reveals what you got. Boxes are contested — the first pilot through takes it, and it goes dark for *everyone* for six seconds. What you roll depends on where you are in the race: the further back you are, the better your odds, and the leader mostly gets a banana or nothing.

| Item | What it does | What it looks like | How to counter it |
|---|---|---|---|
| **Speed Boost** (loadout or box) | About 4 s of extra speed on your own aircraft | An orange glow trail behind the plane, for everyone; a speed-line vignette on the booster's own screen | Nothing to counter, it's only 4 s. Stay on their tail, or fire your own |
| **Shield** (loadout) | For 6 s, missiles, goop and bananas that reach you are bounced or eaten | A translucent cyan bubble around the plane that flashes white when it eats something | Attackers: it only counts when the shot *lands*, so hold your fire until it drops |
| **Banana** (box) | Dropped 150 m *behind* you; hits whoever flies into it — a wobble and tint for a few seconds. Arms after 1.5 s, lasts 2 minutes, never hits its dropper | A big yellow banana on a pole to the ground — dim while arming, pulsing once armed. Shows on the minimap | Fly around it (it's about 80 m wide), watch the minimap, or hit it with a Shield up and it's cleared for free |
| **Mustard missile** (box) | Homes on the nearest pilot *ahead* of you; 1.5–4 s flight. A hit tints and shakes the victim's screen | A glowing mustard projectile with a trail, visibly curving after its target; the victim gets a **MISSILE INBOUND from …** banner, a draining bar, an arrow at the missile and a warning tone that speeds up | **Pop your Shield while it is in the air** — a white ring flash, no hit. You have the whole flight to do it; too late doesn't work |
| **Goop** (box) | Same targeting as the missile, 1–3 s flight. A hit *grills* the victim: a view-obscuring green overlay for a few seconds | A green projectile; on a hit, a green blob rides the victim's plane where everyone can see it | Shield in flight, same as the missile. Once you're hit, fly straight and level until it clears — it wipes away from the middle outward |

The leader has nobody ahead to shoot: fire a missile or goop from the front and you're told *No target ahead* and keep the item. Right now every hit is **visual only** — a tint, shake, wobble or overlay on the victim's own screen. Nothing can knock you off course, stall the plane, or trip the speed-limit disqualification.

### Keys

| Key | What it does |
|---|---|
| **Alt+1 / Alt+2** | Use loadout slot 1 / 2 (Speed Boost or Shield) |
| **Alt+3** | Use the item you got from a box. Does nothing while the slot is still spinning |
| **Alt+R** | Reset the run and re-arm it. Mid-race in a lobby race that counts as dropping out |
| **Alt+H** | Hide or show the HUD (the panel keeps working) |
| **Alt+L** | Show or hide the racing line; your choice sticks across reloads |
| **Alt+Y** | READY / not ready in the lobby (Alt+R is already Reset run) |
| **Esc** | Close the results card |
| `l` | LiverySelector's own panel — a different script, unaffected by the above |

Course editor keys (only while building a course): **Alt+G** drops a gate where you are, **Alt+U** undoes the last draft gate, **Alt+B** drops an item box, **Alt+Shift+B** drops a row of three item boxes 120 m apart across your heading.

Keys are ignored while you're typing in a text box, and Chrome's own Alt+D/E/F are avoided on purpose.

### Hosting a race night

The host is whoever joins the room first, so the first person in should be the person running the night.

**Before anyone flies**
- [ ] The server is up: `https://race.finsonly.net/health` answers `{"ok":true}` and `https://race.finsonly.net/` loads. Just redeployed? Run the smoke test in [race/server/DEPLOY_CHECKLIST.md](race/server/DEPLOY_CHECKLIST.md).
- [ ] The shipped client points at it: in the DevTools console, `__finsRace.config.API_BASE` is `https://race.finsonly.net`, not `''`. With it empty there is no lobby at all.
- [ ] Pick the courses. Fly **Starter Sprint** or **Mt. Hood Circuit**; leave *Columbia Gorge Run* and *Crater Lake Rim* alone until they've been re-flown (their routes go through terrain).
- [ ] Pick a **room code** for the night (`friday-night`) and give it to everyone. You need one for a cup, or for any night where the course changes — the default room is named after the course, so a new course would drop people into a different room.
- [ ] Decide the rules — Powerups on or off, Teleport (grid start) on or off — and whether it's a cup (a name and 1–12 races).

**Getting everyone in**
- [ ] Everyone clicks the bookmarklet with their plane on screen, types a callsign and the room code, and shows up on the lobby card. Two pilots with the same callsign can't share a room.
- [ ] Anyone who's fallen behind on courses clicks **↻**. A *COURSE MISMATCH* banner means their copy differs from yours: refresh and reload.
- [ ] You pick the course (and rules, and **Start cup**) — *then* everyone readies up, because those changes clear the ready flags.
- [ ] Everyone shows ready → **Start countdown**. The wait is the *Lead time (s)* box under *Manual sync (no relay)* in the panel: 5–60 s, 10 by default. If someone's gone AWOL, **Force start** turns them into a spectator.

**Between races**
- [ ] Results card up → **Next race** (back to the lobby with the course picker open) or **Rematch** (same course). Everyone readies again.
- [ ] A cup adds points across its races and says which race is next. Changing course mid-cup needs the room code from above.

**When something goes wrong**
- [ ] **Countdown going wrong / somebody's not ready:** there is no abort button. In your DevTools console run `__finsRace.lobby.abortCountdown()`. To call off a race that's already running (it isn't scored), `__finsRace.lobby.backToLobby()`.
- [ ] **Someone joins late:** they watch as a spectator until you return the room to the lobby.
- [ ] **Someone's connection drops:** they're a DNF at the last gate they reported, and come back as a spectator.
- [ ] **The server restarts:** rooms are wiped. Every client retries on its own (the wait between tries grows to a cap of 30 s), whoever's first back is host, and a cup in progress is gone, so start a fresh one. Races already finished are still on the landing page.
- [ ] **Someone never sees the lobby, or never gets ready:** their bookmark is old. Have them click the COMBINED bookmark again (an old pinned FALLBACK bookmark can't ready up).

**Afterwards**
- [ ] Course records, recent races and any cup standings are on `https://race.finsonly.net/`.

### Courses

| Course | Difficulty | Notes |
|---|---|---|
| Starter Sprint (Sea-Tac test course) | Test course | Ground start near Sea-Tac |
| Columbia Gorge Run | Easy | Air start. **Not flyable yet:** the route cuts through the gorge walls |
| Crater Lake Rim | Medium | Air start. **Not flyable yet:** the route clips the crater rim |
| Mt. Hood Circuit | Tight | Air start. Passes the terrain check, not yet flown end-to-end |

All four carry item boxes. The three Oregon courses are hand-placed from coordinates rather than flown; [race/README.md](race/README.md) ("Shared course status") has the terrain-check results. If a gate looks buried or oddly placed, say something.

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
                                   ├─ SQLite /data/race.db  — leaderboard, ghost traces, finished lobby races and cups
                                   └─ in-memory rooms       — the relay: lobby, items, results (WS /ws/race/{room})
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
  - `test/` — `run.js` (headless engine tests) and the four pytest suites.
  - `tools/` — `probe.js` (read-only GeoFS/Cesium probe), `add_course.py`, `build_models.py`, `check_terrain.py`.

## Running the server

The full, step-by-step sequence — exact Compose/Caddy blocks, every verification command, the WebSocket smoke test — lives in [race/server/DEPLOY_CHECKLIST.md](race/server/DEPLOY_CHECKLIST.md); this is just the shape of it, on an Unraid box:

1. Copy `app.py`, `requirements.txt`, and `Dockerfile` to the box, and create a data directory owned `99:100` (the container's `nobody:users`).
2. Merge [race/server/compose.snippet.yml](race/server/compose.snippet.yml) into the stack's compose file — it joins the existing external `proxy` network that Caddy fronts.
3. Add [race/server/Caddyfile.snippet](race/server/Caddyfile.snippet) as its own block, copying the same geoblock/CrowdSec directives already used elsewhere in the stack. No Authelia here — the browser calls this API cross-origin from geo-fs.com and can't follow an Authelia login redirect. The same block also fronts the powerups relay's WebSocket upgrade at `/ws/race/{room}`; Caddy 2 proxies WS upgrades automatically, so nothing extra is needed for it.
4. `docker compose up -d --build race-api`, then confirm `https://race.finsonly.net/health` returns `{"ok":true}`.

Two things matter more than they look: the `-v /mnt/user/appdata/race-api:/data` volume mount, and `RACE_DB` (baked into the image as `/data/race.db`, overridable with `-e RACE_DB=...`). SQLite writes to whatever `RACE_DB` points at, and the volume mount is what makes that path survive a container rebuild or restart instead of vanishing with the rest of the container's writable layer — skip the mount and every run ever recorded disappears the next time the container is rebuilt. `requirements.txt` also pins `uvicorn[standard]`, not plain `uvicorn`, because the `[standard]` extra is what actually brings WebSocket support — without it, the powerups relay at `/ws/race/{room}` can't run at all.

## Development

Run all five test suites before committing anything — the project convention is to never commit with a failing suite:

```bash
cd race/test && npm i jsdom@24 && node run.js                                            # engine + model swap + powerups client
cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q   # leaderboard + relay API
cd race/test && python -m pytest test_add_course.py -q                                   # course validation/import
cd race/test && pip install pygltflib numpy pytest && python -m pytest test_models.py -q # generated joke-plane models
cd race/test && python -m pytest test_check_terrain.py -q                               # terrain-clearance checker (offline)
```

Because the GeoFS/Cesium internals in the `G` adapter are guesses until someone checks them against the live site, there's a separate, read-only verification loop: load the **PROBE** line from `race/bookmarklet.txt` (or paste it straight into DevTools) on geo-fs.com after the plane has loaded. It only reads properties — it never writes anything — and copies a JSON report to the clipboard (or logs it if the clipboard is blocked); paste that report back so any `TODO-PROBE` guess in `race.js` can be corrected or confirmed against what the live site actually exposes. See [race/tools/probe.js](race/tools/probe.js) and `race/README.md`'s "Model swaps" and "Before trusting this" sections for the current state of what's confirmed vs. guessed.

Releases: bump `CONFIG.VERSION` in `race.js` on any user-visible change, then cut a tag:

```bash
git tag -a race-vX.Y.Z -m "FINSONLY Racing vX.Y.Z" && git push origin race-vX.Y.Z
```

The **FALLBACK** and **COMBINED FALLBACK** bookmarklet lines pin a jsDelivr `@race-vX.Y.Z` tag rather than tracking `main` (the current pin is `race-v1.0.0`), so a release also means repointing those two lines in `race/bookmarklet.txt` to the new tag. `race/test/run.js` fails the suite if the pinned tag doesn't actually exist in the repo — that's how a stale, never-cut pin went unnoticed for a while.

## Config

Every key of `CONFIG` at the top of [race/race.js](race/race.js), by area. Defaults are what ships; a
flag marked *master* switches a whole module off (it stops subscribing and binds no keys, rather than
just doing nothing). Nothing in `race/test/run.js` fails if this table drifts from `race.js`, so
update both together.

**Core**

| Key | Default | Meaning |
|---|---|---|
| `VERSION` | `'1.0.0'` | Client version shown in the panel; bump on user-visible changes |
| `COURSE_BASE` | raw.githubusercontent `.../race/courses/` | Where `courses/index.json` and course files are fetched from |
| `MODEL_BASE` | raw.githubusercontent `.../race/models/` | Where joke-plane models, `index.json`, and assignments are fetched from |
| `API_BASE` | `''` | Leaderboard/relay server URL; empty disables the leaderboard **and** the whole relay: lobby, item box, offensive items and shared results |
| `DEFAULT_RADIUS_M` | `150` | Default gate radius in the course editor |
| `MAX_SPEED_MS` | `700` | Speed between samples (~1360 kt) that triggers a teleport/slew disqualification |
| `PAUSE_MOVE_TOLERANCE_M` | `50` | How far you can drift while paused before it's a disqualification |
| `ALT_OFFSET_M` | `0` | Visual-only vertical nudge for how gates render |
| `COURSE_MAP` | `true` | Draw the loaded course's gates/route on GeoFS's Leaflet nav map |
| `COUNTDOWN_LEAD_S` | `10` | Default lead time (s) for a countdown, in the lobby's host controls and under "Manual sync" |
| `TEST_SPACING_M` | `2000` | Gate spacing used by "Build test course ahead of me" |
| `TEST_COUNT` | `6` | Number of gates the test-course builder drops |
| `READY_TIMEOUT_MS` | `180000` | How long start-up waits for GeoFS to finish loading before it gives up and says so |

**HUD and sound**

| Key | Default | Meaning |
|---|---|---|
| `HUD` | `true` | *Master* for the full-viewport race HUD; off, Alt+H hides the settings panel instead |
| `HUD_HZ` | `10` | HUD refresh rate |
| `SFX_VOLUME` | `0.5` | WebAudio master gain, 0-1 |
| `WAYPOINT_BRACKET` | `true` | Screen-space bracket / edge chevron over the next gate |
| `HUD_EDGE_INSET_PX` | `60` | A gate closer than this to a viewport edge gets a chevron instead of a bracket |
| `MINIMAP` | `true` | North-up SVG course map in the HUD's bottom-right corner |
| `MINIMAP_HZ` | `4` | How often the minimap's moving markers update (capped by `HUD_HZ`) |

**Ghost racing** (0.9.0)

| Key | Default | Meaning |
|---|---|---|
| `TRACE` | `true` | *Master* for recording a trace while running; off, nothing is sampled or saved |
| `TRACE_HZ` | `4` | Trace samples per second |
| `TRACE_MAX_SAMPLES` | `6000` | Hard cap (25 min at 4 Hz); past it recording stops and a truncated trace is never saved |
| `TRACE_MAX_COURSES` | `20` | LRU cap on locally stored traces, keyed by course hash |
| `TRACE_SEARCH_N` | `64` | Forward-only search window (samples) when locating the pilot on a trace |
| `GHOST` | `true` | *Master* for replaying a saved or remote trace as a translucent ghost aircraft |
| `GHOST_ALPHA` | `0.45` | Ghost translucency |
| `RACING_LINE` | `true` | Draw the selected ghost's path ahead of you; Alt+L toggles it live |
| `LINE_AHEAD_M` | `4000` | How far along the path the line is drawn, in metres of path |
| `LINE_REBUILD_HZ` | `2` | How often the drawn window is recomputed, never per frame |
| `LINE_DELTA_BAND_MS` | `300` | A live delta inside this reads amber; outside it, green or red |
| `LINE_SPLINE_STEPS` | `12` | Samples per gate-to-gate segment of the no-trace suggested line |

**Powerups** (loadout and relay items)

| Key | Default | Meaning |
|---|---|---|
| `POWERUPS` | `true` | *Master* for the whole Powerups module: loadout, relay box/offensive items, and (because it rides the same socket) the lobby |
| `POWERUP_BOOST_MS` | `4000` | Boost effect duration |
| `POWERUP_BOOST_ADD_MS` | `35` | Extra speed (m/s) while boosted, kept well under `MAX_SPEED_MS` |
| `POWERUP_SHIELD_MS` | `6000` | Shield effect duration (the relay caps a shield claim at the same value) |
| `POWERUP_BANANA_MS` | `2500` | Incoming-banana effect duration |
| `POWERUP_MISSILE_MS` | `3000` | Incoming-missile effect duration |
| `POWERUP_GOOP_MS` | `4000` | Incoming-goop effect duration |
| `POWERUP_POS_HZ` | `2` | How often the client pings the relay with position/progress while racing |
| `POWERUP_RECONNECT_MS` | `2000` | Relay reconnect backoff base (doubles per attempt) |
| `POWERUP_RECONNECT_MAX_MS` | `30000` | Cap on the reconnect backoff |
| `POWERUP_ROOM` | `''` | Fixed relay room code; empty means the typed Room box, else the course hash |

**Visible items** (0.10.0, relay proto 3)

| Key | Default | Meaning |
|---|---|---|
| `ITEMS` | `true` | *Master* for the items layer: world entities, projectiles, boost/shield effects |
| `ITEM_ENTITY_BUDGET` | `40` | Hard cap on live item entities; oldest evicted first |
| `ITEM_TTL_MS` | `12000` | Client-side TTL on every item entity, even if no clearing frame arrives |
| `BOX_RESPAWN_MS` | `6000` | How long a taken box stays dark; must match the relay's `BOX_RESPAWN_S` |
| `BOX_ROLL_MS` | `1500` | The item-slot roulette on a grant; the item cannot be fired until it ends |
| `BANANA_RADIUS_M` | `80` | Client-side 3D trip radius; the relay validates within this + 400 m |
| `BANANA_TTL_MS` | `120000` | Matches the relay's `BANANA_TTL_S` |
| `PROJECTILE_TRAIL_N` | `12` | Trail points kept behind a missile/goop |
| `BOOST_TRAIL_MS` | `1500` | How much of a boosting aircraft's recent path glows orange |
| `HIT_SHAKE` | `true` | Brief CSS jitter on the render canvas when something lands; also off under `prefers-reduced-motion` |
| `POWERUP_SPEED_PENALTY` | `false` | A missile hit costs real speed (a scalar speed write, not a control write) |
| `PENALTY_FLOOR_MS` | `110` | The penalty never takes you below this speed (m/s) |
| `PENALTY_MS` | `1500` | ...and never holds longer than this |
| `PENALTY_MIN_AGL_M` | `150` | ...and never applies below this height above ground, when readable |

**Lobby and results** (relay proto 2 / 4)

| Key | Default | Meaning |
|---|---|---|
| `LOBBY` | `true` | *Master* for the relay lobby: host, ready, synced start. Needs `POWERUPS` and `API_BASE` |
| `RESULTS` | `true` | Shared results screen and cups. Needs `LOBBY` and a proto-4 relay |
| `JUMP_START_PENALTY_MS` | `5000` | Added to your lobby-race clock for crossing gate 1 before GO; never a DQ |

**Aircraft writes** (Boost, fly-to-start)

| Key | Default | Meaning |
|---|---|---|
| `POWERUP_CONTROL_EFFECTS` | `false` | Real control disruption on a hit; off means offensive items stay screen-effect-only. Do not turn on |
| `SAFE_WRITES` | `true` | Only write GeoFS fields the probe has confirmed safe; `false` allows a riskier in-sim escape hatch |
| `VELOCITY_FRAME` | `null` | Recorded shape/axis of `geofs.aircraft.instance.velocity`; `null` means no vector writes happen at all |
| `SPEED_WRITE_MARGIN_MS` | `50` | Safety margin every speed write stays under `MAX_SPEED_MS` |
| `BOOST_LLA_FALLBACK` | `false` | Opt-in fallback: move the aircraft via `llaLocation` instead of the confirmed scalar writes |
| `FLY_TO_START_SPEED_MS` | `150` | Airspeed (m/s) you are left at on gate 1 after Fly to start or a grid placement |
| `FLY_TO_START_TOLERANCE_M` | `250` | How far from gate 1 GeoFS's own reset may land before falling back to state writes |

## License

No LICENSE file yet — this is a personal/friends project, so treat it as all-rights-reserved unless that changes.
