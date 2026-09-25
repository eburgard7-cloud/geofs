# In-sim acceptance checklist

Everything the test suites can't settle: the HUD, the lobby, items, ghosts and shared results on
the live GeoFS sim against the **deployed** relay, plus failure drills. It's one file, grouped by
feature. It merges the old race-night script (formerly this file) and the lobby checklist (formerly
`race/docs/ACCEPTANCE.md`).

**Release rule** (race/PROTOCOL.md "Versioning"): neither `PROTO` nor `CONFIG.VERSION` is bumped
until a full run of this checklist and `python race/tools/smoke_lobby.py` (all 12 steps) have both
passed against the deployed relay for that build.

**How to use it**
- Fill in **Last passed** with the ISO date and the client version or commit, e.g.
  `2026-09-24 · 1.7.0`. Blank means it has never been recorded as passing.
- Write anything that isn't a clean pass in the [sign-off](#sign-off) table, with the row ID.
- **ID** keeps each row's origin, so older notes still resolve: `LB x.y` is from the lobby
  checklist, `RN x.y` is from the race-night script, and `Hub n` / `Ramp n` / `Gate n` /
  `Launch 1` / `Shell` / `Fix n` / `Landing n` / `Modes n` / `RS n` / `UI n` are from the
  per-release sections. Merged duplicates list both IDs.
- **Items are random.** An item that never came up is *not run*, not a pass.
- Adding a check: put it in the section for its feature, give it the next free ID in the most
  specific series (or a new short prefix), and leave **Last passed** blank. If it needs more than
  two pilots and one relay, put it under [Needs more than the standard run](#needs-more-than-the-standard-run).
- Rows marked *(rollback UI)* describe the classic panel and floating lobby card, which only exist
  with `CONFIG.LOBBY_V2 = false`. Run them only when testing that rollback path.

## Contents

- [Setup](#setup)
- [Preflight](#preflight)
- [Ramp, hub and identity](#ramp-hub-and-identity)
- [Gate: ready, vote, chat, host controls](#gate-ready-vote-chat-host-controls)
- [One client, one socket, one UI](#one-client-one-socket-one-ui)
- [Countdown, grid, teleport and rolling start](#countdown-grid-teleport-and-rolling-start)
- [Air start and course env](#air-start-and-course-env)
- [HUD and panel](#hud-and-panel)
- [Items and powerups](#items-and-powerups)
- [Results and cups](#results-and-cups)
- [Ghosts, racing line, bracket and minimap](#ghosts-racing-line-bracket-and-minimap)
- [Solo, courses and editor](#solo-courses-and-editor)
- [Failure drills and compatibility](#failure-drills-and-compatibility)
- [Public site and server data](#public-site-and-server-data)
- [Landing tools](#landing-tools)
- [Landing challenge](#landing-challenge)
- [Landing score v2](#landing-score-v2)
- [Robot test pilot](#robot-test-pilot)
- [Physics Lab discovery](#physics-lab-discovery)
- [Tablet](#tablet)
- [Needs more than the standard run](#needs-more-than-the-standard-run)
- [Race-night run order](#race-night-run-order)
- [Sign-off](#sign-off)
- [History: original check numbers](#history-original-check-numbers)

## Setup

Two pilots. Either two machines, or two windows on one PC.

| | |
|---|---|
| **Pilot A** | Host, joins the room first. Callsign `PilotA`. A normal Chrome/Edge window on geo-fs.com |
| **Pilot B** | Guest. Callsign `PilotB`. A second machine, or an **InPrivate/Incognito** window on the same PC (its own `localStorage`, so its own pilot token and callsign) |
| **Layout** | Side by side, **both visible**. A minimised or covered window gets its timers throttled, and the host's auto-start and the Launch countdown run in the host's tab |
| **Loader** | The current PRIMARY or COMBINED bookmark. Raw GitHub caches for ~5 min, so click it after any push |
| **Both** | F-16, sound on, DevTools console open. `__finsRace.version` prints the version under test |
| **Debug** | **Alt+D** in each window shows the debug overlay (top left). If the browser grabs Alt+D, use `__finsRace.debug.toggle()` |
| **Also** | A phone to film both screens (the sync checks are only honest on video), and shell access to the Unraid box for the drills |
| **Courses** | `starter-sprint-seatac` (ground start) and an **air-start** course the vote offers (`hood-circuit` if you pick one by hand). Use only courses [courses/CUPS.md](courses/CUPS.md) lists as flyable |

## Preflight

| ID | Check | Expect | Last passed |
|---|---|---|---|
| LB 0.1 · RN 0.1 | The deploy smoke test ([runbook](../docs/RUNBOOK.md#smoke-test-after-every-deploy)): `/health`, `/ghost?course_hash=0000dead`, a WebSocket `join`, `GET /` | `{"ok":true,"courses":N}` with N > 0. The `/ghost` body is *No ghost recorded…* (not *Not Found*). `joined.proto` is the server's `PROTO`. `/` returns 200 | |
| LB 0.2 | `python race/tools/smoke_lobby.py` from your machine | `all 12 steps passed`, exit 0 | |
| LB 0.3 | `docker logs race` (or `race-api`) on the box | `courses loaded: N from /app/courses` | |
| RN 0.2 | Console on both: `__finsRace.config.API_BASE` and `__finsRace.version` | `API_BASE` is the server URL (not `''`: empty means no lobby at all). The version is the one being released. Record both | |
| RN 0.3 | Both click the bookmark with the plane on screen | The panel opens. No red errors in the console | |
| LB 0.4 | Debug overlay, both windows | `client v<expected>`, `ui shell (CONFIG.LOBBY_V2 is on)`, `loads 1` | |
| LB 0.5 | Click the bookmark a **second** time in A | The panel re-shows. The overlay says `loads 2` and `sockets race 0/1` (never 2). No second panel | |
| Fix 1 | On geo-fs.com: `wss://race.finsonly.net/ws/hub` connects under the site's CSP. **+ New room** opens `wss://race.finsonly.net/ws/race/<code>` (DevTools → Network → WS) | The room appears on a second pilot's departure board. If the hub connects but the room socket doesn't, suspect Caddy's route for `/ws/race/` | |

## Ramp, hub and identity

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Ramp 1 | A second concurrent WebSocket (`/ws/hub` beside `/ws/race/{room}`) from the same geo-fs.com page | It connects under the site's CSP. Two open sockets trip no browser or proxy limit | |
| LB 2.1 | Ramp **+ New room** (A). Overlay `out` counts `join` | A lands on the Gate of a new `quick-…` room. The room chip shows the code | |
| LB 2.2 | Departure board **Join** on A's room (B) | B lands on the same Gate. Both see 2 pilots and A's star | |
| LB 2.3 | Ramp **Have a room code? → Join** (B, after Leave) | Same room as LB 2.2 | |
| LB 2.4 | Ramp **Quick match** (B, with A's room boarding) | B is put in A's room, not a new one | |
| LB 5.3 | Quick match with nobody boarding | Starts a fresh room | |
| Ramp 2 | Three pilots on the Ramp | Rooms appear and update live (pilot counts, status pills, *starts in Ns* / *gate N — X leads*). Quick Match lands in the fullest boarding room. Ping reaches the other two as a toast. The empty state (nobody on the ramp) shows only Ping + Solo, not a blank table | |
| LB 5.1 | **On the ramp** list, both windows | Both pilots listed with what they're doing (`in <room>`, `racing <room>`, `flying solo`) | |
| LB 5.2 | Departure board | A's room listed with host, pilot count, status pill and the right action button | |
| LB 2.15 · LB 5.4 | Ramp **Ping** (B), then 4 pings in a day | A gets `PilotB pinged the ramp.` in the feed (`ping_ramp` on the hub). 3 go out. The 4th is refused with a toast saying when it resets | |
| Hub 6 | Ping for real, with three pilots | Three pings land for everyone else, not the sender. The 4th names when it resets. Two inside a minute get the cooldown message. The count survives a `race-api` restart (it's in SQLite) | |
| LB 2.16 | Departure board **Spectate** on a racing room (B) | B watches (`join` with spectate). B's card says SPECTATING | |
| LB 5.8 | Room TTL: everyone leaves a room | It stays on the board as *Reopen* for up to 10 min, then disappears | |
| Hub 5 | Watch one room's row through a whole race, then everyone leaves | `boarding → launching ("starts in Ns") → racing ("gate N of M — X leads") → results`, then `empty`. Rejoining the same code within 10 min lands in the same room with the same host | |
| Hub 4 | Presence with three or more pilots on the hub | The list reflects who's where within a second or two. A closed tab drops off within ~15 s, and so does a pilot who kills their network (the half-open socket the heartbeat exists for) | |
| LB 5.10 | Same pilot across reconnects: B reloads and clicks the bookmark | Same callsign accepted, no "already claimed" toast. `localStorage['finsRace.pilotId']` unchanged | |
| Hub 3 | Claim a callsign that already has runs on the board, then claim the same name from a second browser | The `pilot_id` matches the backfilled row and its runs still appear. The second claim is refused **by name** | |
| LB 2.20 | Top-bar callsign chip (B), on the Gate: click, type a new name, Enter | `rename` goes out. B's own chip/HUD show the new name at once. A's player list relabels with no reconnect. Both feeds show `PilotB is now <new name>`. Rename back afterwards | |
| LB 2.21 | Settings tab callsign field (A): type a new name, blur | Same as LB 2.20 (it's the same field). Rename back afterwards | |
| Ramp 3 | Two GeoFS tabs, same browser (same `localStorage`/`pilot_token`), both left open on the Ramp for 2 minutes | No "Ramp disconnected — reconnecting" flicker in either tab. Exactly one tab shows "ramp connected"; the other shows "Ramp is open in another tab" with a **Use ramp here** button, no flapping between the two states. Neither tab's callsign blinks on/off the other's presence list | |
| Ramp 4 | On the non-owning tab from Ramp 3, click **Use ramp here** | That tab takes over cleanly (connects, presence/rooms populate) and the previously-owning tab shows "Ramp is open in another tab" in its place, with no flicker on either side during the handoff | |
| Ramp 5 | With Ramp 3's two tabs still open, close the owning tab | The other tab claims ownership and connects within a couple of seconds, unprompted | |

## Gate: ready, vote, chat, host controls

| ID | Check | Expect | Last passed |
|---|---|---|---|
| LB 2.5 | Gate **READY UP** (B) | `ready` goes out. The button flips to `READY ✓` **at once**. A's card for B shows Ready | |
| LB 2.6 | **READY ✓** again (B) | Back to Not ready on both | |
| LB 2.7 | **Alt+Y** (B) | Same as LB 2.5. **No** dialog of any kind | |
| LB 2.8 | Quick chat **GG** (A) | B's Gate chat and HUD feed show `PilotA: GG` | |
| LB 2.9 | Typed chat + Enter (A) | B's Gate chat shows the **text** (it was blank in 1.3.x) | |
| LB 2.10 | Typed chat, B back to A | A sees B's text | |
| Hub 7 | Two pilots typing during a race | Lines arrive in order. A pasted 300-character line is truncated, not dropped. A burst of six is rate-limited with an error, not a disconnect. `pos` frames keep flowing throughout | |
| LB 2.11 | Vote tile (A, then B) | `vote` goes out. The tally bar and the `Your vote` badge move on both | |
| Gate 1 · Fix 2 · Hub 9 | Course vote with three pilots | The relay's drawn candidates appear as tiles, skewed toward courses the group has flown least. Votes move the bar live. A changed vote re-tallies. The winner on Launch matches the vote, or the host's pick when one was set. *Surprise me* resolves to a real course at launch | |
| LB 2.12 | Host **Set course** (A) | `course` goes out. Both Gates name the course, both ready flags clear, and the vote note says it's advisory | |
| LB 2.13 · RN 1.6 (force) | **Start anyway** (A, B not ready) | `start` goes out and the countdown starts. B spectates this race: standings + feed, no timer, pips or item slots, but the gates still render | |
| LB 2.14 · RN 1.6 (abort) | **Abort to gate** (A, during the countdown) | `abort` goes out. Both are back on the Gate. B's ready flag is **as it was** (abort keeps ready flags) | |
| LB 2.17 | Gate **Leave** (B) | The socket closes. A's Gate drops B. Loading any course on B afterwards does **not** rejoin (overlay: `sockets race 0`) | |
| LB 2.18 | Refusal surfaces (B, guest): console `__finsRace.lobby.startCountdown(10, true)` | A red toast: `Relay: host only` | |
| LB 2.19 | Offline send (B): DevTools Network → **Offline**, then click READY | A toast says `Ready not sent`. Go back Online afterwards | |
| LB 5.5 · Gate 2 | **Away:** B sits at the Gate for 60 s touching nothing | A sees `Away · 1 min` on B's card, and the ready bar says 1 pilot is away. Moving B's mouse brings back Not ready | |
| LB 5.6 · Gate 2 | Away vs Not ready at launch | The auto-start launches around an **away** pilot (B spectates) but **not** around a not-ready-and-not-away one. It fires once every engaged pilot has held ready through the debounce. **Start anyway** still force-starts immediately | |
| LB 5.9 · RN 6.2 | Host handoff: A (host) clicks Leave, or closes the tab | B gets the star, the course picker and Start anyway **at once**. A rejoins as a guest | |
| Gate 3 · LB 5.7 | Spectate a room mid-race | Standings, minimap and positions track the racers. No grid slot, no box grants, no ready/vote/chat-compose control. The spectator isn't counted toward "full". Results show racers only | |
| Hub 8 | Join with `spectate: true` while a race runs, then fill a room (12) plus spectators | The spectator is absent from the order and the race doesn't wait on them. The 13th *pilot* is refused. Spectators keep getting in | |
| RN 0.4 *(rollback UI)* | A types `PilotA` in *Leaderboard → Your name on the board*, then the room code in *Powerups → Room* (B doesn't yet) | The relay status says connected, and the lobby card shows one pilot, A, marked `★ host` | |
| RN 1.2 *(rollback UI)* | B types `PilotB` and the room code in the classic panel | Both lobby cards list two pilots with A as host. B's copy of the course loads on its own, with no *COURSE MISMATCH* | |
| RN 1.3 | B taps **GG** | It lands in both HUD feeds | |
| RN 1.5 *(rollback UI)* | Neither ready, then B and A press Alt+Y in turn | **Start countdown** stays disabled with *Waiting for everyone to ready up.* until both are ready | |

## One client, one socket, one UI

| ID | Check | Expect | Last passed |
|---|---|---|---|
| LB 3.1 | DevTools → Network → WS, a whole session in one room | Exactly **one** open `/ws/race/<room>` at a time (a reconnect closes the old one first) | |
| LB 3.2 | Reload with a room stored from last time | No race socket opens until you join from the Ramp | |
| LB 3.3 | Watch for the old floating plum lobby card or a ready-check dialog, the whole run | It never appears | |
| LB 3.4 | Solo tab, in a proto-5 room | No "Manual sync" countdown section, no "Room" box under Powerups | |
| LB 3.5 | *(only if an old server is up)* Join a room on a proto < 5 relay | A persistent red banner: `Server proto X, client needs 5` | |
| LB 3.6 | Console `document.getElementById('fr-root')` throughout the session, both windows | `null` on Ramp, Solo, Gate, Launch and results | |
| LB 3.7 | Settings tab | Leaderboard/callsign, Your plane, Sound and the Powerups loadout all present and working. Solo carries the ghost/rival pickers and the course editor | |
| LB 3.8 | Break the shell on purpose: `__finsRace.shell.buildRamp = () => { throw new Error('boom') }`, reload, click the bookmark | A `LOBBY FAILED` banner names the error. No classic panel appears. The HUD exists and a Solo run still times | |
| Shell | The panel on a real screen over the GeoFS canvas | The drag handle works. The default size and position suit a typical laptop viewport. **Copy invite** (or its textarea fallback) works under geo-fs.com's permissions | |

## Countdown, grid, teleport and rolling start

| ID | Check | Expect | Last passed |
|---|---|---|---|
| LB 4.1 | A voting room, no host pick: A votes, both READY | The host's auto-start fires about 3 s after the last ready | |
| LB 4.2 | Launch screen, both | Route map, `Green light in N` counting down, and a grid list with both pilots | |
| LB 4.3 | Overlay `clock offset` | A number, the same order of magnitude on both (the relay was ~1.8 s behind on 2026-09-23) | |
| LB 4.4 · RN 1.7 | **Film both screens** through the countdown | The countdowns are within ~150 ms of each other, and GO lands at the same instant | |
| LB 4.5 | Air-start course: the overlay `teleport` line on both | It names the placement method and `grid slot 1 of 2` / `2 of 2`, with one `[finsRace] teleport …` console line showing before/after. (Since 1.7.0 the method is `place()` via GeoPhysics, not `resetFlight`) | |
| LB 4.6 · RN 4.1 | Where you are after the teleport | A visibly staggered grid behind gate 1, about speed × lead back (the Launch card says how far), facing gate 2 and already flying. **Not** on top of the other pilot (80 m apart sideways, 30 m apart vertically) | |
| LB 4.7 | Hold what you were given until GO | You cross gate 1 at about GO, with no jump-start banner | |
| Launch 1 | The hold heading/speed/altitude cards through the countdown | They track smoothly. The reposition note names the real distance. Set/Moving per grid row flips to Set only once that pilot's `pos` has landed | |
| LB 4.8 | **Solo in a room:** one window, a code nobody else knows, vote, READY | A lone pilot starts on their own vote: countdown and teleport | |
| LB 4.9 | Overlay **Test grid slot 2 of 3** on an air course | Teleported. A toast names the method and the overlay shows the result | |
| RS2 | Rolling start in a 2-pilot room (air-start, proto 8) | Both are placed on the oval. A hands-off pace lap, a single-file exit ~45 s before green, and both cross the line near green | |
| RS3 | Green-flag throttle: the `rolling start green throttle` log line | Record whether `after` reached ≥ 0.9 without any `increaseThrottle` presses, or needed presses. before/after/presses: ____ | |
| RS5 | Touch the stick during the pace lap | That pilot drops to the back. No DQ. The *Out of formation* toast and pill show, and they can still finish normally | |
| SF1 | Click **Ready** (Gate) or **Start anyway**, then push the throttle up with no click into the sim first | Throttle moves in GeoFS at once — the shell no longer swallows the keypress just because a button has focus | |
| SF2 | Click into the GeoFS view while the shell is open (not on a button, card or toast) | The shell collapses to the reopen tab (click-away, `SHELL_CLICK_AWAY`) | |
| SF3 | Join a room; a 20 s countdown arms and places you on the grid or in formation | You're placed **and the shell collapses immediately** — well before GO. A big T-minus and a THROTTLE readout (green once it's above half, or once you've moved it) show in the HUD with the shell collapsed (`COLLAPSE_ON_SPAWN`) | |
| SF4 | **Alt+K** mid-countdown, after SF3's spawn collapse | The panel reopens and **stays open through GO** — it is not auto-collapsed again at the green light | |

## Air start and course env

`GeoPhysics.airStart` (`AIR_START_FLYTO`) and the course `env` block (`COURSE_ENV`), from the
airstart-env branch (race/README "Writing to the aircraft", "Course env"). Keep the Alt+D overlay
open: the `air start`/`approach start` facts carry the method, speed, throttle
before/after/presses, `pauseWaitMs` and `sinkM`. The `env` log lines say what was applied and
restored.

| ID | Check | Expect | Last passed |
|---|---|---|---|
| AS1 | **F-16**, solo, an air-start course (e.g. `hood-circuit`): Fly to start | Spawned with `flyTo` (overlay `method`), `COUNTDOWN_LEAD_S` of flying behind gate 1, facing gate 2. Flying at ~180 kt (min of pace and the F-16's 300). **Sink ≤ 50 m in the first 5 s** (`sinkM`). Throttle within 0.05 of 0.8. The autopilot is off after ~3 s. Record `G.aircraftId()` (`__finsRace._internals.G.aircraftId()`): it should be `7`. Otherwise fix `AIR_START_PROFILES`: ____ | |
| AS2 | The same in the **Piper Cub** | ~75 kt, not 180. Sink ≤ 50 m in 5 s, throttle at 0.8, no stall. Record `G.aircraftId()` (expected `1`): ____ | |
| AS3 | flyTo's pause, during AS1 | Record whether the sim **unpaused by itself** after flyTo (`pauseWaitMs` small, no "Press P" toast) or needed P. Unpaused by itself / needed P: ____ | |
| AS4 | 2-pilot rolling start (proto 8) on an air-start course | Both spawn on their oval slot with `flyTo`, there's no `formation_drop` during the spawn, the autopilot holds the pace lap, and green hands over as in RS2/RS3 | |
| AS5 | Solo tab → **Practice approach** → `sea-tac-16c` → Fly approach (C172 or F-16) | Spawned ~3 nm out on the 16C centreline, ~290 m (≈ 950 ft) above the threshold, heading ~162°, at approach speed (C172 ~65 kt, F-16 ~150 kt), throttle ~0.4. Autopilot off after ~3 s. The runway is ahead and a 3° path lands it | |
| AS6 | The same against a server **without** `/runways` (or with `API_BASE` blanked in the console) | The Practice approach block is hidden and the status line says why once. Nothing else breaks | |
| ENV1 | Solo: load `kai-tak-checkerboard` (dusk 18:45, clouds 40, wind 040/12, buildings on) | Dusk light, clouds, Kowloon's buildings. GeoFS's weather panel shows manual weather with ~12 kt from 040. The Solo tab shows `Scattered clouds · wind 040/12 · 18:45 local · buildings on` | |
| ENV2 | Restore: finish or DQ the run. Load it again and click **Leave** in a room. Load it again and reload the page | Each time, the weather, time of day and buildings go back to what you had before (live weather if that's what you had). GeoFS's own saved settings (reload twice) never show the course env | |
| ENV3 | Two clients in one room: the host picks `knik-glacier` v2 | **Both** clients get overcast + 8 kt from 130 without doing anything. The Gate's format chips show `Overcast · wind 130/8 · 12:00 local` on both | |
| ENV4 | Leaderboards: `gorge-run`, `hood-circuit` (cosmetic env only) and `knik-glacier` (wind) | Cascade/Oregon boards still show their old times (hash unchanged). `knik-glacier` v2 opens on a fresh board | |
| ENV5 | Against the **not yet redeployed** relay, vote-win or pick `kai-tak-checkerboard` v2 | It loads anyway (geometry-hash match), with one status line: *This relay is older than the weather…* No mismatch banner | |
| ENV6 | A time-only env (in the console: load a copy of any course with `env: {time: {localHour: 6}}`) | Dawn light. Record whether weather also changed when only time was set: ____ | |

## HUD and panel

| ID | Check | Expect | Last passed |
|---|---|---|---|
| RN 1.1 | Alone in a room with a course set | The position block and standings tower don't appear. The timer, gate pips, feed, speed/altitude and item slots all render | |
| RN 2.2 · Fix 6 | A run starts with no earlier spawn collapse to beat it to: a solo run crossing gate 1, or a ground-start lobby race reaching GO | The panel collapses **on** the green light, not a beat before (Launch stays readable). The HUD is usable at once. Reopening by hand (Alt+K) mid-run stays open for the rest of that run and isn't collapsed again at the next gate. (An air-start grid/formation race collapses earlier, at spawn — see SF3/SF4) | |
| RN 2.3 | Two pilots racing | The position block shows a real rank ("1ST of 2"). The tower lists both rows, with your own distinct. *Known limit:* the gap column says who's ahead, not by how much | |
| RN 2.4 · UI4 | **Alt+H**, then **Alt+K** at any time including mid-race | Alt+H hides/shows only the HUD. Alt+K collapses/reopens the panel even while the pill is hidden | |
| RN 2.5 | Narrow the browser under 900 px | The tower and feed collapse. Position, timer, gate, speed, altitude and items stay | |
| RN 2.9 | A grant and an incoming hit | Both appear in the top-right feed and fade after ~6 s. A loadout item in use drains a bar in its slot. The unfilled box slot shows a dim `?` | |
| RN 3.8 | Cross a gate faster, then slower, than your best split | The top-centre delta chip is **green**, then **red**, and goes after ~3 s | |
| RN 2.37 | Zoom `#fr-hud-timer` in DevTools while running. Block `fonts.googleapis.com`/`fonts.gstatic.com` | Solid digits on a dark pill with no doubled shadow edge. Still crisp with the fonts blocked | |
| Fix 5 | The collapsed reopen pill on a typical laptop viewport | It doesn't sit under GeoFS's own HUD, it's clickable, and collapsing really frees the view (no transparent block left behind) | |
| UI1 | Lobby → HUD → results | One product: Ramp, Gate, Launch, the HUD at GO and the results card share the plum panels, orange/pink accents and type. Nothing is left in the old navy/amber look | |
| UI2 | Mid-race in a 2+ pilot room over live terrain, at 1366×768 and 1920×1080 | No overlap: tower TL, timer TC, feed TR with toasts stacked under it, speed/alt BL, items BC, minimap BR. Toasts never reach the minimap. The FR pill sits just above speed/alt. 1366: ___ 1920: ___ | |
| UI3 | Webfont: with `THEME_WEBFONT` off, then load it live from the console: `document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;700&display=swap' }))` | Off: headings and numbers fall back to Bahnschrift and still look deliberate. On: Saira Condensed takes over, or nothing changes and nothing errors if the fonts are blocked | |

## Items and powerups

A leads and B trails a kilometre or so, so B is the one the box odds favour.

| ID | Check | Expect | Last passed |
|---|---|---|---|
| RN 2.6 | Item boxes in the world | Slowly rotating yellow cubes with a `?` (not spheres), at gate altitude, in rows off to one side of the line | |
| RN 2.7 | Fly through a box | The slot spins ~1.5 s. **Alt+3 during the spin does nothing** and says *Still rolling…*. The revealed item is what the feed names | |
| RN 2.8 | Two clients, the same box, a second apart | Only the first gets a grant. The box goes dark **on both screens** for ~6 s and fades back in on both | |
| RN 3.21 | A re-armed, idle pilot flies through a box | Nothing triggers: no split, and the gate counter doesn't move | |
| RN 2.10 | A presses **Alt+1** (Boost) | B sees an orange trail behind A. Only A sees the speed-line vignette | |
| RS4 | Boost, measured | About +50 m/s over ~1 s, capped at `BOOST_MAX_KT`. A second press while live does nothing. The trail looks the same | |
| RN 2.11 | A presses **Alt+2** (Shield) | B sees a translucent cyan bubble on A that flashes white when it eats something | |
| RN 2.12 | **Missile**, seen by both (film it) | A mustard projectile with a trail that lands at the same instant on both (more than ~150 ms apart means resolution isn't on one clock) | |
| RN 2.13 | The victim manoeuvres | The projectile visibly **curves** toward them | |
| RN 2.14 | Victim's screen | **MISSILE INBOUND from PilotX**, a draining bar, an arrow (an edge chevron off-screen), and a cue that speeds up as it closes | |
| RN 2.15 · LB 6.8 | Pop the Shield **during** the flight, then a beat too late on a second missile | In time: a white ring instead of a splat, no tint, and the feed says `PilotB's shield ate PilotA's Mustard missile` with sound. Too late: no block | |
| RN 2.16 | Holding a missile, overtake and fire from the lead | *No target ahead*, and the item stays in the slot | |
| RN 2.17 | **Banana** dropped | ~150 m **behind** the dropper: a yellow object with a pole to the ground, dim for ~1.5 s, then pulsing | |
| RN 2.18 | The pilot right on the dropper's tail | Isn't hit by a banana dropped in front of them (arming is what makes it fair) | |
| RN 2.19 | Fly straight through an armed banana at ~400 kt | You get hit (client-side detection. 2 Hz pings would miss it) | |
| RN 2.20 | Your own banana, and a banana with the Shield up | You never trip your own. With the Shield up it's cleared with no penalty | |
| RN 2.21 | Live bananas on the minimap | Shown, and gone when hit | |
| RN 2.22 | **Goop**, the victim's screen | The overlay's blobs drift down, and the last second clears **from the centre outward** | |
| RN 2.23 | Goop, the other cockpit | A green blob rides the goop'd plane for the whole duration | |
| RN 2.24 | Hit feel | A missile shakes the view ~0.5 s, then it sits exactly where it was. A banana shakes for less | |
| RN 3.18 | DevTools Rendering → *Emulate prefers-reduced-motion: reduce*, then take a hit | No shake. The tint, feed line and cue still land | |
| RN 2.25 | Late in a race: `__finsRace.items.layer.count()` (and `…layer.evicted`) | At or under 40, and back to **0** after both finish | |
| RN 2.26 | Frame rate with items live, vs the same view before loading the bookmarklet | Record both: items ____ plain ____ | |
| RN 3.17 | Anything *not run* above | Fly it on the next race | |

## Results and cups

| ID | Check | Expect | Last passed |
|---|---|---|---|
| RN 1.4 | Start a cup. Default shell: host console `__finsRace.lobby.startCup('Acceptance', 3)` (rollback UI: **Start cup** in the card) | The room reads *Cup: Acceptance · race 1 of 3* | |
| RN 2.1 | B leaves the start sphere **before GO** | The *JUMP START +5 s* banner. No DQ, and B keeps racing | |
| RN 2.27 | A finishes first | No status line ever shows `finish rejected: …`. If one does, record `__finsRace.lobby.offsetMs` on both | |
| RN 2.28 | While B is still flying, then B finishes | The card is up for A but **never over B's view**. Then both cards show the same order and times | |
| RN 2.29 | Two clocks | The card's time differs from A's panel timer by how long after GO A crossed gate 1. B's carries the +5 s. `/leaderboard?course_hash=…` shows the **gate-1 time**, matching the panel timer | |
| RN 2.30 | B's jump start | B's finish is accepted with the penalty, and *Jump starter* is in the awards | |
| RN 2.31 | Awards ring true | A landed missile counts as a hit taken and a hit landed. A shielded one counts as neither. *Clean race* shows only if somebody was hit | |
| RN 2.32 | The banner and the winner's sound, then sound off | `P2 · +12 pts`, and a fanfare over the finish cue. Both go quiet with sound off | |
| RN 2.33 | Card layout at a normal window, under ~640 px, and with the panel minimised | The table and the cup/awards column stack rather than overflow. Long names wrap. **Esc** and **Close** both dismiss it. It sits over nothing it shouldn't | |
| RN 2.34 | First run on a board | **New course record** on the winner's card on both, within ~4 s | |
| RN 3.22 | A slower winner on the same board | **No** badge. It agrees with `/leaderboard` | |
| RN 3.19 | A passes gate 2 and presses **Alt+R** | A is a DNF at a sensible gate, and the race **ends as soon as B finishes** | |
| RN 3.23 | Cup arithmetic after race 2 | Standings add up across both races, the same on both machines, and the room says race 3 is next | |
| RN 3.24 | Host **Next race**, then the host sets the next course (an air-start one) | Both are back on the Gate with every ready flag cleared, and the finished pilot is re-armed. When the host sets the course, both load it on their own. *(Rollback UI: the cursor lands in the host's course picker.)* | |
| RN 4.3–4.4 | A finishes. B reaches gate 2 and loiters | A's card shows **waiting for 1 pilot (mm:ss)** counting down, with B as a placeholder row, and it never covered B's view | |
| RN 4.5a | Wait out the two minutes | Results arrive with B as a **DNF at the gate B reached**. When B later crosses the line, B's status says the race is over **once** | |
| RN 4.5b | *Or*, short on time: close B's tab | B is a DNF at the last reported gate, and the race ends as soon as A is done | |
| RN 4.6 | The cup's third race | The card says **Cup final**, and the standings add up across all three. Afterwards the room shows no cup and the next race is a one-off | |
| RN 2.36 | **Race the winner's ghost**: B (guest) first, then A (host) | B: the Ghost picker names PilotA and **the room doesn't move**. A: the room goes back to the lobby. The panel says so if A's trace didn't upload | |

## Ghosts, racing line, bracket and minimap

| ID | Check | Expect | Last passed |
|---|---|---|---|
| RN 2.35 | After a finished run | **Ghost → Race against** offers **My best**, and `localStorage` holds `finsRace.trace.<hash>` and a one-entry `finsRace.traceIndex` | |
| RN 3.1 | Race the ghost | It's invisible in the start sphere, appears the instant you cross gate 1, and flies its recorded line. Slower: it pulls away. Faster: you pass it | |
| RN 3.2 | Translucency and label (unverified in-sim) | See-through (0.45), not solid. If it's solid, `Cesium.Model.color` isn't applying. Labelled `GHOST · <callsign> · <time>`. A pilot with no model gets the goldfish and the panel says *(stand-in model)* | |
| RN 3.3 | With another pilot connected | The ghost is never in the standings, never gets an item, never in the kill feed. The other pilot still renders correctly | |
| RN 3.4 | Let the ghost finish ahead | It parks at the finish gate | |
| RN 3.20 | Reset mid-race, then fly again | The stored trace is still the earlier best, and the ghost flies that line | |
| RN 3.5 | The racing line | Drawn ahead, ending ~4 km along the path. It slides forward instead of redrawing from the start | |
| RN 3.6 | Colour through a close stretch | Green when "vs ghost" is negative, amber inside ±0.30 s, red when positive, with no strobing around zero | |
| RN 3.7 | **Alt+L** mid-race, twice | The line disappears at once and returns. The race is untouched | |
| RN 6.3 | Alt+L off, reload, click the bookmark | The line is still off | |
| RN 4.2 | A course nobody has a trace for | A **dashed, neutral** line, and *Suggested line (no recorded run yet)* | |
| RN 3.9 | Waypoint bracket at several camera angles, including cockpit (the check that matters: `G.worldToScreen` is unverified) | The bracket sits on the next gate. If it never appears, `SceneTransforms.wgs84ToWindowCoordinates` isn't resolving, and the console is clean either way | |
| RN 3.10 | Turn until the gate is off-screen | An edge chevron on the correct side, matching the panel's ▲ arrow. It turns back into the bracket when you turn toward it | |
| RN 3.11 | Turn 180° away | A chevron on the side you'd turn toward, reading close to "turn left/right 180°" | |
| RN 3.12 | Low frame rate | The bracket still tracks smoothly (it's on the per-frame clock) | |
| RN 3.13 | Minimap | Bottom-right, north-up, the whole course fitted, your marker rotating with heading | |
| RN 3.14 | Minimap gates and box | Done / next / remaining in step with the 3D spheres and HUD pips. The box marker is where the box is | |
| RN 3.15 | The other pilot on the minimap | Their dot appears and moves (`standings.positions`) | |
| RN 3.16 | Frame rate with ghost, line, minimap and bracket on and the other pilot connected | Record: ____ fps | |
| RN 3.25 | **Race a friend:** a primary ghost plus a second one under **Race a friend** | Both fly with their own models and tags. The HUD grows a per-rival stack (green/amber/red) beside the primary's `vs ghost` readout | |
| RN 3.26 | A rival slot on a callsign with no trace (or kill the server mid-load) | A status line under that picker. The other ghosts and the race are unaffected | |
| RN 3.27 | **Copy challenge link**, opened in a genuinely fresh tab | Same course, same ghost(s) pre-picked, first name as primary | |
| RN 3.28 | **News banner:** B beats one of A's times, A reloads | *"\<B\> beat your \<course\> by N.NNs → Race their ghost"*. Clicking loads it with B as primary. ✕ dismisses it, and it doesn't reappear | |

## Solo, courses and editor

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Fix 3 | The Courses tab over the real `COURSE_BASE` | `race/courses/index.json` loads from raw.githubusercontent with **no server needed**. Every course is listed. Refresh picks up a newly indexed course without a page reload | |
| Fix 4 | Solo end to end with the relay unreachable (patched `API_BASE`) | Pick a course. Fly to start puts you on gate 1 already flying. The clock starts on leaving the start sphere and the run finishes. Only the final leaderboard POST fails, quietly | |
| RS1 | Solo air start (**Fly to start**) | Placed on gate 1 heading gate 2 at pace speed, arriving flying, no stall | |
| RN 6.4 | **Course editor:** Alt+B, then Alt+Shift+B, then **Save and load** | One box under the aircraft, then a row of three 120 m apart across the heading. The course's leaderboard is unchanged (boxes aren't in the hash) | |
| Course 1 | The Courses tab after the 2026-09-24 expansion | 69 courses, with cup and difficulty on every cup course. Refresh loads them all with no console errors | |
| Course 2 | Solo fly-through: `chamonix-midi` | Mer de Glace, Vallée Blanche and over the Col du Midi. Every gate is visibly clear of terrain, and nothing is hidden inside a ridge (Terrarium ~30 m smooths the narrow valleys) | |
| Course 3 | Solo fly-through: `reine-lofoten` | The fjords, including the 125° hairpin, are flyable at racing speed. Gates are clear of the walls | |
| Course 4 | Solo fly-through: `kai-tak-checkerboard` | The checkerboard turn is flyable. **Buildings:** note whether GeoFS draws Kowloon rooftops at or above the gate heights (terrain data has no buildings). If gates sit in buildings, re-fit it as v2 | |
| Course 5 | Solo fly-through: `denali-ruth-gorge` | The Great Gorge into the Don Sheldon Amphitheater. Gates at 850–1840 m MSL are clear of the gorge walls | |
| Course 6 | Solo fly-through: `budapest-danube-chain-bridge` (3 laps) | Both ~155–161° hairpins are flyable. The gates repeat in the same place each lap. **Bridges:** note whether GeoFS draws the Danube bridges at gate height (~55–60 m) | |
| Course 7 | The seven v2 repairs: `dells-narrows`, `madison-isthmus`, `apostle-caves`, `devils-lake-bluffs`, `three-sisters`, `star-wars-canyon`, `cabo-lands-end` | Each is clear of terrain all the way round (they were refitted on Terrarium only, because USGS was unreachable). Each shows a fresh, empty board (new hash) | |
| Course 8 | Structures on the remaining courses: `tokyo-bay-rainbow`, `shimanami-straits`, `giza-pyramids`, `great-wall-ridge`, `diamond-head-waikiki`, `paris-le-bourget-1927` | No gate sits inside a bridge, a tower, a pyramid or the wall as GeoFS draws them. Note any that do in the sign-off | |
| Course 9 | A Pylon Cup circuit (e.g. `lake-hood-floatplane-circuit`) | The unrolled laps fly as one gate sequence, and the gate count matches CUPS.md's laps × gates + 1. There's no lap counter on the HUD (expected: native laps aren't built, see race/docs/LAPS.md) | |
| Course 10 | A Bush Cup ground start (e.g. `stehekin-lake-chelan-bush`) in a light aircraft | You start on the ground at the named strip, gate 1 is reachable after take-off, and the finish is a low pass. With `aircraftId: null`, any aircraft is accepted (expected until the ids are filled in) | |
| Model 1 | **Your plane:** each new model in turn: rubber duck, cheese wedge, beer stein, pizza slice, flying couch, shopping cart | Each is nose forward, upright and about F-16 sized. A rotated one is fixed with its `offset` in `models/index.json`, not the mesh. The beer stein lies on its side mouth-forward, the couch flies armrest-first and the cart flies handle-aft (by design) | |

## Failure drills and compatibility

Only with everyone told: the first drill kills the live relay.

| ID | Check | Expect | Last passed |
|---|---|---|---|
| RN 5.1–5.2 | Both past gate 1 in a race, then `docker kill race-api` (or `race`) on the box | The timer, gates, pips and HUD carry on. Nobody is DQ'd or stuck. The relay status reads *reconnecting in Ns (loadout still works)* with the wait growing. No lobby card appears mid-race. Boost and Shield still fire. Boxes and offensive items are off | |
| RN 5.3 | Items on screen at the kill | They vanish within ~12 s, and `__finsRace.items.layer.count()` returns to 0 | |
| RN 5.4 | `docker ps --filter name=race-api`, and `docker start …` if it isn't back in ~5 s | Both clients reconnect **without a reload**. The room is fresh (lobby phase, the first back is host, ready cleared). The race in progress is gone | |
| RN 5.5 | Both finish the race they were flying | One `finish rejected: no race in progress`. No console error spam. The run still posts to `/leaderboard`, and the trace still saves locally | |
| RN 5.6 | `/races/recent` | Races finished before the kill are still listed, with the cup name. The killed race is absent | |
| RN 5.7 | *(if there's time)* Kill during a countdown | The countdown overlay goes away (the reconnect loop takes over) and nobody is left DQ'd. *(Rollback UI: the manual countdown is still under Manual sync.)* | |
| RN 5.8–5.10 | **Stale client:** B loads the `race-v0.5.0` client (bookmark below) and joins the room | No console error on either side and no traceback in `docker logs --tail 50 race-api`. B is listed but **never ready**. A force-starts and races alone, and A's results don't wait for or list B. B's own panel keeps working (it sees no boxes: 0.5.0 reads `itemBox`, which is expected). B reloads on the current bookmark and can ready up again | |
| Hub 10 · Modes 2 | An older client (1.1.0 / 1.3.1) against the current relay | It joins, races, uses canned chat, finishes and is scored. No error frames in DevTools → WS, and nothing new drawn. It ignores `joined.proto`/`mode` | |

The stale-client bookmark for RN 5.8:

```text
javascript:(()=>{if(window.__finsRace){window.__finsRace.ui.toggle(true);return;}const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/eburgard7-cloud/geofs@race-v0.5.0/race/race.js';s.onerror=()=>alert('FINSONLY Racing failed to load');document.head.appendChild(s);})()
```

## Public site and server data

| ID | Check | Expect | Last passed |
|---|---|---|---|
| RN 6.1 | Open `https://race.finsonly.net/` with the Network tab open | Course records, recent races (with cup names) and open cups' standings. It requests one host only (plus Google Fonts) and refreshes on its own. `/races/recent`, `/cups?open=1` and `/cups/<id>` agree | |
| LB 5.11 | Chat is never stored: after LB 2.9, on the box: `sqlite3 <race.db> ".dump" \| grep -c '<your text>'` | `0` | |
| Hub 1 | From outside the LAN: the `curl -i -N` upgrade one-liner, then `python race/tools/hub_smoke.py wss://race.finsonly.net/ws/hub` | `HTTP/1.1 101`, then every hub check ok | |
| Hub 2 | The pilot migration on the real `race.db` (after a backup) | `SELECT COUNT(*) FROM pilots` ≈ distinct callsigns on the board. `SELECT COUNT(*) FROM runs WHERE pilot_id IS NULL` is 0. Existing `/leaderboard`, `/ghosts` and `/races/recent` responses are unchanged. `PRAGMA integrity_check` says `ok` | |
| Modes 1 | After `redeploy.sh`: `runs` vs `mode_runs WHERE mode_id='race'` | The counts match, and a second `migrate_modes.py` run prints `0 backfilled` | |
| Deploy 1 | After the first deploy with the runway loader: `docker logs race` (or `race-api`) | `runways loaded: 26 from /app/runways`. A count of 3 means the runways mount is missing (it fell back to the embedded runways). `curl -s "https://race.finsonly.net/landing-leaderboard?runway_id=tncm-10"` answers 200 | |
| Deploy 2 | After a passing deploy: `tail -3 <DATA_DIR>/deploy.log` and `docker images race` | One `PRUNE images_reclaimed=… backups_removed=… backups_kept=…` line. `race:prev` is still listed. At most 10 `race.db.bak-*` files are left | |
| Tiles 1 | Open `https://race.finsonly.net/#/` (the globe) with the Network tab open, first load and a repeat load | Every tile request goes to `race.finsonly.net/tiles/…`, none to `s3.amazonaws.com`/`arcgisonline.com`/`eox.at` directly; the CSP has no third-party img-src host. Second load is visibly faster (disk cache hits) | |
| Tiles 2 | `RACE_IMAGERY=eox` on the deployed box, then reload the globe | Visibly different imagery (Sentinel-2 cloudless look); `GET /tiles/attribution` reports the EOX credit | |
| Tiles 3 | `python race/tools/prefetch_tiles.py --base-url https://race.finsonly.net` a few hours before a race night, then the first pilot's globe load | No visible cold-tile stall; `du -sh <DATA_DIR>/tiles` grows and stays under `RACE_TILE_CACHE_MB` over a week of normal traffic | |
| Tiles 4 | After the first deploy of 1.6.3: `docker logs race 2>&1 \| grep "tile warm"` (about 10 min after start), then `ls <DATA_DIR>/tiles/.warm-manifest.json`, then restart the container and grep again | One `tile warm done: fetched N, …, failed 0` line, the manifest lists `global-z0-z2` plus every course hash, `<DATA_DIR>/tiles` gains only `terrain/` files from the warm (no new `imagery-*`/`labels` dirs before anyone opens a globe), and the second boot says `fetched 0 … new []` | |
| Tiles 5 | Add a course far from every other one, deploy, wait for the warm line, then open its globe for the first time | The terrain appears without a visible cold stall; imagery still loads on demand | |
| Tiles 6 | With the globe open on a never-viewed course, hit `/leaderboard` and `/health` in another tab | Both answer promptly while the cold tiles stream in (the tile fetches no longer share the sync route threadpool) | |
| Replay 1 | Once race.js sends a `finish`/`dnf` trace (a future client change — see PROTOCOL.md "Proto 9"): run a lobby race, then `GET /races/{id}/replay` | Every finisher who sent a trace appears in `traces`, decodes to a sane flight path | |
| Records 1 | `python race/tools/backfill_records.py --db <DATA_DIR>/race.db --dry-run` on a copy of the live `race.db`, then for real | The dry-run count matches what actually inserts; `GET /records/history?course_hash=…` on a well-raced course shows a believable "who took it from whom" history | |
| OG 1 | Paste a `https://race.finsonly.net/share/course/<id>` link into Slack or Teams | The unfurl shows the rendered OG image (route line, course name) and title, not the generic site card | |
| OG 2 | Same for `/share/record/<course_hash>` | Shows the current record holder and time in the image text | |
| HQ 1 | Click every top-nav tab (Courses, Records, Cups, Landing, Install) fresh from a hard reload | Each one renders its own page; none shows "This page failed to load" | |
| HQ 2 | On a course with a ghost, "Watch the record"; then force the 2D fallback (block the tile hosts, or `RACE_TILE_PROXY=false` on the deployed box) and repeat | Opens the 3D replay theater and plays. The 2D fallback is the same theater — timeline, splits, delta chart — as a top-down map | |
| HQ 3 | Scrub the replay timeline partway, hit "Copy link at this moment", open the copied link in a new tab | The theater opens paused at that same moment (±0.1 s) | |
| HQ 4 | From a cup with a finished, traced race, "Watch race" | `#/replay/race/<id>` plays the lobby race's own traces in finishing order, DNFs last | |
| HQ 5 | On any pilot page, "Download card" | A `finsonly-<callsign>.png` downloads and opens as a real 1200×630 image with the license's own numbers on it | |
| HQ 6 | Compare `/#/records`' course-record table against `GET /leaderboard?course_hash=<hash>` for a few raced courses | Same holder, time and pilot count on both | |
| HQ 7 | `/#/landing` | Runways group under their `LANDING_CUPS.md` cup headings (White-Knuckle, Beach & Island, Mountain, Home, Bush Strips), with any runway not in a group under "Other runways" | |
| HQ 8 | Beat an existing course record (a faster run than the current holder), then reload `/#/records` | The new time appears at the top; the "Dethroned" feed shows "X took Y from Z" for it within the next poll | |

## Landing tools

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Landing 1 | `probe.js` "touchdown inputs" on the ground, on a slow descent and through a touchdown | Paste the report into the PR. It decides recorder.js's `FIELD_MAP` for `agl_m`, `vs_mps`, `ias_mps`, `on_ground_bool` | |
| Landing 2 | `recorder.js` with a filled `FIELD_MAP`: one smooth and one firm landing | No `null` in any field while airborne. `on_ground_bool` flips once per contact. The file downloads | |
| Landing 3 | `replay_landing.mjs` on both | Exactly one `touchdown` and one `settled` per landing. The firm one's `vs_at_contact` is clearly more negative. A deliberate bounce shows as `bounce` | |
| Landing 4 | `POST /landings` with both on the deployed box | The smooth one outscores the firm one. `GET /landing-leaderboard?runway_id=…` shows both. Every race `/leaderboard` is unchanged. Then tune `LANDING_*` | |
| Runway 1 | One landing on each world-pack runway (`vnlk-06`, `vqpr-15`, `lflj-22`, `tncs-12`, `tffj-10`, `tncm-10`, `lpma-05`, `lxgb-09`, `nzqn-05`, `lowi-26`, `kase-15`, `ktex-09`, `keug-16r`, `kpdx-10r`, `kmsn-36`, `mmsd-34`), recorded with `recorder.js` and replayed against the runway file | GeoFS's runway sits where OurAirports says: a centreline landing's `cross_m` ≈ 0 and its touchdown is in the zone. Note any runway that's offset | |
| Runway 2 | `lflj-22` (Courchevel) and `tncs-12` (Saba) specifically | 22 is the **uphill** landing at Courchevel (the famous one). Saba's elevation and heading, which were computed rather than taken from OurAirports, match the sim | |
| Runway 3 | One landing on each bush strip (`3u2-35`, `3u2-17`, `patk-01`, `s10-02`, `pamr-26`, `s81-04`, `s81-22`) | Same as Runway 1. `patk-01`'s heading is ~027° (OurAirports' 207° was the reciprocal) | |

## Landing challenge

The Landing tab (`CONFIG.LANDING`, race.js `LandingMode`), against the deployed server. Unit tests
cover the logic. These rows cover what only the sim can show. How to fly it:
[runbook, Landing night](../docs/RUNBOOK.md#landing-night).

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Landing 5 | First in-sim run: F-16 on the Sea-Tac ramp, then `__finsRace.dev.G.haglM()`, `.vsFpm()` and `.groundContact()` in the console, on the ground and in a gentle descent | `haglM` is metres above ground (≈ 0–3 on the ramp). `vsFpm` is ft/min and negative descending (compare the GeoFS VSI). `groundContact` is `true` on the ground and `false` airborne. Paste any mismatch: these are the names the HUD and detector read | |
| Landing 6 | **Landing** tab | Runways grouped White-Knuckle / Beach & Island / Mountain / Home / Bush Strips / More runways. Difficulty chips. Your best and the top 3 appear under the picked runway | |
| Landing 7 | **Full loop, `sea-tac-16c`, F-16**: Fly approach | Spawned ~3 nm out, on the 3° path (HUD dots near centre), ~150 kt, throttle ~0.4, **hands-on** (autopilot off after the short hold). Shell collapses | |
| Landing 8 | Same approach: the Landing HUD | Ident `SEA-TAC-16C`. The distance counts down. The LOC diamond moves toward the side the centreline is on (fly toward it), and the GS diamond drops when you're high. The sink figure matches the GeoFS VSI. The pill goes CHECK/UNSTABLE when you dive or fly off the centreline | |
| Landing 9 | Same: land in the zone and roll to a stop | One scorecard after stopping. Its score and every penalty equal the `POST /landings` response in DevTools Network, and the request body has no `score` field. PB and rank match `GET /landing-leaderboard?runway_id=sea-tac-16c` | |
| Landing 10 | **Retry**, then a deliberate go-around from ~50 ft, then land | Retry respawns at once. The go-around doesn't score, and the status line says the attempt carries on. The later landing scores once | |
| Landing 11 | **`tncs-12` Saba, short field** (Cub or Beaver) | The spawn is flyable. Touchdown and settle are detected on the 348 m strip. A long landing shows a real rollout penalty | |
| Landing 12 | **`lflj-22` Courchevel, upslope** (Beaver) | Note what happens on the ~18 % slope: does `groundContact` flip once, is a bounce reported, does it settle? Record the scorecard and whether the flat-runway scoring feels fair (LANDING_CUPS.md "Caveats") | |
| Landing 13 | **Env restored**: set your own weather (e.g. clear, no wind), give a dev copy of a runway an `env` (wind 270/15), fly it and finish | Wind on during the attempt. After the scorecard your own weather and time are back, and nothing was saved to GeoFS preferences | |
| Landing 14 | **Alt+H / Alt+I** during an approach | Alt+H hides and shows the Landing HUD with the race HUD. Alt+I still reaches GeoFS and hides its instruments (race.js never binds it) | |
| Landing 15 | **Landing Cup**: Home Cup | Four runways in order. Next runway only, no Retry. The last card is the cup total, which equals the four scores | |
| Landing 16 | **Aircraft lock**: a dev copy of a runway with `"aircraftId": "13"`, flown in the F-16 | Fly approach refuses with *… is DHC-2 Beaver only: switch aircraft …*. It works after switching | |
| Landing 17 | **Provisional approach overrides**: `vnlk-06`, `vqpr-15`, `lpma-05`, `3u2-17`, `3u2-35`, `s81-04`, `s81-22` (Beaver) | The spawn isn't inside terrain, and the approach can be flown to the runway. Confirm each with the robot's APPROACH mode (Robot 6), then remove PROVISIONAL from the runway's notes | |
| Landing 18 | Against a server **without** this branch (old `/runways`, no extra fields) | The tab still lists runways (all under "More runways"), flies and scores. With no `/runways` at all it shows one note and nothing to fly | |

## Landing score v2

The 2026-09-24 Portland 10R bug (breakdown zone -178, sink -1794 at 1744 fpm, scored 0) and its
fix: a capped, calibrated sink-rate curve, the `vs_geom_mps` sanity check, and the scorecard's new
fields. `CONFIG.VERSION` does not bump until these pass (race/CHANGELOG.md "landing-score-v2").

| ID | Setup | Expect | Notes |
|---|---|---|---|
| Landing 19 | `sea-tac-16c`, F-16: land it normally, on speed and in the zone | Score 600-900, no HARD LANDING badge, rank shown (not "unranked") | |
| Landing 20 | Same runway, deliberately firm (flare late/not at all) | Score roughly 300-500 (lower than a mid-sim calibration run predicts alone — a firm approach is rarely *only* a hard sink; some zone/centreline slop is normal). **HARD LANDING** badge appears once the GeoFS VSI reads at/above ~1000 fpm at contact | |
| Landing 21 | Debug overlay (Alt+D) open, three landings of varying firmness | Each shows a `vs_at_contact`/`vs_geom_mps` pair. Record all three (fpm) in the sign-off table below: how closely do they track, and does either ever look obviously wrong (a spike, a stuck reading)? | |
| Landing 22 | A deliberately bouncy landing with no vs_geom_mps mismatch, and (if reachable) a landing with a laggy/spiky GeoFS VSI reading | The scorecard shows both sink readings only when they differ by more than 25%; otherwise just the one, scored, number | |
| Landing 23 | Scorecard on any scored landing | The "Aim zone `min`-`max` m" row matches the runway's `zone` from `GET /runways` | |
| Landing 24 | A crash-grade landing: very firm, well off the zone, off centreline, with a bounce | Score is low (double digits to ~150) but check whether it ever lands exactly on 0 — the fix's intent is "rarely 0", not "never" | |

## Robot test pilot

The ROBOT dev bookmarklet (`race/tools/robot_pilot.js`) on a throwaway flight. It writes to the sim.
See the [runbook](../docs/RUNBOOK.md#robot-test-pilot).

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Robot 1 | Click ROBOT **before** FINSONLY Racing, then after it | Before: an alert saying to load FINSONLY Racing first. After: the orange-bordered panel with the course/runway counts. A second click re-shows the same panel | |
| Robot 2 | COURSE, one: **`hood-circuit`**, F-16 | Air-starts before gate 1, climbs/turns gate to gate on the autopilot, **PASS** with a time. Watch the bank: if GeoFS's autopilot banks much less than 25°, note it (ROBOT.BANK_DEG) | |
| Robot 3 | COURSE, one: **`starter-sprint-seatac`**, F-16 | **PASS**. The course's aircraft lock (7) is honoured | |
| Robot 4 | COURSE, a whole **cup** (e.g. Cascade Cup), unattended | Every course gets a row. Your own weather is back after each env course. **Download JSON**, then `python race/tools/robot_report.py <file>` writes `docs/reports/<date>/ROBOT.md` with a table and a suggested-fix list for anything that failed. Nothing in `race/courses/` changed | |
| Robot 5 | A batch spanning two aircraft (e.g. a Bush Cup course plus an F-16 course) | Pauses with *Switch to aircraft id N…*. Continue after switching flies them. Continue without switching gives **SKIPPED(aircraft)** | |
| Robot 6 | APPROACH, one: **`sea-tac-16c`** | Descends the virtual ILS to 50 ft AGL on the centreline (report `at50.crossM` within ~10 m), then goes around (full throttle, climbs to threshold + 1500 ft). **PASS** | |
| Robot 7 | APPROACH, **White-Knuckle** landing cup | One row per runway. vnlk-06 / vqpr-15 fly their provisional overrides. Record each TERRAIN / OFFSET / SPAWN_LOW honestly in ROBOT.md, and don't fix blindly | |
| Robot 8 | `__finsRace.dev.G.nearestRunway(47.43, -122.31)` at Sea-Tac (TODO-PROBE) | Paste the keys it returns. If none of lat/lon/threshold/heading parse, `geofsOffset` stays null and OFFSET never fires. Report the real field names | |
| Robot 9 | **House ghost**: with `RACE_ADMIN_TOKEN` set on a dev/deployed server, upload a PASS | `/ghosts?course_hash=…` lists `HOUSE` with `is_house: true` and `is_course_record: false`. The site's course page shows a *House* chip with no medal, and the replay plays it. It's absent from `/leaderboard`, `/records/history`, `/pilots` and cups. A wrong token gets 401, and no token configured gets 503 | |

## Physics Lab discovery

Throwaway flights only, never during a race. Load the **LAB** line. None of this has been run on
geo-fs.com yet. Paste each **Copy report (JSON)** back into the PR. See
[RUNBOOK → Physics Lab sections](../docs/RUNBOOK.md#physics-lab-sections).

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Lab G0 | GRAPHICS DISCOVER | Every Cesium setting reads a value (none `undefined`). The options-panel inputs are found, which settles whether the attribute is `data-gespref` | |
| Lab G1 | **write ALL** (A/B/A, ~6 min), in **straight-and-level cruise on autopilot** | Each setting is labelled STICKS / REVERTED / CHANGED with A/B/A frame rates (rAF and `geofs.debug.fps`), and every restore holds. No `NOT STEADY` in the notes. MSAA/HDR/bloom are skipped, not written | |
| Lab V | Physics test **4d. Speed rigidBody velocity** | `applied.path` is `rigidBody.setLinearVelocity([E,N,U])` (never `getLinearVelocity`), and kias rises by ~50 m/s worth | |
| Lab E0 | ENV DISCOVER | `weatherPrefs` has `manual`, `localTime`, `season` and `advanced` with `windSpeedKts`. `weatherFunctions` includes `setAdvanced`, `setDateAndTime`, `refresh`. `setBuildings` is a function | |
| Lab E1 · E2 | Apply sample env, look, then Restore env | E1: overcast, fog, wind 270/15, dusk, buildings on, `held` = `weather+time+buildings`. E2: everything back, and `prefs identical` | |
| Lab G2 | Toggle one GeoFS graphics setting | It lists which Cesium settings GeoFS's own option drives, and the input is put back | |
| Lab R0 | RUNWAYS DISCOVER at a big airport (e.g. KSEA) | It finds a runway container, and the nearest 5 records have plausible lat/lon/heading. Note the units of length/width. It lists what the takeoff/approach buttons call | |
| Lab R1 | Export nearest runway, then compare with the matching `race/runways/*.json` (e.g. `sea-tac-16c`) | Threshold within tens of metres, heading within a few degrees | |
| Lab R2 | Try approach start here (confirm first) | It reports the function called and where the aircraft ended up. Nothing throws | |
| Lab A0 · A1 | AIRCRAFT DISCOVER, then Copy aircraft list | A catalogue with ids and names, including the current aircraft. **Confirm** the ids the Bush Cup v2 locks use (`13` = DHC-2 Beaver, `1` = Piper Cub) and the ones `AIR_START_PROFILES` assumes (`2` = Cessna 172, `7` = F-16). Fix race.js / the course files if GeoFS numbers them differently | |

## Tablet

Android tablet (Firefox for Android, landscape) plus the desktop regression rows, for the
`tablet-mode` branch. While testing the branch, load race.js and the DEV tools from `tablet-mode`
instead of `main` (edit the bookmark URLs). IDs follow the tablet spec's numbering; rows land with
the phase that makes them testable.

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Tab 0a | On the tablet, with GeoFS's top bar and instrument panel showing, run the **PROBE** line and paste back `uiLayout` | `viewport` shows `coarsePointer: true`; `elements` includes GeoFS's instrument panel, top bar, bottom bar, right-side buttons, touch stick and throttle with plausible rects. The instrument-panel selector is the one `HIDE_GEOFS_INSTRUMENTS` will target | |
| Tab 0b | Mid-course, straight and level at a known speed/altitude, run **TABLET DIAG** and paste back the JSON | Shows which read matches GeoFS's own airspeed and altitude gauges, next to what the race HUD printed. Decides the speed/alt readout's source | |
| Tab 2a | Tablet: load the mod, fly a course with a gate passing close to the right edge of the screen | No white strip down the right side, the page never zooms out, and nothing FINSONLY sits outside GeoFS's canvas. PROBE `uiLayout.viewport.docWiderThanWindow` is `false` mid-race | |
| Tab 2b | Desktop, DevTools console open: resize the window narrow and wide, rotate a device-emulated view, fly a course | No `[finsRace] layout:` warning. If one appears it names the element; record it here | |
| Tab 2c | Tablet, solo course, landscape: take a screenshot mid-race with GeoFS's top bar, bottom bar, instruments, right-hand buttons, touch stick and throttle all showing. Attach it here | The race HUD overlaps **no** GeoFS control: one pill ("P · time · Gate n/N · kt · ft") centred just under GeoFS's top bar, the item tray as an icons-only column in free space on a side, a small MAP button, no big timer plate, no speed/alt box on the compass | |
| Tab 2d | Tablet: fly so the next gate is off-screen to the left, then to the right | The turn cue and its arrow sit centre-screen under the pill, never at the left or right edge over the stick or throttle | |
| Tab 2e | Tablet: tap MAP, then tap it again | The minimap opens in free space (not over GEAR/BRAKE/FLAPS) and folds away. The camera does not pan on either tap | |
| Tab 2f | Tablet: trigger two notices in a row (e.g. ready up with no course, then join a full room) | One toast at a time, top-centre under the pill, gone in ~3 s; tapping it removes it at once | |
| Tab 2g | Tablet: rotate to portrait and back to landscape mid-race | The pill, tray and MAP button re-place themselves clear of GeoFS's UI after each rotation | |
| Tab 3a | Tablet: fly a whole solo air-start course using only the touch bar for FINSONLY (Fly to start, Boost/Shield buttons, Minimap) | Every tap does its one thing; the camera never pans and GeoFS's stick/throttle never jump from a tap on a FINSONLY button. The bar sits clear of every GeoFS control | |
| Tab 3b | Tablet: tap **Fly to start** and **Reset** briefly, then press-and-hold each | A tap does nothing; a ~1 s hold fills the button's bar and then fires once. Neither is offered while in a lobby room (Fly to start) | |
| Tab 4c | Tablet, lobby room: the bar shows Ready / Panel / Chat. Tap Ready, then Chat | Ready toggles your ready state for everyone; Chat opens the panel on the chat field with the keyboard up | |
| Tab 4a | Tablet, in a lobby room: type a chat message and your callsign with the on-screen keyboard | The field you're typing in stays visible above the keyboard the whole time; the panel gets its full height back when the keyboard closes | |
| Tab 4b | Tablet: open the panel (dashboard) before a start, then tap anywhere on the sim outside it | It collapses on that one tap. Every panel button, tab and field is easy to hit with a thumb (no misses on small targets) | |
| Tab 8a | Desktop: every Alt hotkey in docs/REFERENCE.md (R, G, U, H, K, B, Shift+B, L, 1, 2, 3, Y, D) | Each does exactly what it did in 1.7.x. Alt+I still reaches GeoFS and hides its instruments | |
| Tab 8b | Fresh browser profile (no saved loadout): open the race HUD | Item tray reads Boost, Shield, Box. Picking Boost + Boost in Settings still works and persists | |

## Needs more than the standard run

| ID | Check | What it takes | Last passed |
|---|---|---|---|
| Ghost 8 | The 25-minute trace cap | Fly past 25 min, or lower `TRACE_MAX_SAMPLES` in a patched copy. The panel reports the cap, and nothing new is saved | |
| Ghost 20 · Items 24 | Strict frame-rate A/B | Load a patched copy with the features off (below) and compare to a normal load. Worse by more than a few fps: check the line rebuild rate (2/s) and the minimap (3–4/s). For items, check the trail rebuild and banana pulse. *Items 24 wants five pilots* | |
| Items 22 | The speed penalty, only if `POWERUP_SPEED_PENALTY` is being considered | Patched copy with it on. Take a missile at cruise: about −25% speed held for 1.5 s, no stacking, nothing below 150 m AGL, cancelled by Boost, **no DQ**. Leave it off unless all five hold | |
| Results 29 | A close finish decided by the crossing, not the frame | Two pilots within ~50 ms on different frame rates. The card's order is the crossing order. If not, check `finishGoTimeMs` against a recording | |
| Results 32b · 33b | Alt+R **during the countdown**, and a *finisher* who closes the tab before results | Nothing on the status line until the race starts, then one DNF. The finisher keeps their finish. (Covered by `run.js` and `test_server.py`) | |
| Ghost 21 · Ghost 19b · Items 25 · Results 43 | Against an **old relay** (pre-0.9.0 / 0.10.0 / 0.11.0 in a scratch container on another port, never the live one) | The status line names the proto. Nothing from the missing layer draws or is sent. `/ghost` 404s read as *no ghost recorded*. **My best** still works. With no `standings.positions`, the minimap shows no other racers and no error. Pre-0.11.0: no `finish`/`dnf`/`cup`/`rematch` frames, and a local card with no points | |

The frame-rate A/B loader. Paste it into the console instead of clicking the bookmark, and edit
the flag list (only `ITEMS` for Items 24):

```js
fetch('https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/race.js?t='+Date.now()).then(r=>r.text()).then(t=>{const s=document.createElement('script');s.textContent=t.replace(/(GHOST|RACING_LINE|MINIMAP|WAYPOINT_BRACKET): true/g,'$1: false');document.head.appendChild(s);})
```

**Known, deliberate gaps (not bugs):** there's no season rank, points or cup-win count anywhere
(no endpoint, and the Season tab is hidden behind `CONFIG.SEASONS`). The Gate shows no "N open
slots" (the room's real pilot cap is never sent). Vote-tile terrain badges come from the
hand-maintained `KNOWN_TERRAIN_STATUS` in `race.js`, not a live field.

## Race-night run order

About 30 minutes, two pilots, in this order. It's the old race-night script, pointing at the rows
above. If Race 1 runs past 12 minutes, use RN 4.5b instead of the two-minute wait.

| Part | ≈ min | Rows |
|---|---|---|
| 0 Preflight | 3 | [Preflight](#preflight) |
| 1 Lobby | 5 | LB 2.1–2.14, RN 1.4 (start a 3-race cup), LB 4.1–4.4 |
| 2 Race 1: Starter Sprint, items on (A leads) | 8 | RN 2.1, RN 2.2–2.5, RN 2.9, [Items](#items-and-powerups), RN 2.27–2.37 |
| 3 Race 2: Starter Sprint, ghosts on (B leads) | 6 | RN 3.1–3.28 |
| 4 Race 3: an air-start course, Teleport on | 5 (+2) | LB 4.5–4.7, RS2–RS3, RN 4.2–4.6 |
| 5 Failure drills | 6 | RN 5.1–5.10 |
| 6 Wrap | 3 | RN 6.1, LB 5.9, RN 6.3, RN 6.4 |

## Sign-off

| | A | B |
|---|---|---|
| Date / commit or tag | | |
| `__finsRace.version` / relay proto | | |
| `__finsRace.lobby.offsetMs` | | |
| Browser / OS | | |
| `smoke_lobby.py` | ☐ pass ☐ fail | |
| fps: items live / plain GeoFS (RN 2.26) | | |
| fps: all ghost features on (RN 3.16) | | |
| Result | ☐ release ☐ hold | |

Rows *not run*: ____________________ Rows failed (with console output): ____________________

## History: original check numbers

The race-night script folded older per-area checks into its numbered run. Where each one went, for
old notes that cite them (HUD, Lobby and Ghost restart at 1; Items are 1–25 and Results 26–43):

| Original | Now | Original | Now |
|---|---|---|---|
| HUD 1 | RN 1.1 | Ghost 12 | RN 3.7, RN 6.3 |
| HUD 2 | RN 2.3 | Ghost 13–16 | RN 3.9–3.12 |
| HUD 3 | RN 3.8 | Ghost 17–19 | RN 3.13–3.15; older relay: Ghost 19b |
| HUD 4 | RN 2.2 | Ghost 20 | RN 3.16; A/B: Ghost 20 |
| HUD 5 | RN 2.4 | Ghost 21 | Ghost 21 |
| HUD 6 | RN 2.5 | Items 1–3 | RN 2.6–2.8 |
| HUD 7, 8 | RN 2.9 | Items 4 | RN 3.21 |
| Lobby 1 | RN 1.7 → LB 4.4 | Items 5 | RN 6.4 |
| Lobby 2 | RN 6.2 → LB 5.9 | Items 6–10 | RN 2.12–2.16 |
| Lobby 3 | RN 5.2, RN 5.7 | Items 11–15 | RN 2.17–2.21 |
| Lobby 4 | RN 2.29 | Items 16, 17 | RN 2.22, 2.23 |
| Lobby 5 | RN 4.1 → LB 4.6 | Items 18, 19 | RN 2.10, 2.11 |
| Lobby 6 | RN 2.1 | Items 20 | RN 2.24 |
| Lobby 7 | RN 1.6 → LB 2.13 | Items 21 | RN 3.18 |
| Ghost 1 | RN 2.35 | Items 22 | Items 22 |
| Ghost 2 | RN 3.1 | Items 23 | RN 2.25 |
| Ghost 3 | RN 3.4 | Items 24 | RN 2.26; A/B: Items 24 |
| Ghost 4, 5 | RN 3.2 | Items 25 | Items 25 |
| Ghost 6 | RN 3.3 | Results 26 | RN 2.27, 2.28 |
| Ghost 7 | RN 3.20 | Results 27, 28 | RN 2.29, 2.30 |
| Ghost 8 | Ghost 8 | Results 29 | Results 29 |
| Ghost 9–11 | RN 3.5, 3.6, 4.2 | Results 30 | RN 2.28, 4.3–4.4 |
| Results 31 | RN 4.5a | Results 32 | RN 3.19; second half: Results 32b |
| Results 33 | RN 4.5b; second half: Results 33b | Results 34–37 | RN 2.33, 2.32, 2.31, 2.34 / 3.22 |
| Results 38 | RN 1.4, 3.23, 4.6 | Results 39–42 | RN 3.24, 2.36, 6.1, 5.4 / 5.6 |
| Results 43 | Results 43 | | |
