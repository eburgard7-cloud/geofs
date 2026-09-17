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

Later sessions append numbered in-sim checks here.

## Ghost

Later sessions append numbered in-sim checks here.

## Items

Later sessions append numbered in-sim checks here.

## Results

Later sessions append numbered in-sim checks here.
