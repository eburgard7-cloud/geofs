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

1. Fly a course clean, solo, with `API_BASE` empty. Confirm the panel's **Ghost → Race against**
   picker gains a **My best** entry after the finish, and that `localStorage` holds
   `finsRace.trace.<hash>` plus a one-entry `finsRace.traceIndex`.
2. Re-arm (Alt+R) with **My best** picked and fly again: confirm the ghost is invisible while you
   sit in the start sphere, appears the instant you cross gate 1, and flies your previous line.
   Fly deliberately slower and confirm it pulls away; fly faster and confirm you pass it.
3. Let the ghost finish ahead of you: confirm it parks at the finish gate and stays there rather
   than vanishing or continuing past it.
4. **GHOST_ALPHA is unverified in-sim.** Confirm the ghost is actually translucent (0.45) and not
   solid — if it is solid, `Cesium.Model.color`/`colorBlendMode` are not doing what this build
   expects and the guard in `makeGhostLayer()` needs revisiting. A solid ghost is cosmetic only.
5. With a joke model selected, confirm the ghost wears it and is labelled
   `GHOST · <callsign> · <time>`. Point the Ghost picker at a pilot with no model assigned and
   confirm the goldfish stands in with the panel saying "(stand-in model)".
6. Race with at least one other pilot connected and the ghost on: confirm the ghost is never
   listed in the standings tower, never gets an item, never appears in the kill feed, and that
   the other pilot's real aircraft still renders correctly (the multiplayer flicker fix is
   unaffected).
7. Deliberately DQ mid-run (teleport) and confirm nothing is saved: the stored trace for that
   course is still the previous personal best, and the ghost still flies that older line next run.
8. Fly a course for more than 25 minutes (or temporarily drop `CONFIG.TRACE_MAX_SAMPLES`) and
   confirm the panel reports the trace stopped at the cap and that nothing new is saved.

### Racing line

9. With a ghost picked, confirm the line is drawn ahead of you, ends roughly 4 km along the
   path, and slides forward as you fly rather than being redrawn from the start each time.
10. Watch the colour through a close race: green when the HUD's "vs ghost" reads negative, amber
    while it hovers inside ±0.30 s, red when positive. Confirm it does **not** strobe green/red
    while the delta wobbles around zero.
11. Load a course nobody has recorded (a fresh test course) and confirm the line is dashed and
    neutral, and that the panel reads "Suggested line (no recorded run yet)".
12. Press **Alt+L** mid-race: confirm the line disappears immediately and the race is otherwise
    unaffected; press again and confirm it comes back. Reload the page and confirm the choice
    stuck.

### Waypoint bracket

13. **`G.worldToScreen` is unverified in-sim** — this is the check that matters most. Confirm the
    bracket actually sits on the next gate as you turn, at several camera angles including
    cockpit view. If no bracket ever appears,
    `Cesium.SceneTransforms.wgs84ToWindowCoordinates` is not resolving on this build; the
    feature check should mean no bracket rather than a console error, so confirm the console is
    clean too.
14. Turn until the next gate goes off screen: confirm the bracket becomes an edge chevron on the
    correct side, that the turn instruction matches the panel's ▲ arrow, and that turning toward
    it brings the bracket back.
15. Turn 180° from the next gate (it is now behind the camera): confirm a chevron still shows,
    on the side you would turn toward, reading close to "turn left/right 180°".
16. Confirm the bracket tracks smoothly at low frame rate — it is the only element on the
    per-frame clock, so any visible lag against the gate means `renderBracket()` is not running
    where it should be.

### Minimap

17. Confirm the minimap draws bottom-right, north-up, with the whole course fitted inside it and
    your marker rotating with your heading.
18. Fly through gates and confirm they restyle done / next / remaining in step with the 3D
    spheres and the HUD's gate pips. On `starter-sprint-seatac`, confirm the item box marker is
    where the box actually is.
19. Race with at least one other connected pilot on a relay running 0.9.0 or later: confirm their
    dot appears and moves. Against an **older** relay (one that sends `standings` without
    `positions`), confirm the map simply shows no other racers — no dots stuck in the middle, no
    console errors.

### Frame rate

20. **The one performance check.** With ghost + racing line + minimap + waypoint bracket all on,
    on the longest course available and with at least one other pilot connected, confirm the
    frame rate is within a few fps of the same course with `CONFIG.GHOST`, `CONFIG.RACING_LINE`,
    `CONFIG.MINIMAP` and `CONFIG.WAYPOINT_BRACKET` all set to `false`. Anything worse than that
    means something is being rebuilt per frame that should be on a timer — check the racing
    line's rebuild rate first (it should be 2/s), then the minimap's (3–4/s).

### Against an old server

21. Point `API_BASE` at a pre-0.9.0 relay (or the current one before deploying this version) and
    finish a run: confirm the time still posts, the status line does not claim a ghost was
    uploaded, `GET /ghost` 404s read as "no ghost recorded for that pick yet" in the panel rather
    than an error, and **My best** still works entirely from `localStorage`.

## Items

Added 0.10.0. Everything here needs a relay running proto 3 (`race/server/app.py`); the last two
checks are what decide whether the visible items layer is actually shippable at a real frame rate.

### Boxes

1. Load `starter-sprint-seatac` and confirm each item box draws as a slowly rotating yellow cube
   with a `?` above it — **not** a sphere — at gate altitude, and that the rows sit off to one
   side of the line you would fly anyway.
2. Fly through a box and confirm the item slot spins for about a second and a half before
   revealing, that **Alt+3 during the spin does nothing** (and says "Still rolling…"), and that
   the revealed item is what the panel's kill feed then names.
3. **Two clients.** Have both fly at the same box a second apart: confirm only the first gets a
   grant, the box goes dark **on both screens** for about six seconds, and it fades back in on
   both at roughly the same moment.
4. Confirm a box never triggers while merely armed (taxi through one before leaving the start
   sphere) and never adds a split or advances the gate counter.
5. In the course editor, press **Alt+B** and confirm one box appears under the aircraft, then
   **Alt+Shift+B** and confirm a row of three appears 120 m apart across your current heading.
   Save the course and confirm the leaderboard for it is unchanged (the hash must not move).

### Missile

6. **Two clients, the key check.** Have the pilot behind fire a missile. Confirm **both** see the
   projectile — a mustard point with a trail — and that it hits at visibly the same instant on
   both screens. Time it against a phone stopwatch video of both screens side by side; more than
   about 150 ms apart means the deferred resolution is not being driven off one clock.
7. Confirm the projectile visibly **curves** toward the victim as the victim maneuvers, rather
   than flying a straight line to where they were at launch.
8. Victim side: confirm the **MISSILE INBOUND from \<callsign\>** banner appears with a bar that
   drains over the flight, that the arrow points at the projectile and becomes an edge chevron
   when it is off screen, and that the `incoming` cue speeds up as it closes.
9. **Pop the Shield during the flight** and confirm it blocks: a white ring flash instead of a
   splat, on both screens, and no screen tint on the victim. Then pop it a beat too late and
   confirm it does **not** block — that difference is the whole feature.
10. Fly in the lead with a missile and fire it. Confirm the status line says **No target ahead**
    and the item is **still in the slot**, fireable again the moment somebody is in front.

### Banana

11. Drop a banana and confirm it appears **behind** you, roughly 150 m back, as a visible yellow
    object with a pole to the ground, and that it is dim for about a second and a half before it
    starts pulsing.
12. Confirm the pilot immediately on your tail is **not** hit by a banana you drop right in front
    of them — the arming delay is what makes dropping one a fair move.
13. **Trip one at 400 kt.** Fly straight through an armed banana at racing speed and confirm you
    are hit. This is the check the whole client-side detection change exists for; at 2 Hz server
    pings you would fly clean through it.
14. Confirm you never trip your own banana, and that flying through one with a Shield up clears
    it with no penalty.
15. Confirm live bananas show on the minimap and disappear from it when they are hit.

### Goop, Boost, Shield

16. Take a goop hit and confirm the overlay's blobs drift slowly downward and that the last
    second clears **from the centre outward** rather than snapping off.
17. **Two clients.** Confirm the pilot who got gooped has a green blob riding their aircraft on
    the *other* pilot's screen for the whole goop duration.
18. Confirm a Boost draws an orange trail behind the aircraft flying it **on both screens**, and
    that the speed-line vignette appears only on the booster's own screen.
19. Confirm a Shield is a visible cyan bubble on the other pilot's screen, and that it flashes
    white at the moment it eats something.

### Hit feel

20. Take a missile and confirm the view shakes for about half a second and then sits exactly
    where it was — no drift, no leftover transform. Take a banana and confirm a shorter shake.
21. Turn on the OS's reduce-motion setting and confirm the shake stops happening while the hit
    itself (tint, feed line, cue) still lands.
22. **Only if `CONFIG.POWERUP_SPEED_PENALTY` is being considered.** Turn it on, take a missile at
    cruise, and confirm: airspeed drops about 25%, holds one value for 1.5 s and recovers; a
    second missile during it does not stack; nothing happens at all below 150 m AGL; a Boost
    cancels it; and **no DQ** results. Leave it off again unless all five hold.

### Budget and frame rate

23. **The entity check.** Race a full ten minutes with at least three pilots throwing everything
    they pick up, then read `window.__finsRace.items.layer.count()` in the console. It must be at
    or under `CONFIG.ITEM_ENTITY_BUDGET` (40), and `…items.layer.evicted` tells you whether the
    budget was ever actually reached. Then finish the race and confirm the count returns to 0 —
    a non-zero count with no race running means something is not being cleared.
24. **The performance check.** With five pilots connected and every effect live (projectiles in
    the air, several bananas down, somebody boosted, somebody shielded), confirm the frame rate
    is within a few fps of the same scene with `CONFIG.ITEMS = false`. Anything worse means
    something is being rebuilt per frame that should not be — check the projectile trail rebuild
    first, then the banana pulse.
25. **Against an old relay.** Point `API_BASE` at a pre-0.10.0 relay and race: confirm the status
    line names the proto it found, that nothing from the items layer is drawn, that boxes still
    grant instantly with no roulette, and that the race is otherwise identical to 0.9.0.

## Results

Later sessions append numbered in-sim checks here.
