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
- [HUD and panel](#hud-and-panel)
- [Items and powerups](#items-and-powerups)
- [Results and cups](#results-and-cups)
- [Ghosts, racing line, bracket and minimap](#ghosts-racing-line-bracket-and-minimap)
- [Solo, courses and editor](#solo-courses-and-editor)
- [Failure drills and compatibility](#failure-drills-and-compatibility)
- [Public site and server data](#public-site-and-server-data)
- [Landing tools](#landing-tools)
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

## HUD and panel

| ID | Check | Expect | Last passed |
|---|---|---|---|
| RN 1.1 | Alone in a room with a course set | The position block and standings tower don't appear. The timer, gate pips, feed, speed/altitude and item slots all render | |
| RN 2.2 · Fix 6 | A run starts (lobby GO, or crossing gate 1 in Solo) | The panel collapses **on** the green light, not a beat before (Launch stays readable). The HUD is usable at once. Reopening by hand (Alt+K) mid-run stays open for the rest of that run and isn't collapsed again at the next gate | |
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

## Landing tools

| ID | Check | Expect | Last passed |
|---|---|---|---|
| Landing 1 | `probe.js` "touchdown inputs" on the ground, on a slow descent and through a touchdown | Paste the report into the PR. It decides recorder.js's `FIELD_MAP` for `agl_m`, `vs_mps`, `ias_mps`, `on_ground_bool` | |
| Landing 2 | `recorder.js` with a filled `FIELD_MAP`: one smooth and one firm landing | No `null` in any field while airborne. `on_ground_bool` flips once per contact. The file downloads | |
| Landing 3 | `replay_landing.mjs` on both | Exactly one `touchdown` and one `settled` per landing. The firm one's `vs_at_contact` is clearly more negative. A deliberate bounce shows as `bounce` | |
| Landing 4 | `POST /landings` with both on the deployed box | The smooth one outscores the firm one. `GET /landing-leaderboard?runway_id=…` shows both. Every race `/leaderboard` is unchanged. Then tune `LANDING_*` | |

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
