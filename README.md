<p align="center">
  <img src="docs/assets/banner.svg" alt="FINSONLY Racing: checkpoint racing for GeoFS" width="100%">
</p>

<h1 align="center">FINSONLY</h1>

<p align="center">
  <b>Checkpoint racing for GeoFS: gates, ghosts, Mario-Kart items and joke planes, one bookmarklet, no extension.</b>
</p>

<p align="center">
  <a href="#get-flying-in-60-seconds">Play</a> ·
  <a href="https://race.finsonly.net">Leaderboard</a> ·
  <a href="docs/RUNBOOK.md">Runbook</a> ·
  <a href="race/PROTOCOL.md">Protocol</a>
</p>

This repo is two things stacked on top of each other. At the root it's **Finsonly Air**, a joke
airline's liveries for the Boeing 757, the F-16 and the Rafale M, loaded in-sim by
[GEOFS-LiverySelector](https://github.com/kolos26/GEOFS-LiverySelector) from
[airline.json](airline.json). In [race/](race/) it's **FINSONLY Racing**: a full checkpoint-racing
mode bolted onto the same sim. You get a room lobby, a synced start, gates and splits, a shared
leaderboard, ghosts of your mates' best runs, item boxes full of bananas and mustard missiles, and
the option to fly the whole thing as a goldfish.

<img src="docs/assets/divider.svg" alt="" width="100%">

## Get flying in 60 seconds

1. **Add the bookmarklet.** Open [race/bookmarklet.txt](race/bookmarklet.txt), copy the
   **COMBINED** line, and paste it as the URL of a new bookmark called `FINSONLY Racing`. It loads
   the racing client *and* LiverySelector in one click. Just want racing? The **PRIMARY** line
   does that. The install panel on [race.finsonly.net](https://race.finsonly.net) serves the
   PRIMARY line too (built from the same file by `GET /bookmarklet`).
2. **Open [geo-fs.com](https://www.geo-fs.com)** and wait until your plane is on screen.
3. **Click the bookmark.** The panel opens on **The Ramp**, a departure board of open rooms.
   **Join** one, hit **Quick Match**, or take the **Solo** tab for a time trial. Lost the panel
   mid-race? **Alt+K** brings it back.

> **Why a bookmarklet?** The machine this is built for blocks Tampermonkey and browser extensions
> outright. So the whole client is one JavaScript file, and a bookmark fetches it and drops it into
> the page. No install, nothing to update: PRIMARY and COMBINED always pull the latest `main`
> (GitHub caches it for about 5 minutes). If the page blocks the fetch, use the **FALLBACK** line,
> which loads a pinned tag from jsDelivr instead.

## Playing on a tablet

On an Android tablet there's no bookmark bar, so a **userscript** does the bookmarklet's job for
you. It loads the racing client and LiverySelector as soon as your plane is on screen.

1. **Install Firefox for Android**, then add **Tampermonkey** from Firefox's add-ons menu.
2. **Install the userscript.** Open
   [race/tools/finsonly-race.user.js](https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/tools/finsonly-race.user.js)
   (the raw link). Tampermonkey offers to install it. It updates itself from `main`.
3. **Open [geo-fs.com](https://www.geo-fs.com)** in landscape and wait for the plane. A toast says
   **Racing OK · Liveries OK**. It says *(fallback)* if it had to use the pinned copy, or
   **FAILED (reason)** if something wouldn't load.

> **Testing a branch?** In Tampermonkey's editor, change `const BRANCH = 'main';` at the top of
> the script to the branch name (e.g. `'tablet-mode'`) and save. Set it back to `'main'` after.

**Touch.** On a tablet the client switches to **touch mode**: one small pill at the top (position,
time, gate, speed, altitude and a connection dot), the items as an icon column, the minimap behind
a **MAP** button, and a **touch bar** of big buttons that changes with what you're doing: Ready /
Panel / Chat / Controller in a room, Boost / Shield / Item / Fly to start / Minimap / Reset in a
race, Drop gate / Undo / Save in the editor. **Fly to start** and **Reset** need a one-second
press-and-hold. Nothing FINSONLY draws sits on top of GeoFS's own buttons, stick or throttle. The
screen stays on while you're in a room or racing. If you switch apps and come back, it reconnects
by itself. (Mid *lobby* race, the relay brings you back as a spectator until the next race.)

**Nintendo Switch Pro Controller** (Bluetooth; other pads work too, with Xbox/PlayStation labels).
First set up GeoFS itself: **Options → Controls → Joystick**.

| In GeoFS, assign | To |
|---|---|
| Left stick | Roll and pitch |
| Right stick X | Yaw |
| **ZR / ZL** | Throttle up / down |
| D-pad | Flaps, gear, brakes |
| **A B X Y L R + −** | *Nothing.* Leave them unassigned so they don't double-fire with FINSONLY |

FINSONLY then uses those eight buttons:

| Button | Does |
|---|---|
| **R** / **L** | Fire loadout slot 1 / 2 |
| **A** | Fire the item from a box |
| **B** | Minimap open / closed |
| **Y** (hold 1 s) | Fly to start (solo; a ring fills while you hold, a tap does nothing) |
| **X** | GeoFS instruments hidden / shown (once `HIDE_GEOFS_INSTRUMENTS` is enabled) |
| **+** | Ready / not ready at the Gate, or close the results card |
| **−** | Panel open / collapsed |
| **+** and **−** (hold 2 s) | Controller panel: live buttons, re-bind, reset, setup wizard |

The first time a pad connects you get a one-time legend. If Firefox reports the pad with a
non-standard layout, a short **setup wizard** asks you to press each button once. Bindings are
remembered per controller in this browser. FINSONLY never reads the sticks, ZL/ZR, the D-pad or
the stick clicks; those stay GeoFS's.

<img src="docs/assets/divider.svg" alt="" width="100%">

## What's in it

**Live** is shipped in the default client and flown. **Beta** is shipped, but its in-sim checks in
[race/ACCEPTANCE.md](race/ACCEPTANCE.md) are still open. **Coming** isn't in the client yet.

| Feature | What you get | Status |
|---|---|---|
| **Lobby** | The Ramp (room browser, Quick Match, ping the ramp), the Gate (course vote, ready-up, chat) and a synced countdown on Launch | Live |
| **Rolling start** | On air-start courses, everyone flies a hands-off pace lap on autopilot and gets a green flag (relay proto 8) | Beta |
| **Ghosts and rival ghosts** | Race your best, the course record, or up to two friends' ghosts at once, with a live racing line and a delta | Beta |
| **Items and powerups** | A Boost and Shield loadout, plus item boxes with bananas, homing mustard missiles and goop | Beta |
| **Results and cups** | One shared results card, points (15-12-10-8-6-4-2-1), awards and cup standings | Beta: cups start from the console for now (see [the runbook](docs/RUNBOOK.md#race-night)) |
| **Landing challenge** | The Landing tab: 26 runways worldwide in four landing cups ([LANDING_CUPS.md](race/runways/LANDING_CUPS.md)), a spawn on the approach, a Landing HUD (ILS dots, sink, stability) and a server-scored scorecard, 0–1000. Plus a four-runway Landing Cup | Beta: not flown in-sim yet ([ACCEPTANCE](race/ACCEPTANCE.md#landing-challenge)); seven runways' approach paths are provisional |
| **Robot test pilot** | A dev bookmarklet that flies every course and approach on the autopilot, reports what fails, and can post a PASS as the course's House ghost | Beta: dev tool, not flown in-sim yet |
| **Course editor** | Fly a route, drop gates with **Alt+G**, and share it as JSON | Live |
| **Joke planes** | Fly as a goldfish, bratwurst, cone, toilet, parcel, cow, rubber duck, cheese wedge, beer stein, pizza slice, flying couch or shopping cart. The physics stay stock F-16 | Live (the six new ones are not yet checked in-sim) |
| **Liveries** | Finsonly Air skins for the 757, F-16 and Rafale M through LiverySelector | Live |

## Powerups

Pick a two-item **loadout** before the race (repeats allowed: 2× Boost is legit). Everything else
comes out of **item boxes**, the spinning yellow `?` cubes off to the side of the racing line. The
first pilot through a box takes it, and it goes dark for everyone for 6 s. The relay rolls your
item, weighted by your race position: the further back you are, the better your odds. The leader
mostly gets bananas.

| Item | What it does | How you get it |
|---|---|---|
| **Speed Boost** | +50 m/s along your flight path, ramped in over 1 s and capped at 650 kt. You trail orange for 4 s | Loadout (**Alt+1** / **Alt+2**) or a box (**Alt+3**) |
| **Shield** | For 6 s, a missile, goop or banana that reaches you is blocked. Pop it *while* a missile is in the air | Loadout only |
| **Banana** | Drops 150 m behind you, arms after 1.5 s and sits there for 2 min. Whoever flies into it gets a wobble and a tint | Box |
| **Mustard missile** | Homes on the nearest pilot *ahead* with a 1.5–4 s telegraphed flight, then tints and shakes their screen | Box |
| **Goop** | Same targeting, 1–3 s flight. The victim gets *grilled*: a green overlay that clears from the middle out | Box |
| *Nothing* | The box shrugs. It's a real, weighted outcome | Box |

Every hit is **screen-only**: no item can touch anyone's controls (`POWERUP_CONTROL_EFFECTS` is off
and stays off). Fire from the lead and you're told *No target ahead* and keep the item. Full
mechanics are in [race/README.md](race/README.md#powerups-and-items).

## Courses and cups

The shared courses live in [race/courses/](race/courses/) (the list is
[`index.json`](race/courses/index.json)). There are 69 of them in 17 cups of four for cup night, from the Oregon
coast and the Wisconsin Dells to the Alps, Norway's fjords, Alaska, Hawaii, Japan, China, the pyramids,
a pylon-racing circuit cup and a bush-flying cup. Which courses are in which cup, and which ones actually clear the
terrain, is tracked in **[race/courses/CUPS.md](race/courses/CUPS.md)**. Check it before you pick
one for a race night. Want to add your own? Fly it in the editor and follow
[the runbook](docs/RUNBOOK.md#content).

## Joke planes

Every racer flies a real F-16, so the physics are identical. You can just be *rendered* as
something sillier, and everyone in the room sees it too. Pick yours under **Your plane**, or get
one assigned by callsign in [assignments.json](race/models/assignments.json).

| Model | Id | File |
|---|---|---|
| Goldfish | `goldfish` | [goldfish.glb](race/models/goldfish.glb) |
| Bratwurst | `bratwurst` | [bratwurst.glb](race/models/bratwurst.glb) |
| Traffic Cone | `traffic-cone` | [traffic-cone.glb](race/models/traffic-cone.glb) |
| Toilet | `toilet` | [toilet.glb](race/models/toilet.glb) |
| Parcel Box | `parcel-box` | [parcel-box.glb](race/models/parcel-box.glb) |
| Cow | `cow` | [cow.glb](race/models/cow.glb) |
| Rubber Duck | `rubber-duck` | [rubber-duck.glb](race/models/rubber-duck.glb) |
| Cheese Wedge | `cheese-wedge` | [cheese-wedge.glb](race/models/cheese-wedge.glb) |
| Beer Stein | `beer-stein` | [beer-stein.glb](race/models/beer-stein.glb) |
| Pizza Slice | `pizza-slice` | [pizza-slice.glb](race/models/pizza-slice.glb) |
| Flying Couch | `flying-couch` | [flying-couch.glb](race/models/flying-couch.glb) |
| Shopping Cart | `shopping-cart` | [shopping-cart.glb](race/models/shopping-cart.glb) |

See them all side by side in [preview.png](race/models/preview.png). All twelve are generated low-poly by
[race/tools/build_models.py](race/tools/build_models.py) and listed in
[race/models/index.json](race/models/index.json).

<img src="docs/assets/divider.svg" alt="" width="100%">

## Finsonly Air liveries

With LiverySelector loaded, press `l` in GeoFS and pick a Finsonly skin. These are the texture
sheets themselves, so they look like flat cutouts rather than a plane. Names are from
[airline.json](airline.json).

**Boeing 757-200**

<table>
  <tr>
    <td align="center"><img src="b757-200_khabo2026.png" width="240" alt="KHABO 2026"><br>KHABO 2026</td>
    <td align="center"><img src="b757-200_khabo2026_afterdark.png" width="240" alt="KHABO 2026 AFTER DARK"><br>KHABO 2026 AFTER DARK</td>
    <td align="center"><img src="b757-200_khabo2027_kh.png" width="240" alt="KHABO 2027 (KH)"><br>KHABO 2027 (KH)</td>
  </tr>
  <tr>
    <td align="center"><img src="b757-200_khabo2027_palms.png" width="240" alt="KHABO 2027 Palms (KH)"><br>KHABO 2027 Palms (KH)</td>
    <td align="center"><img src="b757-200_goldfish.png" width="240" alt="FINSONLY Goldfish (RIP Steve)"><br>FINSONLY Goldfish (RIP Steve)</td>
    <td align="center"><img src="b757-200_bratbeer.png" width="240" alt="FINSONLY Brathaus"><br>FINSONLY Brathaus</td>
  </tr>
</table>

**F-16 Fighting Falcon**

<table>
  <tr>
    <td align="center"><img src="khabo_f16.webp" width="240" alt="FINSONLY - KHABO 2026"><br>FINSONLY - KHABO 2026</td>
    <td align="center"><img src="steves_revenge_f16.webp" width="240" alt="FINSONLY - Steve's Revenge"><br>FINSONLY - Steve's Revenge</td>
  </tr>
  <tr>
    <td align="center"><img src="f16_rubberduck_livery_baby.webp" width="240" alt="FINSONLY - GET DUCKED"><br>FINSONLY - GET DUCKED</td>
    <td align="center"><img src="f16_cow_alien.webp" width="240" alt="FINSONLY - Moo Force One (Alien Cow)"><br>FINSONLY - Moo Force One (Alien Cow)</td>
  </tr>
</table>

**Dassault Rafale M**

<table>
  <tr>
    <td align="center"><img src="rafale/rafale_vapor_main_v1.webp" width="240" alt="FINSONLY - Steve's Revenge (Vaporwave Chrome)"><br>FINSONLY - Steve's Revenge (Vaporwave Chrome)</td>
  </tr>
</table>

The 757 "UV Test" sheets and the F-16 "UVCAL" sheets in `airline.json` are UV calibration
textures, not liveries. The other files in [rafale/](rafale/) are test textures for the Rafale's
specular map.

## Controls

The eight you'll actually use:

| Key | Does |
|---|---|
| **Alt+1** / **Alt+2** | Fire loadout slot 1 / 2 |
| **Alt+3** | Fire the item from a box |
| **Alt+Y** | Ready / not ready at the Gate |
| **Alt+R** | Reset the run (mid-race in a lobby race, that's a DNF) |
| **Alt+K** | Collapse or reopen the panel, including mid-race |
| **Alt+H** | Hide or show the HUD |
| **Alt+L** | Racing line on/off |

Plus **Esc** to close the results card. The full list, including the course editor keys, is in
**[docs/REFERENCE.md](docs/REFERENCE.md#shortcuts)**, generated straight from the code.

<img src="docs/assets/divider.svg" alt="" width="100%">

## For maintainers

### Architecture

```mermaid
flowchart LR
  subgraph browser["Browser on geo-fs.com"]
    bm["Bookmarklet"] --> rjs["race/race.js<br/>(one file, no build)"]
    rjs --- G["G adapter<br/>GeoFS/Cesium reads"]
    rjs --- GP["GeoPhysics<br/>aircraft writes"]
    rjs --- layers["make*Layer factories<br/>gates, items, ghosts, line"]
  end
  subgraph repo["GitHub: this repo (static data)"]
    courses["race/courses/*.json"]
    models["race/models/*.glb<br/>index.json, assignments.json"]
    runways["race/runways/*.json"]
  end
  subgraph box["Unraid box: Docker"]
    caddy["Caddy<br/>race.finsonly.net"] --> api["race-api: FastAPI<br/>app.py"]
    api --> db[("SQLite race.db<br/>runs, traces, races, pilots")]
    api --- mem["in-memory rooms<br/>relay + hub"]
  end
  rjs -- "COURSE_BASE / MODEL_BASE<br/>raw.githubusercontent" --> courses
  rjs --> models
  rjs -- "HTTPS: runs, leaderboard, ghosts" --> caddy
  rjs -- "WSS: /ws/race/{room}, /ws/hub" --> caddy
  repo -. "deploy branch, polled by autodeploy.sh" .-> box
```

Everything GeoFS- or Cesium-specific goes through the `G` adapter, the `GeoPhysics` adapter or a
`make*Layer` factory, so a GeoFS update only needs fixing in one place. The server has no auth,
because any key would ship inside public JS. It relies on plausibility checks, per-IP rate limits,
and geoblock/CrowdSec at Caddy. Room state is in memory. Only finished runs, traces, finished lobby
races and pilot identities go to SQLite.

### Repo layout

```text
.
├── README.md, CLAUDE.md
├── airline.json            Finsonly Air livery manifest (read by LiverySelector)
├── *.png, *.webp           757 and F-16 livery textures, loaded by URL (don't rename)
├── rafale/                 Rafale M livery and specular test textures
├── tools/                  build_spec.py: Rafale specular map from a paint mask
├── docs/                   runbook, generated reference, docs index, brand assets
│   ├── assets/
│   └── reports/            dated session and merge reports (e.g. 2026-09-24/)
└── race/                   FINSONLY Racing
    ├── race.js             the whole client
    ├── bookmarklet.txt     PRIMARY / COMBINED / FALLBACK / PROBE / RECORDER / LAB lines
    ├── touchdown.js        pure touchdown detector (not wired into race.js yet)
    ├── courses/            shared courses + index.json + CUPS.md
    ├── models/             joke-plane .glb files, index.json, assignments.json
    ├── runways/            landing-mode runway defs (loaded by the server) + LANDING_CUPS.md
    ├── addons.json, ADDONS.md  pinned third-party GeoFS addons
    ├── server/             FastAPI app, Dockerfile, deploy scripts, public site
    ├── test/               run.js (JS) and the pytest suites
    ├── tools/              course, runway, terrain, model, addon, probe, smoke and docs tools
    └── docs/               audit history, acceptance stub, LAPS and BUSH_MODE designs
```

### Where things live

| Doc | For |
|---|---|
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Every operational task: race night, content, release, deploy, backups, troubleshooting |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Generated tables: hotkeys, `CONFIG`, endpoints, env vars |
| [race/PROTOCOL.md](race/PROTOCOL.md) | The relay and hub wire protocol, proto 1–8 |
| [race/README.md](race/README.md) | Module guide: what each piece of `race/` does and how they talk |
| [race/ACCEPTANCE.md](race/ACCEPTANCE.md) | The in-sim checklist a release has to pass |
| [race/CHANGELOG.md](race/CHANGELOG.md) | What shipped, per version |
| [docs/README.md](docs/README.md) | Index of every doc |

<img src="docs/assets/divider.svg" alt="" width="100%">

## Disclaimer and license

FINSONLY is an unaffiliated hobby project for a friend group, built on top of the free browser
flight sim [GeoFS](https://www.geo-fs.com). It isn't affiliated with or endorsed by GeoFS.

There's no LICENSE file. All rights reserved.
