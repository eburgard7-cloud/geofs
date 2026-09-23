# Lobby acceptance checklist (in-sim)

The checks the test suites can't settle, for the proto-5 lobby after the lobby reliability pass,
plus the ghosts, items and results checks from the race-night script. Run it on geo-fs.com
against the **deployed** relay before any version bump (PROTOCOL.md, "Versioning"). Tick one
box per row; write what you saw in Notes for anything that isn't a clean PASS.

The older race-night script, `race/ACCEPTANCE.md`, still holds the full step-by-step items,
ghost and results run. The last section here points into it rather than copying it.

## Setup: two clients on one PC

| | |
|---|---|
| **Window A** | A normal Edge/Chrome window on geo-fs.com. Callsign `PilotA`. Host. |
| **Window B** | An **InPrivate** (Edge) or Incognito (Chrome) window. It has its own localStorage, so its own pilot token and callsign. Callsign `PilotB`. |
| **Layout** | Side by side, **both visible**. A minimised or fully covered window gets its timers throttled; the host's auto-start and the Launch countdown run in the host's tab. |
| **Loader** | The PRIMARY bookmarklet in both. Raw GitHub caches for about 5 minutes, so click it after any push. |
| **Console** | DevTools open in both. `__finsRace.version` should print the version you expect. |
| **Debug** | **Alt+D** in each window shows the debug overlay (top left). If the browser grabs Alt+D for the address bar first, run `__finsRace.debug.toggle()` in the console instead. |
| **Course** | Any **air-start** course the vote offers, for the grid and teleport checks. `hood-circuit` if you pick one by hand. |

## 0. Preflight

| # | Check | Expect | PASS | FAIL | Notes |
|---|---|---|---|---|---|
| 0.1 | `curl -sS https://race.finsonly.net/health` | `{"ok":true,"courses":N}` with N > 0 | ☐ | ☐ | |
| 0.2 | `python race/tools/smoke_lobby.py` from your machine | `all 12 steps passed`, exit 0 | ☐ | ☐ | |
| 0.3 | `docker logs race` (or `race-api`) on the box | `courses loaded: N from /app/courses` | ☐ | ☐ | |
| 0.4 | Debug overlay, both windows | `client v<expected>`, `ui shell (CONFIG.LOBBY_V2 is on)`, `loads 1` | ☐ | ☐ | |
| 0.5 | Click the bookmarklet a **second** time in A | Panel re-shows, overlay still says `loads 2` and `sockets race 0/1` (never 2), no second panel | ☐ | ☐ | |

## 2. Every lobby control reaches the relay

Run with the overlay open in both windows. For each row, the overlay's `out` line must count the
frame on the clicking side, and the reply must show on the other side.

| # | Control (who) | Frame out | Expect on screen | PASS | FAIL | Notes |
|---|---|---|---|---|---|---|
| 2.1 | Ramp **+ New room** (A) | `join` | A lands on the Gate of a new `quick-…` room. Room chip shows the code. | ☐ | ☐ | |
| 2.2 | Ramp departure board **Join** on A's room (B) | `join` | B lands on the same Gate. Both see 2 pilots and A's star. | ☐ | ☐ | |
| 2.3 | Ramp **Have a room code? → Join** (B, after Leave) | `join` | Same room as 2.2. | ☐ | ☐ | |
| 2.4 | Ramp **Quick match** (B, with A's room boarding) | `join` | B is put in A's room, not a new one. | ☐ | ☐ | |
| 2.5 | Gate **READY UP** (B) | `ready` | Button flips to `READY ✓` **at once**, and A's card for B shows Ready. | ☐ | ☐ | |
| 2.6 | Gate **READY ✓** again (B) | `ready` | Back to Not ready on both. | ☐ | ☐ | |
| 2.7 | **Alt+Y** (B) | `ready` | Same as 2.5. **No** dialog of any kind appears. | ☐ | ☐ | |
| 2.8 | Gate quick chat **GG** (A) | `chat` | B's Gate chat and HUD feed show `PilotA: GG`. | ☐ | ☐ | |
| 2.9 | Gate typed chat + Enter (A) | `chat` | B's Gate chat shows the **text** (was blank in 1.3.x). | ☐ | ☐ | |
| 2.10 | Typed chat, B back to A | `chat` | A sees B's text. | ☐ | ☐ | |
| 2.11 | Vote tile (A, then B) | `vote` | Tally bar and `Your vote` badge move on both. | ☐ | ☐ | |
| 2.12 | Host **Set course** (A) | `course` | Both Gates name the course; both ready flags clear; the vote note says it is advisory. | ☐ | ☐ | |
| 2.13 | **Start anyway** (A, B not ready) | `start` | Countdown starts; B spectates this race. | ☐ | ☐ | |
| 2.14 | **Abort to gate** (A, during the countdown) | `abort` | Both back on the Gate. | ☐ | ☐ | |
| 2.15 | Ramp **Ping** (B) | `ping_ramp` (hub) | A gets `PilotB pinged the ramp.` in the feed. The 4th ping of the day shows a toast saying you're out. | ☐ | ☐ | |
| 2.16 | Departure board **Spectate** on a racing room (B) | `join` (spectate) | B watches; B's card says SPECTATING. | ☐ | ☐ | |
| 2.17 | Gate **Leave** (B) | socket closed | A's Gate drops B. Loading any course on B afterwards does **not** rejoin (overlay: `sockets race 0`). | ☐ | ☐ | |
| 2.18 | Refusal surfaces (B, guest): console `__finsRace.lobby.startCountdown(10, true)` | `start` | A red toast: `Relay: host only`. | ☐ | ☐ | |
| 2.19 | Offline send (B): in DevTools Network, set **Offline**, then click READY | nothing | A toast says `Ready not sent`. Set Online again afterwards. | ☐ | ☐ | |

## 3. One client, one socket, one UI

| # | Check | Expect | PASS | FAIL | Notes |
|---|---|---|---|---|---|
| 3.1 | DevTools → Network → WS, whole session in one room | Exactly **one** open `/ws/race/<room>` at a time (a reconnect closes the old one first) | ☐ | ☐ | |
| 3.2 | Reload the page with a room stored from last time | No race socket opens until you join from the Ramp | ☐ | ☐ | |
| 3.3 | Look for the old floating plum lobby card or a ready-check dialog, whole run | Never appears | ☐ | ☐ | |
| 3.4 | Solo tab, in a proto-5 room | No "Manual sync" countdown section, no "Room" box under Powerups | ☐ | ☐ | |
| 3.5 | (Only if an old server is up somewhere) Join a room on a proto < 5 relay | Persistent red banner `Server proto X, client needs 5` | ☐ | ☐ | ☐ not run |

## 4. Ready → countdown → GO → grid → teleport

| # | Check | Expect | PASS | FAIL | Notes |
|---|---|---|---|---|---|
| 4.1 | Voting room, no host pick: A votes, both READY | The host's auto-start fires about 3 s after the last ready. Nobody set a course by hand. | ☐ | ☐ | |
| 4.2 | Launch screen, both | Route map, `Green light in N` counting down, grid list with both pilots (was an empty screen in 1.3.x) | ☐ | ☐ | |
| 4.3 | Overlay `clock offset` | A number, the same order of magnitude on both (the relay was ~1.8 s behind on 2026-09-23) | ☐ | ☐ | |
| 4.4 | Film both screens: the two countdowns | Within ~150 ms of each other, and GO on both at the same instant | ☐ | ☐ | |
| 4.5 | Air-start course: overlay `teleport` line on both | `resetFlight -> grid slot 1 of 2` and `… 2 of 2` (or `llaLocation/htr`). Console has one `[finsRace] teleport …` line with before/after. | ☐ | ☐ | |
| 4.6 | Where you are after the teleport | About speed × lead behind gate 1 (the Launch card says how far), facing gate 2, flying at ~150 m/s, **not** on top of the other pilot (80 m apart sideways, 30 m apart vertically) | ☐ | ☐ | |
| 4.7 | Hold what you were given until GO | You cross gate 1 at about GO, with no jump-start banner | ☐ | ☐ | |
| 4.8 | **Solo:** one window only, a room code nobody else knows, vote, READY | A lone pilot starts on their own vote, countdown, teleport | ☐ | ☐ | |
| 4.9 | **Solo:** overlay **Test grid slot 2 of 3** on an air course | Teleported, toast names the method, overlay shows the result | ☐ | ☐ | |

## 5. The rest of the lobby

| # | Check | Expect | PASS | FAIL | Notes |
|---|---|---|---|---|---|
| 5.1 | Ramp **On the ramp** list, both windows | Both pilots listed with what they are doing (`in <room>`, `racing <room>`, `flying solo`) | ☐ | ☐ | |
| 5.2 | Departure board | A's room listed with host, pilot count, status pill and the right action button | ☐ | ☐ | |
| 5.3 | Quick match with nobody boarding | Starts a fresh room | ☐ | ☐ | |
| 5.4 | Ping the ramp, 4 times in a day | 3 go out; the 4th is refused with a toast that says when it resets | ☐ | ☐ | |
| 5.5 | **Away:** B sits at the Gate for 60 s touching nothing (no mouse, no keys) | A sees `Away · 1 min` on B's card, and the ready bar says 1 pilot is away. Moving B's mouse brings back Not ready. | ☐ | ☐ | |
| 5.6 | Away vs Not ready at launch: B away, A ready | The host's auto-start launches without B (B spectates) | ☐ | ☐ | |
| 5.7 | Spectate a room mid-race | Standings visible, no grid slot, no box grants; results show racers only | ☐ | ☐ | |
| 5.8 | Room TTL: everyone leaves a room | It stays on the board as *Reopen* for up to 10 min, then disappears | ☐ | ☐ | |
| 5.9 | Host handoff: A (host) clicks Leave | B gets the star, the course picker and Start anyway **at once** | ☐ | ☐ | |
| 5.10 | Same pilot across reconnects: B reloads the page, clicks the bookmarklet | Same callsign accepted, no "already claimed" toast; `localStorage['finsRace.pilotId']` unchanged | ☐ | ☐ | |
| 5.11 | Chat is never stored: after 2.9, on the box: `sqlite3 <race.db> ".dump" \| grep -c '<your text>'` | `0` | ☐ | ☐ | |

## 6. Ghosts, items and results

These are the existing race-night checks. The steps live in `race/ACCEPTANCE.md`; the ranges
below are what to fly, now started from the Gate instead of the old lobby card.

| # | Area | Steps in race/ACCEPTANCE.md | PASS | FAIL | Notes |
|---|---|---|---|---|---|
| 6.1 | Item boxes, contested boxes, loadout effects | 2.6–2.11 | ☐ | ☐ | |
| 6.2 | Offensive items (missile, banana, goop, hit feel) | 2.12–2.24 | ☐ | ☐ | |
| 6.3 | Entity budget and frame rate | 2.25–2.26 | ☐ | ☐ | |
| 6.4 | Results card, two clocks, awards, record badge | 2.27–2.34 | ☐ | ☐ | |
| 6.5 | Ghost saved, race the winner's ghost | 2.35–2.36 | ☐ | ☐ | |
| 6.6 | Ghost race, racing line, bracket, minimap, cup standings | Part 3 | ☐ | ☐ | |
| 6.7 | Grid start and cup final (air course) | Part 4 | ☐ | ☐ | |
| 6.8 | Blocked missile narration (fixed this pass): watch B's shield eat A's missile | Part 2.15. A's feed says `PilotB's shield ate PilotA's Mustard missile`, with sound and a white ring. | ☐ | ☐ | |

## Sign-off

| Run by | Date | Client version | Relay proto | smoke_lobby.py | Result |
|---|---|---|---|---|---|
| | | | | ☐ pass ☐ fail | ☐ release ☐ hold |
