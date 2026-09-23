# Race-night acceptance script

> **Lobby checks moved.** For the proto-5 lobby (Ramp, Gate, Launch, the vote, chat, Away, the
> grid and teleport) use [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md), a two-clients-on-one-PC
> checklist written after the lobby reliability pass. Parts 0–1 below still describe the old
> floating lobby card and the typed Room box, which the shipped shell no longer shows. Parts 2–4
> (items, ghosts, results) are still the reference, and docs/ACCEPTANCE.md points into them.

One ordered run, two pilots, about 30 minutes of flying, that covers everything the test suites can't settle: the HUD, the lobby, ghosts, items and shared results on the live sim and the deployed relay, plus two failure drills. Fly it before calling a release good; append to it (see the end) rather than starting a second list.

Every step has a `☐ pass ☐ fail` pair. Steps tagged *(was Area N)* are the original numbered checks — HUD 1–8, Lobby 1–7, Ghost 1–21, Items 1–25 and Results 26–43 — moved to where the run naturally exercises them; the map at the end accounts for all of them. **Items are random.** Take what the boxes give you and tick a step when its item comes up; an item that never came up is *not run*, not a pass, and goes in the sign-off table.

## Before you start

| | |
|---|---|
| **Pilot A** | Host. Joins the room first. Callsign `PilotA`. Flies the front in Race 1, the back in Race 2. |
| **Pilot B** | Guest. Callsign `PilotB`. Flies the back in Race 1, the front in Race 2. A second machine, or a second browser profile on a second monitor. |
| **Both** | Chrome on geo-fs.com, F-16, DevTools console open, sound on, the current bookmark (PRIMARY caches ~5 min on GitHub, so click it after any push). |
| **Also** | A phone to film both screens side by side (the sync checks are only honest against a video), and shell access to the Unraid box for the drills. |
| **Room** | `accept-1`, typed in the Room box on both. A cup needs a typed room; so does a course change. |
| **Courses** | `starter-sprint-seatac` (ground start) for Races 1–2, `hood-circuit` (air start) for Race 3. **Not** `gorge-run` or `crater-rim`: `check_terrain.py` failed both. |

| Part | ≈ min | Covers |
|---|---|---|
| 0 Preflight | 3 | Server, version, both clients load |
| 1 Lobby | 5 | Solo HUD, join, chat, cup, ready gating, force start, abort, synced GO |
| 2 Race 1 — Starter Sprint | 8 | Jump start, HUD with two pilots, boxes, every item, results, lobby clock, record, ghost saved |
| 3 Race 2 — Starter Sprint again | 6 | Ghost, racing line, bracket, minimap, reset mid-race, cup standings, Next race |
| 4 Race 3 — Hood Circuit | 5 (+2) | Grid start, suggested line, waiting line, two-minute deadline, cup final |
| 5 Failure drills | 6 | Kill the container mid-race; a client on a stale bookmarklet |
| 6 Wrap | 3 | Landing page, host migration, editor boxes, persistence |

The minutes are an estimate, not a measurement. If you are past 12 minutes when Race 1 ends, drop the two-minute wait in Part 4 (step 4.5, option a) first.

## Part 0 — Preflight (≈ 3 min)

- **0.1** Run the four-check smoke test in `race/server/DEPLOY_CHECKLIST.md` §5: `/health`, `/ghost` on an unknown hash returns *No ghost recorded…* (not *Not Found*), a WebSocket `join` answers `"proto":4`, `GET /` returns 200. ☐ pass ☐ fail
- **0.2** On both machines, in the console: `__finsRace.config.API_BASE` is the server URL (**not** `''` — with it empty there is no lobby and nothing below can run) and `__finsRace.version` is `1.0.0`. Record both. ☐ pass ☐ fail
- **0.3** Both click the bookmark with the plane on screen: the panel opens and the console has no red errors. ☐ pass ☐ fail
- **0.4** A: type `PilotA` in *Leaderboard → Your name on the board*, then `accept-1` in *Powerups → Room*. The relay status says connected, and the lobby card shows one pilot, A, marked `★ host`. **B does not type the room yet.** ☐ pass ☐ fail

## Part 1 — Lobby (≈ 5 min)

The lobby's countdown length is the **Lead time (s)** box under *Manual sync (no relay)* in the panel (default 10; the lobby's Start buttons read the same box). Set it on A as each step says.

- **1.1** *A alone.* In the lobby card, pick **Starter Sprint** and press **Set course**. Confirm the top-left position block and the standings tower never appear, while the timer, gate pips, feed, speed/altitude and item slots all render. *(was HUD 1)* ☐ pass ☐ fail
- **1.2** B: type `PilotB` and `accept-1`. Both cards list two pilots with A as host; B's copy of the course loads on its own (the gate count replaces *loading…*) with no *COURSE MISMATCH* banner. ☐ pass ☐ fail
- **1.3** B taps **GG**: it lands in both HUD feeds. ☐ pass ☐ fail
- **1.4** A types `Acceptance` and `3`, presses **Start cup**. Both cards read *Cup: Acceptance · race 1 of 3*. *(was Results 38)* ☐ pass ☐ fail
- **1.5** Neither ready: **Start countdown** is disabled with *Waiting for everyone to ready up.* B presses **Alt+Y** — the badge flips on both screens and Start stays disabled; A presses Alt+Y and it enables. ☐ pass ☐ fail
- **1.6** *Force start and abort.* B un-readies (Alt+Y). A sets *Lead time (s)* to 30, presses **Force start** and accepts the prompt naming PilotB. B's HUD drops to standings + feed — no timer, pips or item slots — while the gates still render. *(was Lobby 7)* Then A, in the console, runs `__finsRace.lobby.abortCountdown()` (there is no abort button): B is a racer again and **B's ready flag is still off**, i.e. abort keeps ready flags. ☐ pass ☐ fail
- **1.7** Both ready. Both set their loadout to *Speed Boost* and *Shield*. A sets *Lead time (s)* back to 10 and presses **Start countdown**. **Film both screens**: both GOs land within about 150 ms of each other. *(was Lobby 1)* ☐ pass ☐ fail

## Part 2 — Race 1: Starter Sprint, ground start, items on (≈ 8 min)

A leads; B stays a kilometre or so behind, so B is the one the box odds favour (missiles, boost) and A the one who tends to roll bananas.

**Start and HUD**

- **2.1** B starts rolling early enough to leave the start sphere **before GO**. Expect the *JUMP START +5 s* banner, no DQ, and B keeps racing. *(was Lobby 6)* ☐ pass ☐ fail
- **2.2** The panel auto-minimises when the run arms. Expand it by hand mid-run: it stays open until the next arm or reset. *(was HUD 4)* ☐ pass ☐ fail
- **2.3** With two pilots, the position block shows a real rank ("1ST of 2") and the tower lists both rows with your own row distinct. *Known limitation:* the gap column says who is ahead, not by how much — the `standings` frame carries no timing. *(was HUD 2)* ☐ pass ☐ fail
- **2.4** B presses **Alt+H**: only the HUD hides, the panel keeps working; press it again. *(was HUD 5)* ☐ pass ☐ fail
- **2.5** B narrows the browser under 900 px: the tower and the feed collapse; position, timer, gate, speed, altitude and items stay. Restore it. *(was HUD 6)* ☐ pass ☐ fail

**Boxes**

- **2.6** Each item box is a slowly rotating yellow cube with a `?` — not a sphere — at gate altitude, in rows off to one side of the racing line. *(was Items 1)* ☐ pass ☐ fail
- **2.7** Fly through a box: the slot spins about 1.5 s, **Alt+3 during the spin does nothing** and says *Still rolling…*, and the revealed item is what the feed then names. *(was Items 2)* ☐ pass ☐ fail
- **2.8** *Two clients, the same box, a second apart.* Only the first gets a grant; the box goes dark **on both screens** for about 6 s and fades back in at roughly the same moment on both. *(was Items 3)* ☐ pass ☐ fail
- **2.9** A grant and an incoming hit both appear in the top-right feed and fade after about 6 s. Using a loadout Boost or Shield drains a bar in its bottom-centre slot, and the unfilled box slot shows a dim `?`. *(was HUD 7, 8)* ☐ pass ☐ fail

**Loadout effects, seen from the other cockpit**

- **2.10** A presses **Alt+1** (Boost). B sees an orange trail behind A; only A sees the speed-line vignette. *(was Items 18)* ☐ pass ☐ fail
- **2.11** A presses **Alt+2** (Shield). B sees a translucent cyan bubble on A, which flashes white the moment it eats something. *(was Items 19)* ☐ pass ☐ fail

**Offensive items — tick each as it happens, in whatever order the boxes hand them out**

- **2.12** **Missile, seen by both.** The pilot behind fires. Both screens show a mustard projectile with a trail, and it lands at the same instant on both — film it; more than about 150 ms apart means resolution isn't on one clock. *(was Items 6)* ☐ pass ☐ fail ☐ not run
- **2.13** The projectile visibly **curves** toward the victim as they manoeuvre, not a straight line to where they were at launch. *(was Items 7)* ☐ pass ☐ fail ☐ not run
- **2.14** Victim's screen: **MISSILE INBOUND from PilotX** with a bar that drains over the flight, an arrow at the projectile that becomes an edge chevron when it is off-screen, and a cue that speeds up as it closes. *(was Items 8)* ☐ pass ☐ fail ☐ not run
- **2.15** **Pop the Shield during the flight**: a white ring instead of a splat, on both screens, no tint on the victim. Then, on a second missile, pop it a beat too late: it does **not** block. That difference is the feature. *(was Items 9)* ☐ pass ☐ fail ☐ not run
- **2.16** **No target ahead.** Holding a missile, overtake and fire from the lead: the status line says *No target ahead* and the item is still in the slot, fireable once somebody is in front. *(was Items 10)* ☐ pass ☐ fail ☐ not run
- **2.17** **Banana, dropped.** It appears about 150 m **behind** the dropper as a yellow object with a pole to the ground, dim for ~1.5 s, then pulsing. *(was Items 11)* ☐ pass ☐ fail ☐ not run
- **2.18** The pilot right on the dropper's tail is **not** hit by a banana dropped in front of them — arming is what makes dropping one a fair move. *(was Items 12)* ☐ pass ☐ fail ☐ not run
- **2.19** **Trip one at about 400 kt.** Fly straight through an armed banana at racing speed and get hit. This is the check client-side detection exists for; at 2 Hz server pings you would fly clean through it. *(was Items 13)* ☐ pass ☐ fail ☐ not run
- **2.20** You never trip your own banana, and flying through one with the Shield up clears it with no penalty. *(was Items 14)* ☐ pass ☐ fail ☐ not run
- **2.21** Live bananas show on the minimap and vanish from it when hit. *(was Items 15)* ☐ pass ☐ fail ☐ not run
- **2.22** **Goop, victim's screen.** The overlay's blobs drift downward and the last second clears **from the centre outward**. *(was Items 16)* ☐ pass ☐ fail ☐ not run
- **2.23** **Goop, other cockpit.** The goop'd pilot has a green blob riding their aircraft on the *other* pilot's screen for the whole duration. *(was Items 17)* ☐ pass ☐ fail ☐ not run
- **2.24** **Hit feel.** A missile shakes the view about half a second, then it sits exactly where it was — no drift, no leftover transform; a banana shakes for less. *(was Items 20)* ☐ pass ☐ fail ☐ not run

**Finish and results**

- **2.25** *Entity budget.* Late in the race, in the console: `__finsRace.items.layer.count()` is at or under 40 (`…layer.evicted` says whether the budget was ever hit). After both finish it is back to **0**. *(was Items 23)* ☐ pass ☐ fail
- **2.26** *Frame rate, recorded.* With items live, note fps here: ____; note the same view before loading the bookmarklet: ____. The strict A/B is in the appendix. *(was Items 24)* ☐ recorded
- **2.27** A finishes first. **Neither status line ever shows `finish rejected: …`.** If one does, the lobby clock and the relay's disagree by more than 3 s — record `__finsRace.lobby.offsetMs` on both. *(was Results 26)* ☐ pass ☐ fail
- **2.28** While B is still flying, the card is up for A but **never over B's view**. B finishes: both cards show the same order and the same times. *(was Results 26, 30)* ☐ pass ☐ fail
- **2.29** *Two clocks.* The card's time differs from the panel timer at A's finish by about how long after GO A crossed gate 1 (a standing start), and B's carries the +5 s. The leaderboard post — check `/leaderboard?course_hash=…` — is the **gate-1 time**, unchanged from 0.10.0 and matching what the panel timer showed. *(was Lobby 4, Results 27)* ☐ pass ☐ fail
- **2.30** B's finish was accepted (no `rejected`), B's time carries the penalty, and *Jump starter* is in the awards. *(was Results 28)* ☐ pass ☐ fail
- **2.31** *Awards ring true.* A missile that landed counts as a hit taken and a hit landed; one a Shield ate counts as neither. *Clean race* appears only if somebody was hit. Name any award that is wrong and what you saw. *(was Results 36)* ☐ pass ☐ fail
- **2.32** The banner shows your place and points (`P2 · +12 pts`) and the winner hears a fanfare over the ordinary finish cue — a celebration, not a glitch. Turn sound off: both go quiet. *(was Results 35)* ☐ pass ☐ fail
- **2.33** *Layout.* The card reads at a normal window, under ~640 px, and with the panel minimised; the table and the cup/awards column stack rather than overflow; long names wrap; **Esc** and **Close** both dismiss it; it doesn't sit under the lobby card or the HUD. *(was Results 34)* ☐ pass ☐ fail
- **2.34** *Record badge, first half.* This is the first run on this board, so **New course record** shows on the winner's card on both machines within ~4 s. *(was Results 37)* ☐ pass ☐ fail
- **2.35** *A ghost was saved.* Each pilot's **Ghost → Race against** now offers **My best**, and `localStorage` holds `finsRace.trace.<hash>` plus a one-entry `finsRace.traceIndex`. *(was Ghost 1)* ☐ pass ☐ fail
- **2.36** *Race the winner's ghost.* **B first** (a guest): the Ghost picker names PilotA and **the room does not move**. Then **A** (the host): the room goes back to the lobby. The ghost will fly next run if A's trace uploaded — the panel says so if not. *(was Results 40)* ☐ pass ☐ fail
- **2.37** *HUD timer legibility.* Zoom the race clock (`#fr-hud-timer`) in DevTools while running: solid amber digits on a dark pill, no double/offset shadow edge. In the Network tab block `fonts.googleapis.com`/`fonts.gstatic.com` (or just note that race.js loads no external font at all) and confirm the clock is still crisp — it never depended on one. ☐ pass ☐ fail

## Part 3 — Race 2: Starter Sprint again, ghost on, roles swapped (≈ 6 min)

B leads, A trails. Both ready up; the cup card says *race 2 of 3*. Picker: A on **My best**, B on the ghost of **PilotA** (from 2.36).

**Ghost and racing line**

- **3.1** The ghost is invisible while you sit in the start sphere, appears the instant you cross gate 1, and flies the line it recorded. Fly slower: it pulls away. Faster: you pass it. *(was Ghost 2)* ☐ pass ☐ fail
- **3.2** *Translucency is unverified in-sim.* The ghost is see-through (0.45), not solid — if solid, `Cesium.Model.color` isn't doing what this build expects and `makeGhostLayer()` needs a look (cosmetic only). It's labelled `GHOST · <callsign> · <time>`; with a joke model selected it wears it, and a pilot with no model gets the goldfish and the panel says *(stand-in model)*. *(was Ghost 4, 5)* ☐ pass ☐ fail
- **3.3** With the other pilot connected, the ghost is never in the standings tower, never gets an item, never appears in the kill feed, and the other pilot's real aircraft still renders correctly (the multiplayer flicker fix is unaffected). *(was Ghost 6)* ☐ pass ☐ fail
- **3.4** Let the ghost finish ahead of you: it parks at the finish gate rather than vanishing or flying on. *(was Ghost 3)* ☐ pass ☐ fail
- **3.5** The racing line is drawn ahead of you, ends about 4 km along the path, and slides forward as you fly instead of redrawing from the start. *(was Ghost 9)* ☐ pass ☐ fail
- **3.6** Colour through a close stretch: green when the HUD's "vs ghost" is negative, amber while it hovers inside ±0.30 s, red when positive — and it does **not** strobe green/red around zero. *(was Ghost 10)* ☐ pass ☐ fail
- **3.7** **Alt+L** mid-race: the line disappears at once and the race is otherwise untouched; press again and it returns. *(was Ghost 12)* ☐ pass ☐ fail
- **3.8** Cross a gate faster than your best split: the top-centre delta chip shows **green** and goes after ~3 s; slower: **red**. *(was HUD 3)* ☐ pass ☐ fail

**Waypoint bracket — `G.worldToScreen` is unverified in-sim, this is the check that matters**

- **3.9** The bracket sits on the next gate as you turn, at several camera angles including cockpit view. If none ever appears, `Cesium.SceneTransforms.wgs84ToWindowCoordinates` isn't resolving — and the console must be clean either way. *(was Ghost 13)* ☐ pass ☐ fail
- **3.10** Turn until the gate is off-screen: it becomes an edge chevron on the correct side, matching the panel's ▲ arrow, and turning toward it brings the bracket back. *(was Ghost 14)* ☐ pass ☐ fail
- **3.11** Turn 180° from the next gate: a chevron still shows, on the side you'd turn toward, reading close to "turn left/right 180°". *(was Ghost 15)* ☐ pass ☐ fail
- **3.12** The bracket tracks smoothly even at low frame rate — it is the only element on the per-frame clock. *(was Ghost 16)* ☐ pass ☐ fail

**Minimap**

- **3.13** It draws bottom-right, north-up, the whole course fitted, your marker rotating with your heading. *(was Ghost 17)* ☐ pass ☐ fail
- **3.14** Gates restyle done / next / remaining in step with the 3D spheres and the HUD pips, and the item-box marker is where the box actually is. *(was Ghost 18)* ☐ pass ☐ fail
- **3.15** The other pilot's dot appears and moves (this relay sends `standings.positions`). *(was Ghost 19)* ☐ pass ☐ fail
- **3.16** *Frame rate, recorded.* With ghost, racing line, minimap and bracket all on and the other pilot connected: ____ fps. *(was Ghost 20)* ☐ recorded

**Items, second helping and reduced motion**

- **3.17** Anything marked *not run* in Race 1 (2.12–2.24) — do it now, boxes are still there. ☐ done
- **3.18** *Reduced motion.* On the pilot who is about to be hit, DevTools → ⋮ → More tools → Rendering → *Emulate CSS prefers-reduced-motion: reduce*. Take a hit: the shake stops happening while the tint, feed line and cue still land. *(was Items 21)* ☐ pass ☐ fail ☐ not run

**Reset mid-race, boxes while armed, and the end of the race**

- **3.19** A passes gate 2, then presses **Alt+R**. A's status reflects a DNF at a sensible gate, and the race **ends as soon as B finishes** rather than waiting out two minutes. *(was Results 32)* ☐ pass ☐ fail
- **3.20** *Nothing saved.* A's stored trace is still the Race 1 personal best (a reset throws the recording away), and A's ghost flies that older line next run. *(was Ghost 7)* ☐ pass ☐ fail
- **3.21** A, now re-armed and idle, flies through a box: nothing triggers, no split, and the gate counter doesn't move. *(was Items 4)* ☐ pass ☐ fail
- **3.22** *Record badge, second half.* The badge must agree with the board (`/leaderboard?course_hash=…`): it shows only if the winner's run tops it. B should fly slower than A's Race 1 time, so **no badge**. *(was Results 37)* ☐ pass ☐ fail
- **3.23** *Cup arithmetic.* Every card's cup column shows standings that add up across both races, the same on both machines, and the lobby says race 3 is next. *(was Results 38)* ☐ pass ☐ fail
- **3.24** A (host) presses **Next race**. Both are back in the lobby, every ready flag is cleared, the finished pilot is re-armed so the lobby card appears, and the cursor is in A's course picker. A picks **Mt. Hood Circuit**, **Set course**: both load it on their own. *(was Results 39)* ☐ pass ☐ fail
- **3.25** *Race a friend's ghost (0.12.0).* On A: open **Ghost → Race against** and pick B's name as the primary (racing line still colours against this one). Open **Race a friend** underneath it and add a second ghost — B's name again, or **Course record**. Fly: both ghosts appear in the world, each with its own joke model and a floating `GHOST · <callsign> · <time>` tag, and the HUD grows a small stack under the split chip with one colored line per rival (green ahead / amber close / red behind) alongside the existing single `vs ghost` readout for the primary. ☐ pass ☐ fail
- **3.26** *Corrupt/missing rival.* Pick a callsign with no recorded trace (or kill the server mid-load) in one of the **Race a friend** slots: a status line under that picker says so, the other ghost(s) keep flying, and the race itself is completely unaffected. ☐ pass ☐ fail
- **3.27** *Challenge link.* On the next results card, click **Copy challenge link**, and paste the URL into B's address bar on a fresh tab (not the same profile — a genuinely new page load). B lands with the same course loaded and the same ghost(s) pre-picked in **Race against** / **Race a friend**, first name as the primary. ☐ pass ☐ fail
- **3.28** *News banner.* Have B beat one of A's times on a course A has flown, then have A reload the bookmarklet fresh. A's banner reads *"\<B\> beat your \<course\> by N.NNs → Race his ghost"*; clicking it loads that course and sets A's primary ghost to B. Dismissing it (✕) makes it go away without loading anything, and it does not reappear on a second reload (the last-seen timestamp advanced). ☐ pass ☐ fail

## Part 4 — Race 3: Mt. Hood Circuit, air start, Teleport on (≈ 5 min, +2 for the deadline)

The cup's third race: a different course, and the one where B deliberately doesn't finish.

- **4.1** Both ready; A starts the countdown (10 s is fine). Everyone lands on a **visibly staggered grid** behind gate 1, facing gate 2 (two pilots show two slots; three would show the full stagger), and holding the fly-to-start speed gets each of you to gate 1 at about GO. *(was Lobby 5)* ☐ pass ☐ fail
- **4.2** Nobody has a trace for this course, so the racing line is **dashed and neutral** and the panel reads *Suggested line (no recorded run yet)*. *(was Ghost 11)* ☐ pass ☐ fail
- **4.3** A flies it out and finishes. B flies to gate 2, then loiters and **does not finish**. ☐ done
- **4.4** A's card shows **waiting for 1 pilot (mm:ss)** counting down, with B as a placeholder row, and **the card never covered B's view while B was still flying**. *(was Results 30)* ☐ pass ☐ fail
- **4.5** *Either* (a) wait it out: at the two-minute mark the results arrive with B as a **DNF at the gate B had reached**, and when B later crosses the line B's status says the race is over — **once**, not repeatedly. *(was Results 31)* ☐ pass ☐ fail **or** (b) *if you are short on time*, close B's tab instead: B is a DNF at the last gate reported and the race ends as soon as A is done. *(was Results 33)* ☐ pass ☐ fail
- **4.6** *Cup final.* The third card says **Cup final**; standings add up across all three races on both machines; afterwards the lobby shows no cup and the next race is a one-off. *(was Results 38)* ☐ pass ☐ fail

## Part 5 — Failure drills (≈ 6 min)

Only with everyone told: you are about to kill the live relay.

### Drill 1 — kill the race container mid-race

- **5.1** B reopens the tab if it was closed in 4.5, and both are in the lobby. A presses **Rematch** (same course, no cup), both ready, A starts a countdown (10 s). Wait until both are past gate 1. ☐ done
- **5.2** On the Unraid box: `docker kill race-api`. On **both** screens: the timer, gates, pips and HUD carry on untouched; nobody is DQ'd or stuck mid-reposition; the relay status reads *reconnecting in Ns (loadout still works)* with the wait growing; no lobby card appears mid-race; Boost and Shield still fire; box and offensive items are off. *(was Lobby 3)* ☐ pass ☐ fail
- **5.3** Projectiles or bananas that were on screen vanish on their own within ~12 s, and `__finsRace.items.layer.count()` goes back to 0. ☐ pass ☐ fail
- **5.4** `docker ps --filter name=race-api`. If it isn't back within ~5 s, `docker start race-api`. Both clients reconnect **without a reload**; the room is fresh (phase lobby, whoever reconnected first is host, ready flags cleared). The race that was in progress is gone, as documented in the README's known limits. *(was Results 42)* ☐ pass ☐ fail
- **5.5** Both finish the race they were flying. Record what the status line says — expect one `finish rejected: no race in progress` — and confirm **no console error spam**, the run **still posts to the leaderboard** (`/leaderboard?course_hash=…`), and the trace still saves locally. ☐ pass ☐ fail
- **5.6** `https://race.finsonly.net/races/recent` still lists the races finished before the kill, cup name and all; the killed race is absent. *(was Results 42)* ☐ pass ☐ fail
- **5.7** *If there is time:* repeat the kill **during a countdown**. The lobby card disappears (the reconnect loop takes over), the manual countdown is still there under *Manual sync (no relay)*, and nobody is left DQ'd. *(was Lobby 3)* ☐ pass ☐ fail ☐ skipped

### Drill 2 — one client on a stale bookmarklet

B loads the client that shipped with `race-v0.5.0` (proto 1: no lobby, no ready, no results). Close B's tab, open geo-fs.com fresh, and click a bookmark containing:

```
javascript:(()=>{if(window.__finsRace){window.__finsRace.ui.toggle(true);return;}const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/eburgard7-cloud/geofs@race-v0.5.0/race/race.js';s.onerror=()=>alert('FINSONLY Racing failed to load');document.head.appendChild(s);})()
```

- **5.8** B types `PilotB` and `accept-1`. No console error on either machine, and the relay logs (`docker logs --tail 50 race-api`) show no traceback. A's lobby card lists PilotB, no model, and **never ready** — an old client never sends `ready`. ☐ pass ☐ fail
- **5.9** A **Force starts** (PilotB becomes a spectator to the relay) and races Hood Circuit alone. A finishes and gets a results card with A alone — B, a spectator, is not held up for or listed. B's own 0.5.0 panel keeps working, timer and gates included. *(0.5.0 reads `itemBox`, not `itemBoxes`, so B sees no boxes on this course. That is expected, not a failure.)* ☐ pass ☐ fail
- **5.10** B reloads on the current bookmark: B rejoins, can ready up, and the lobby card returns. ☐ pass ☐ fail

## Part 6 — Wrap (≈ 3 min)

- **6.1** *The history page.* Open `https://race.finsonly.net/`. Course records, the recent races (with the cup's name on its races) and, while any cup is open, its standings are all there. With the Network tab open it requests **one host only** and refreshes on its own. Then `/races/recent`, `/cups?open=1` and `/cups/<id>` return the same standings. *(was Results 41)* ☐ pass ☐ fail
- **6.2** *Host migration.* A closes the tab. B becomes host within a couple of seconds and the marker updates on B's card. A reopens and rejoins as a guest. *(was Lobby 2)* ☐ pass ☐ fail
- **6.3** *Persistence.* B presses **Alt+L** to turn the line off, reloads the page, clicks the bookmark: the line is still off. *(was Ghost 12)* ☐ pass ☐ fail
- **6.4** *Editor boxes.* In **Course editor**, press **Alt+B**: one box appears under the aircraft. **Alt+Shift+B**: a row of three, 120 m apart across the heading. **Save and load**, then confirm the leaderboard for that course is unchanged (the hash must not move). *(was Items 5)* ☐ pass ☐ fail

## Sign-off

| | A | B |
|---|---|---|
| Date / commit or tag | | |
| `__finsRace.version` | | |
| `__finsRace.lobby.offsetMs` | | |
| Browser / OS | | |
| fps: items live / plain GeoFS (2.26) | | |
| fps: all ghost features on (3.16) | | |

Steps marked *not run*: ____________________ Steps failed (with console output): ____________________

## Not in the run

These need something a two-pilot, one-relay, thirty-minute run cannot supply. They are not dropped; each says what it takes.

- **Ghost 8 — the 25-minute trace cap.** Fly a course past 25 minutes, or temporarily lower `CONFIG.TRACE_MAX_SAMPLES` in a patched copy. The panel must report the trace stopped at the cap and nothing new is saved.
- **Ghost 20 and Items 24 — the strict frame-rate A/B.** Needs the same scene with the features off. In the console, instead of clicking the bookmark, run this (edit the flag list; use only `ITEMS` for Items 24), then compare to a normal load:
  ```js
  fetch('https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/race.js?t='+Date.now()).then(r=>r.text()).then(t=>{const s=document.createElement('script');s.textContent=t.replace(/(GHOST|RACING_LINE|MINIMAP|WAYPOINT_BRACKET): true/g,'$1: false');document.head.appendChild(s);})
  ```
  Worse than a few fps means something is rebuilt per frame that belongs on a timer: check the racing line's rebuild rate first (2/s), then the minimap's (3–4/s); for items, the projectile trail rebuild and the banana pulse. *Items 24 wants five pilots with every effect live; two is an approximation.*
- **Items 22 — the speed penalty**, *only if `CONFIG.POWERUP_SPEED_PENALTY` is being considered.* Turn it on in a patched copy, take a missile at cruise and confirm: airspeed drops about 25%, holds one value for 1.5 s and recovers; a second missile during it doesn't stack; nothing happens below 150 m AGL; a Boost cancels it; and **no DQ** results. Leave it off unless all five hold.
- **Results 29 — a close finish decided by the crossing, not the frame.** Two pilots finishing within about 50 ms on machines with different frame rates; the card's order must be the order they crossed. If not, check `finishGoTimeMs` against a recording first. Too hard to stage on demand.
- **Results 32 (second half) and Results 33 (second half).** An **Alt+R during the countdown** must not put anything on the status line until the race starts, and then send its DNF once; and a *finisher* who closes their tab before the results keeps their finish. Each needs a race of its own, and `test/run.js` and `test_server.py` cover both.
- **Ghost 21, Ghost 19 (older-relay half), Items 25 and Results 43 — against an old relay.** Needs a pre-0.9.0 / 0.10.0 / 0.11.0 relay in a scratch container on another port (never the live one), `API_BASE` pointed at it: the status line names the proto it found; nothing from the missing layer draws or is sent; `GET /ghost` 404s read as *no ghost recorded for that pick yet*; **My best** still works from `localStorage`; with no `standings.positions` the minimap shows no other racers and no console error; against pre-0.11.0 no `finish`/`dnf`/`cup`/`rematch` frame appears in DevTools → Network → WS and a race ends on a local card with no points. Drill 2 covers the reverse (an old *client*, new relay).

### 1.2.0 — the matchmaking hub (server-side release)

Everything 1.2.0 ships is on the relay; no shipped client talks to `/ws/hub` yet, so none of it can
be exercised from the game this release. `test_server.py` covers the logic (identity, registry TTL
and reopen, ramp cap, chat sanitizing and rate limit, spectator refusals, vote weighting and
tie-break, presence coalescing), and `tools/hub_smoke.py` covers the wire end to end against a real
deployed server. What still needs a live check, once the panel exists:

- **Hub 1 — the upgrade survives the edge.** After deploying 1.2.0, run the `curl -i -N` one-liner
  and then `python race/tools/hub_smoke.py wss://race.finsonly.net/ws/hub` from a machine *outside*
  the LAN. The first must print `HTTP/1.1 101`, the second must print every check as ok. This is the
  only thing in the list that can be done today, and it is the one that catches Caddy/geoblock
  rejecting a second WebSocket path.
- **Hub 2 — the migration on the real database.** Back up `race.db`, deploy, then confirm
  `SELECT COUNT(*) FROM pilots` is about the number of distinct callsigns on the board, that
  `SELECT COUNT(*) FROM runs WHERE pilot_id IS NULL` is 0, that every existing leaderboard,
  `/ghosts` and `/races/recent` response is unchanged, and that `PRAGMA integrity_check` says `ok`.
- **Hub 3 — adoption with real history.** With the panel, claim a callsign that already has runs on
  the board and confirm the pilot_id matches the backfilled row and those runs still appear. Then
  confirm a second browser claiming the same name is refused by name.
- **Hub 4 — presence on a real ramp.** Three or more pilots on the hub at once: the list reflects
  who is where within a second or two, a pilot who closes their tab drops off within ~15 s, and a
  pilot who kills their network (rather than closing cleanly) also drops off — that second case is
  the half-open socket the heartbeat exists for.
- **Hub 5 — the registry through a whole race.** Watch one room's row go
  `boarding → launching ("starts in Ns" counting down) → racing ("gate N of M — X leads", updating
  as gates are crossed) → results`, then everyone leaves: the row goes `empty`, and rejoining the
  same code inside ten minutes lands in the same room with the same host.
- **Hub 6 — ping the ramp, for real.** Three pings land for everyone else and not the sender; the
  fourth is refused naming when it resets; two pings inside a minute get the cooldown message; and
  the count survives a `race-api` restart (that is the whole reason it is in SQLite).
- **Hub 7 — chat under load.** Two pilots typing during a race: lines arrive in order, a pasted
  300-character line is truncated not dropped, a burst of six is rate-limited with an error rather
  than a disconnect, and `pos` frames keep flowing throughout (the separate budget's actual point).
  Then confirm the six canned codes still work for a **1.1.0** client in the same room, and that it
  never renders a blank feed line.
- **Hub 8 — spectating in the air.** Join with `spectate: true` while a race runs: the minimap and
  standings track the racers, the spectator is absent from the order, and the race ends without
  waiting on them. Then a full room (12) plus spectators: the 13th *pilot* is refused, spectators
  keep getting in.
- **Hub 9 — the vote with a real catalog.** In a room of three or more, confirm the candidates skew
  toward courses that group has flown least, that changing a vote re-tallies, that the winner
  becomes the course when the host set none, that a host-set course overrides it, and that
  "surprise me" resolves to a real course at launch.
- **Hub 10 — an old client against a 1.2.0 relay.** The reverse of drill 2, and the one that
  matters most for a mid-week deploy: a 1.1.0 client joins, races, uses canned chat, finishes and is
  scored, with no error frames in DevTools → Network → WS and nothing new drawn. Its
  `joined.proto` reads 5 and it ignores that.

### 1.3.0 — the lobby-first panel (client)

1.3.0 builds the client the 1.2.0 hub was waiting for: a room-browser home screen (The Ramp), a
room lobby (The Gate — course vote, pilot grid, chat, ready bar) and a countdown/grid screen
(Launch), behind `CONFIG.LOBBY_V2` (default on). Every wire-level frame this sends or receives is
already covered by `test_server.py`/`tools/hub_smoke.py` (1.2.0's own section above) or by
`race/test/run.js`'s new pure-function and `FakeWebSocket` sections (URL parsing, room-code
slugify against the server pattern, vote-tile math, ready/away/not-ready and auto-start, chat
escaping via a live DOM assertion, storage-unavailable and hub-disconnect degradation). What none
of that can exercise is a real browser against the real site — this repo has never had one this
session, same as every prior `race.js` UI release. What still needs a live check:

- **Ramp 1 — the hub socket, live.** A second concurrent WebSocket (`/ws/hub`, alongside whatever
  `/ws/race/{room}` connections are open) from the same page on geo-fs.com. Confirm it actually
  connects under the site's CSP and that nothing about having two sockets open trips a browser or
  proxy limit the single-socket 1.1.0–1.2.0 client never hit.
- **Ramp 2 — browse and join, three clients.** Three browsers/pilots on the ramp: rooms appear
  and update live (pilot counts, status pills, the "starts in Ns"/"gate N — X leads" line), Quick
  Match lands in the fullest boarding room or starts a fresh one, Ping the ramp reaches the other
  two as an in-sim toast, and the empty state (nobody on the ramp) shows only Ping + Solo, not a
  blank table.
- **Gate 1 — the course vote changes live.** With three pilots in one room, confirm votes move the
  bar and count in real time, a changed vote re-tallies, and the winner announced on Launch matches
  what the room actually voted (or the host's explicit pick, when one was set).
- **Gate 2 — away suppresses auto-start.** One pilot goes idle (tab backgrounded or simply not
  touching anything) past the away threshold while ready; confirm their card reads Away with a
  duration, the ready bar's "N of M ready" excludes them from the count that matters, and the room
  does **not** auto-start around a not-ready-and-not-away pilot but **does** once every engaged
  pilot has held ready for the debounce window. Then confirm the host's manual **Start anyway**
  still force-starts immediately regardless.
- **Gate 3 — spectate an in-progress room.** Join a room mid-race with Spectate from the Ramp:
  standings/minimap/positions track the racers, no ready/vote/chat-compose control is offered a
  race to join, and the spectator is never counted toward the room being "full".
- **Launch 1 — the grid and countdown against real GeoFS reads.** On an air-start course with
  Teleport on, confirm the hold heading/speed/altitude cards track `G.heading()`/`G.kias()`/
  `G.lla()` smoothly through the countdown (all three are pre-existing, already-live-confirmed
  reads — see the HUD waypoint bracket — so this is about the new cards' *display*, not the reads
  themselves), the reposition note names the real distance this client was placed at, and Set/
  Moving per grid row flips to Set only once that pilot's own `pos` has actually landed.
- **Shell — panel layout on a real screen.** Everything above renders correctly in the headless
  test harness (jsdom); none of it has been seen in an actual browser window on top of the GeoFS
  canvas. Check the panel's drag handle, its default size/position against a typical laptop
  viewport, and that Copy Invite's clipboard write (or its textarea fallback) actually works under
  geo-fs.com's page permissions.

**Known, deliberate gaps — not bugs, no server support to build against:** pilot cards and the
Ramp's own "your card" show no season rank/points/cup-win count (no such endpoint exists anywhere
in `race/PROTOCOL.md`); the Gate pilot grid shows no "N open slots" (the room's real pilot cap,
`ROOM_MAX_PILOTS`, is never sent in a registry or lobby frame); and a vote tile's terrain-check
badge is a small hand-maintained mirror of race/README.md's own "Shared course status" table
(`KNOWN_TERRAIN_STATUS` in race.js), not a live field — a course added there later needs that
constant updated by hand until the server carries the fact itself.

### 1.3.1 — the 1.3.0 bugfix pass

1.3.1 fixes what a first live session found: **`CONFIG.API_BASE` was never set** (README "Deploy"
step 6), so every shipped 1.3.0 client had no relay and no hub, and every guard that noticed failed
closed *without a word* — "+ New room" produced no socket, no console line and no message. It also
routes the relay's `vote` frame, which `Lobby.onFrame()` had no case for at all, and builds the two
screens that were placeholders (Courses, Solo) plus the collapse control the shell never had.

The headless suite now clicks every control on every screen and asserts a real effect, so a stub,
a dead selector or a missing listener all fail identically; `apiBase: 'shipped'` tests the constant
a real bookmarklet load actually gets. What still needs a live check:

- **Fix 1 — the deployed relay actually answers.** Every test above points at a *fake* socket; the
  only thing that proves `https://race.finsonly.net` is the right address is a real load on
  geo-fs.com. Confirm `wss://race.finsonly.net/ws/hub` connects under the site's CSP (this is the
  first shipped client that ever tries), that "+ New room" opens `wss://race.finsonly.net/ws/race/
  <code>` in DevTools → Network → WS, and that the room appears on a second pilot's departure
  board. If the hub connects but the room socket does not, suspect Caddy's route for `/ws/race/`
  rather than the client.
- **Fix 2 — the course vote end to end.** 1.3.0 could never render a tile, so the vote has never
  been seen in a browser at all: with three pilots in a room confirm the relay's drawn candidates
  appear as tiles, a click re-tallies live for everyone, and the winner on Launch matches. (This
  supersedes Gate 1 above, which assumed a rendering that did not exist.)
- **Fix 3 — the Courses tab over the real COURSE_BASE.** Confirm `race/courses/index.json` loads
  from raw.githubusercontent on the live page (it is a different origin from the relay and is the
  one fetch that must work with *no* server at all), that every course in the repo is listed, and
  that Refresh picks up a course added to the index without a page reload.
- **Fix 4 — Solo end to end, with the relay deliberately unreachable.** Block or misconfigure
  `API_BASE` in a patched copy and confirm the whole Solo flow still works: pick a course, Fly to
  start puts you on gate 1 already flying, the clock starts on leaving the start sphere, the race
  HUD is the normal one, and the run finishes. Only the leaderboard POST at the end should fail,
  and it should fail quietly the way it always has.
- **Fix 5 — collapse against the real GeoFS canvas.** The reopen tab is fixed at the viewport's
  bottom-right; confirm it does not land under GeoFS's own HUD/controls on a typical laptop
  viewport, that it is clickable there, and that collapsing genuinely frees the flight view rather
  than leaving a transparent block over it.
- **Fix 6 — auto-collapse timing, felt rather than asserted.** In a real lobby race, confirm the
  panel disappears *on* the green light and not a beat before (the Launch screen must stay
  readable through the whole countdown), that the race HUD is immediately usable, and that
  reopening mid-race by hand neither disturbs the run nor gets collapsed again at the next gate.

**Deliberately not fixed here:** the Season tab is still a placeholder — there is no season/points
endpoint anywhere in `race/PROTOCOL.md` to build it against, exactly as 1.3.0's own known-gaps note
says. The three gaps in that note (season rank on pilot cards, the room's real pilot cap, a live
terrain-check field) are unchanged and still need server support first.

### 1.4.0 — modes, touchdown detection, server-side landing scoring

Everything in 1.4.0 is server-side or a standalone tool; race.js gains no landing UI yet and a
race is exactly what it was. The headless suites cover the detector, the scorer, the mode
registry and the migration. What only the live sim and the live box can settle:

- **Landing 1 — probe.js "touchdown inputs" on geo-fs.com.** Run it on the ground, on a slow
  descent and through a touchdown; paste the whole report into the PR. It is what decides which
  GeoFS reads recorder.js's FIELD_MAP uses for `agl_m`, `vs_mps`, `ias_mps` and `on_ground_bool`
  (every one is an unverified `TODO-PROBE` until then).
- **Landing 2 — recorder.js with a filled FIELD_MAP.** Record one smooth and one firm landing on
  the same runway; confirm the capture has no `null` in any field while airborne, that
  `on_ground_bool` flips once per real contact, and that the file downloads.
- **Landing 3 — replay_landing.mjs on those two recordings.** Exactly one `touchdown` and one
  `settled` per landing; the firm one's `vs_at_contact` is clearly more negative; a deliberate
  bounce shows up as `bounce`, not a second `touchdown`.
- **Landing 4 — POST /landings on the deployed box.** Post both replayed touchdowns (event
  verbatim + bounce count + `total_rollout_m`) and confirm the smooth one outscores the firm one,
  that `GET /landing-leaderboard?runway_id=…` shows both, and that `GET /leaderboard` for every race
  course is unchanged. Then tune the `LANDING_*` constants against the real numbers.
- **Modes 1 — the migration on the real race.db.** After `redeploy.sh`, the counts DEPLOY_CHECKLIST
  §7 step 3 prints match (`runs` = `mode_runs WHERE mode_id='race'`), and a second run prints
  `0 backfilled`.
- **Modes 2 — a 1.3.1 client on the proto 6 relay.** A race room opened by today's bookmarklet
  still joins, races and saves results exactly as before (`joined` now says `proto: 6` and
  carries `mode: "race"`, which it ignores).

## Coverage map

Every original check and where it went. HUD, Lobby and Ghost restart at 1 in the original; Items are 1–25 and Results 26–43.

| Original | Now | Original | Now |
|---|---|---|---|
| HUD 1 | 1.1 | Ghost 12 | 3.7, 6.3 |
| HUD 2 | 2.3 | Ghost 13 | 3.9 |
| HUD 3 | 3.8 | Ghost 14 | 3.10 |
| HUD 4 | 2.2 | Ghost 15 | 3.11 |
| HUD 5 | 2.4 | Ghost 16 | 3.12 |
| HUD 6 | 2.5 | Ghost 17 | 3.13 |
| HUD 7 | 2.9 | Ghost 18 | 3.14 |
| HUD 8 | 2.9 | Ghost 19 | 3.15; older relay: *not in the run* |
| Lobby 1 | 1.7 | Ghost 20 | 3.16; A/B: *not in the run* |
| Lobby 2 | 6.2 | Ghost 21 | *not in the run* |
| Lobby 3 | 5.2, 5.7 | Items 1 | 2.6 |
| Lobby 4 | 2.29 | Items 2 | 2.7 |
| Lobby 5 | 4.1 | Items 3 | 2.8 |
| Lobby 6 | 2.1 | Items 4 | 3.21 |
| Lobby 7 | 1.6 | Items 5 | 6.4 |
| Ghost 1 | 2.35 | Items 6–10 | 2.12–2.16 |
| Ghost 2 | 3.1 | Items 11–15 | 2.17–2.21 |
| Ghost 3 | 3.4 | Items 16, 17 | 2.22, 2.23 |
| Ghost 4, 5 | 3.2 | Items 18, 19 | 2.10, 2.11 |
| Ghost 6 | 3.3 | Items 20 | 2.24 |
| Ghost 7 | 3.20 | Items 21 | 3.18 |
| Ghost 8 | *not in the run* | Items 22 | *not in the run* |
| Ghost 9 | 3.5 | Items 23 | 2.25 |
| Ghost 10 | 3.6 | Items 24 | 2.26; A/B: *not in the run* |
| Ghost 11 | 4.2 | Items 25 | *not in the run* |
| Results 26 | 2.27, 2.28 | Results 35 | 2.32 |
| Results 27 | 2.29 | Results 36 | 2.31 |
| Results 28 | 2.30 | Results 37 | 2.34, 3.22 |
| Results 29 | *not in the run* | Results 38 | 1.4, 3.23, 4.6 |
| Results 30 | 2.28, 4.4 | Results 39 | 3.24 |
| Results 31 | 4.5 | Results 40 | 2.36 |
| Results 32 | 3.19; second half: *not in the run* | Results 41 | 6.1 |
| Results 33 | 4.5(b); second half: *not in the run* | Results 42 | 5.4, 5.6 |
| Results 34 | 2.33 | Results 43 | *not in the run* |

## Adding checks

CLAUDE.md asks every session that touches a feature to record what only the live sim can settle. Put a new check in the part of the run that already exercises that feature, as the next step number in that part, with the same `☐ pass ☐ fail` pair; if nothing in the run touches it, add a step to the closest part rather than a new list. Steps you add have no *(was …)* tag, and if one needs more than the two-pilot run can give it goes under **Not in the run** with what it takes.
