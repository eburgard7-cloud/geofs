# Acceptance checks

In-sim checks that can't be automated (they need the live GeoFS/Cesium site, a real relay
connection, or an actual friend group racing together). Each session that touches a feature
area appends numbered checks under that area's heading as it verifies them live — see
CLAUDE.md's "Feature series 0.7–1.0" section.

## HUD

1. Load a ground-start course solo (no relay/`API_BASE` empty): confirm the top-left position
   block + standings tower never appear (`hudPositionInfo`/`hudTowerRows` correctly read "solo"
   from a 0/1-length `Relay.standings`), and that everything else (timer, gate pips, feed,
   speed/altitude, item slots) still renders normally.
2. Race with at least one other connected client so `Relay.standings` has 2+ entries: confirm
   the position block shows a real rank ("2ND of 3" etc.) and the tower lists up to 8 rows with
   your own row visually distinct. **Known limitation:** the relay's `standings` frame
   (race/PROTOCOL.md) carries only ordered callsigns, not other players' elapsed time or model —
   so the tower's "gap" column and the position block's gap line can only say *who* is ahead, not
   *by how much*, until a future protocol version adds per-player timing to that frame.
3. Cross a gate faster than your recorded personal best split: confirm the top-center split-delta
   chip shows green and disappears after ~3 s; cross one slower and confirm it shows red.
4. Arm a run and confirm the settings panel (`#fr-root`) auto-minimizes; manually expand it mid-run
   and confirm it stays expanded until the next arm/reset, at which point auto-minimize resumes.
5. Press Alt+H during a race and confirm only the HUD hides (the settings panel keeps working);
   set `CONFIG.HUD = false` and confirm Alt+H goes back to hiding the settings panel instead, with
   no HUD DOM present at all.
6. Resize the browser under 900px wide during a race and confirm the standings tower and event
   feed collapse, while position/timer/gate/speed/altitude/items stay visible.
7. Trigger a box grant and an incoming hit: confirm both surface in the top-right event feed (not
   just the panel's own "Powerups" details list) and fade out after ~6 s.
8. With a loadout item active (Boost or Shield in use), confirm its bottom-center slot shows a
   draining timer bar synced to `powerupsActiveEffects()`, and that the untaken box slot shows a
   dim "?" until something is rolled.

## Lobby

1. Two clients join the same room, both ready up, host starts a 10 s countdown: confirm both
   banners say GO within ~150 ms of each other (compare against a phone stopwatch video of both
   screens side by side).
2. Host disconnects mid-lobby (close the tab): confirm host migrates to the next-longest-
   connected pilot within a couple seconds and the lobby card updates its host marker for
   everyone still there.
3. Kill the `race-api` container mid-countdown: confirm every client falls back cleanly — the
   lobby card disappears (relay reconnect loop takes over), the manual countdown is still
   available under "Manual sync (no relay)", and nobody is left DQ'd or stuck mid-reposition.
4. Race a ground-start course through the lobby: confirm the leaderboard-submitted time matches
   what the panel timer showed at finish (Race.elapsed, not Race.goElapsed) — the two clocks
   really are independent.
5. Race an air-start course with Teleport on, 3+ pilots: confirm everyone lands on a visibly
   staggered grid behind gate 1, facing gate 2, and that holding the fly-to-start speed gets
   each of them to gate 1 roughly at GO.
6. Cross gate 1 a couple seconds before GO on purpose: confirm the JUMP START +5 s banner shows,
   no DQ, and the lobby-race standings (not the leaderboard time) reflect the penalty.
7. Force start with one pilot not readied: confirm that pilot's HUD drops to standings+feed only
   (no timer, no pips, no item slots) while gates still render for them.

## Ghost

Later sessions append numbered in-sim checks here.

## Items

Later sessions append numbered in-sim checks here.

## Results

Later sessions append numbered in-sim checks here.
