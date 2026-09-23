# race/ dead-code and superseded-UI audit

**Baseline:** `2dbe3ba` on `main`, client `CONFIG.VERSION` `1.3.1`, relay `PROTO = 5`.
**Scope:** `race/race.js`, `race/server/app.py`, `race/test/`, `race/tools/`, and the docs in
`race/` (README, PROTOCOL, ACCEPTANCE, courses/CUPS.md), plus the root README where it documents
race/ behavior.
**Nothing was deleted or changed.** This file is the only thing added.

## How this was done

1. **Identifier reference count.** A script listed every `function`, `const`/`let` and object
   method in `race.js`, then counted references with comments stripped, both inside `race.js` and
   in `test/run.js`. Anything with no caller was checked by hand.
2. **Module-method pass.** Each `Module.method` was counted as `Module.method` plus `this.method`
   inside its own module. That's how `Shell.toggleCollapsed`, `Hub.disconnect` and
   `Powerups.isShielded` turned up.
3. **CONFIG pass.** Every key in `CONFIG` was checked for a `CONFIG.KEY` read. **All 76 keys are
   read at least once.** No CONFIG key is unread.
4. **CSS pass.** Every `#id` and `.class` in `CSS`/`SHELL_CSS` was checked against the code that
   creates elements, allowing for dynamic classes like `'fr-pill-' + tone`. Then jsdom computed
   styles confirmed the one rule that matters (see B1).
5. **Server pass.** Every top-level `def` and `CONSTANT` in `app.py` was counted across the whole
   `race/` tree. Every route was matched to a client or landing-page caller.
6. **Test cross-reference.** Every `R.<module>.<name>`, `_internals.<name>` and
   `getElementById('<id>')` in `run.js` was checked against `race.js`. **No test references code
   that no longer exists.** Several tests do lock in superseded behavior; see §6.
7. **Test runs.** `node run.js` passed all 1576 checks. `pytest test_server.py` had 6 failures
   on a fresh unpinned install; see B5. With FastAPI 0.115.0 (Starlette 0.38.6), the lowest
   version `requirements.txt` allows, all 177 passed.

### Two ground rules that shape the classifications

- **`window.__finsRace` exposes every module.** `race.js:8191` puts `race`, `ui`, `shell`, `hub`,
  `lobby`, `powerups`, `countdown`, `results` and 20 other modules on `window`, and `_internals`
  exposes about 110 pure helpers. Under the requested definition ("not a window.* entry point"),
  **no method on an exported module can be proven DEAD.** Methods with no caller are therefore
  SUSPECT: reachable only from DevTools.
- **The test suite runs the rollback configuration by default.** `env()` defaults
  `lobbyV2 = false` (`test/run.js:98-104`), so every test before the 1.3.0 section runs the classic
  panel and the old floating lobby card. That code is flag-gated rollback, not dead. The shipped
  default, `LOBBY_V2: true`, is exercised only by the `Shell:` / `Hub:` / `1.3.1` sections.

---

## 0. Blockers found during the audit (not dead code; they gate the deletion plan)

These are live bugs or gaps. Most deletions below are unsafe until they're fixed.

| # | Finding | Evidence | Why it blocks deletion |
|---|---|---|---|
| **B1** | **`fr-hidden` does nothing on most shell elements.** `SHELL_CSS` has no generic `.fr-hidden` rule. It only has per-element rules (`#fr-shell.fr-hidden`, `.fr-screen.fr-hidden`, `.fr-ramp-rows.fr-hidden`, …, `race.js:5053-5226`). Every other element the shell toggles with `fr-hidden` stays visible: the top bar's `backBtn`, `wordmark`, `tabRow`, `roomChip`, `gateInvite`, `gateCount`, `statusPill`, `launchAbort` and `gateLeave` (`setScreen`, `5806-5814`); `#fr-shell-notice` (an empty amber box shows at all times); `#fr-shell-reopen` (the FR tab shows even when expanded); `gateStartAnyway`; `gateHostCourseRow`; and `gateChatCompose`. | jsdom `getComputedStyle` with the shipped CSS: `#fr-shell-notice.fr-hidden` → `block`, `.fr-shell-back.fr-hidden` → `flex`, `.fr-row.fr-hidden` → `flex`, `#fr-shell-reopen.fr-hidden` → `flex`. The tests only assert `classList`, so they can't catch it. | Several SUPERSEDED items depend on shell controls hiding correctly: guests would see host-only *Start anyway* and *Abort to gate*, and a card would show a *Leave* button with no room. Fix this before judging any Gate/Launch replacement "done". |
| **B2** | **The Gate doesn't fully replace the old lobby card.** Under the default `LOBBY_V2: true`, the old card is hidden by CSS (`race.js:5042`), and it's the **only** UI for these: **Start cup** (`Lobby.startCup`, called only at `7228`), **rules toggles** Powerups/Teleport (`Lobby.setRules`, called only at `7212`), a **non-force Start countdown** that uses the typed lead time (`7217`), a host course picker that includes **locally saved courses** (`7201`; the Gate's `hostSetCourse` reads `Courses.remote` only, `6209`), and **Copy room code**. | `grep -n "startCup\|setRules"` finds no shell caller. The root README checklist (`README.md:89,99`) and ACCEPTANCE 1.4 both ask the host to start a cup. | With default config, **cups and rules can't be set from the UI.** The old card can't be deleted until the Gate has these controls. |
| **B3** | **The picker focus after "Next race" goes to a hidden element.** `Results.nextRace` sets `wantPicker`, and `Results.focusPicker` (`2682`) focuses `UI.E.lobbyCourseSel`. That `<select>` is inside the CSS-hidden `#fr-lobby` whenever `LOBBY_V2` is on. | `focusPicker` has no shell branch. The test that covers it (`run.js:2668-2677`) runs with `lobbyV2: false`. | This is behavior of the old card only (S7). Delete it with the card, or port it to the Gate. |
| **B4** | **`KNOWN_TERRAIN_STATUS` is stale.** `race.js:5606` marks `gorge-run` and `crater-rim` as `'fail'`. Commit `9508a18` repaired both to version 2 and `courses/CUPS.md` lists them as flyable. `st-helens-crater` (pass) and the seven courses with findings are missing from the map. | Compare `race.js:5606` with `courses/CUPS.md` "Terrain status". | The Courses tab, the vote tiles and Launch show a wrong **Terrain fail** badge on two repaired courses. This is duplicated data (§5, H8), so a fix and a dedupe are the same change. |
| **B5** | **Six `test_server.py` hub tests depend on a private Starlette attribute.** `_drain_ws` (`test/test_server.py:2619`) reads `ws._send_queue`. Starlette 1.x's `WebSocketTestSession` no longer has it (it uses `_send_rx`). `requirements.txt` pins `fastapi>=0.115,<1`, so a fresh `pip install` pulls FastAPI 0.141 / Starlette 1.6 and those 6 tests fail. | They pass on FastAPI 0.115.0 / Starlette 0.38.6 (177 of 177) and fail on 0.141.1 / 1.6.0 (6 of 177). | CLAUDE.md says to run the server suite before every commit. Any deletion PR hits this on a clean machine. Pin `starlette` for tests or drain the socket through a public API. |
| B6 | *(minor)* Free-text chat reaches the HUD feed as `"callsign: "` with no text. `Lobby.onFrame`'s chat branch (`2151-2155`) formats `CHAT_LABELS[msg.code] \|\| msg.code`, and a proto-5 `chat{text}` frame has no `code`. | Read of `2151-2155`. | Doesn't block deletion. Noted because it's in the S1 area. |

---

## 1. DEAD: provably unreachable

The reference pass found **no uncalled closure-level function or constant in `race.js`**.
Everything in `race.js` with no caller sits on a `window.__finsRace` module, so it's classed
SUSPECT (§4). The provably dead items are:

| # | Item | Location | Evidence |
|---|---|---|---|
| D1 | CSS rule `.fr-gate-chat-compose.fr-hidden{display:none}` | `race.js:5204` | No element ever has the class `fr-gate-chat-compose`. `E.gateChatCompose` is built as `class: 'fr-row'` (`6192`). No CONFIG flag, hotkey, window entry point or test sets the class. **Don't just delete it:** `renderGateChat` (`6274`) relies on it to hide the compose box when `CHAT_ENABLED` is false, so today that flag hides nothing. The fix is to add the class to the element; see B1. |
| D2 | `OFFENSIVE_ITEMS = ("banana", "goop", "missile")` | `server/app.py:742` | No reads anywhere in `race/`, `app.py` or the tests (grep of the whole tree finds only the definition). The same set is written out as `Literal["banana", "goop", "missile"]` at `app.py:879`. |
| D3 | `RAMP_DAY_OFFSET_H = -7` | `server/app.py:758` | No reads. `ramp_day()` hard-codes its own default `offset_h: int = -7` (`app.py:157`), and its callers use that default. |
| D4 | `HUB_ACTIVITIES = ("idle", "gate", "racing", "solo")` | `server/app.py:762` | No reads. The validator is the pydantic `Literal["idle", "gate", "racing", "solo"]` at `app.py:1037`. |
| D5 | `race/.gitkeep` | repo | A 1-byte placeholder in a directory that has held real files since the folder was created. Nothing references it. |

Not dead, even though they look it: `LOBBY_PROTO` / `ITEMS_PROTO` / `RESULTS_PROTO`
(`app.py:708-710`) are documented as "kept for documentation" (PROTOCOL.md:19-20) and are asserted
by `test_server.py:374`.

---

## 2. SUPERSEDED: old UI replaced by the v1 shell (Ramp / Gate / Launch / Solo) or the HUD

"Still reachable" means reachable in the **shipped** configuration. All of these stay fully
reachable with `LOBBY_V2: false` (the rollback switch, F5).

| # | Old UI | Location | Replacement | Still reachable with defaults? | Notes |
|---|---|---|---|---|---|
| **S1** | **Floating lobby card `#fr-lobby`**: `UI.buildLobbyOverlay`, `UI.renderLobby`, `UI.copyRoomCode`, `UI.toggleReady`, and its CSS block | `race.js:7109-7243` (JS), `5453-5482` (CSS), suppression rule `5042` | **The Gate** (`Shell.buildGate` `6156`, `renderGate` `6276`) and **Launch** (`buildLaunch` `6346`, `renderLaunch` `6404`) | Built on every boot, and **re-rendered at `HUD_HZ` (10 Hz)** by `UI.hud()` → `renderLobby()` (`6853`), but always `display:none!important`. **Alt+Y** still goes through `UI.toggleReady()` (`8096`), which sends `ready` and then renders the hidden card. | Missing from the Gate before this can go: see **B2**. Alt+Y must be repointed to `Lobby.setReady(!Lobby.ready)` plus `Shell.renderGate()`. `lobbyCup`/`lobbyCupName`/`lobbyCupRaces` go with it. |
| **S2** | **The ready-check dialog**: *Force start* runs `confirm("<names> will become spectators. Start anyway?")` | `race.js:7219-7224` (inside S1) | Gate **Start anyway** (`6175`, no dialog) plus the client-side **auto-start** once every non-away racer has been ready for 3 s (`Shell._gateTick` `6325`, `autoStartDecision`, `AUTO_START_DEBOUNCE_MS` `5632`). The **Away** state (`awayState`, `AWAY_THRESHOLD_MS` `5631`) is the new "who's holding us up" signal. | Only through the hidden card, so effectively no. | README "Lobby" (`README.md:518-521`) still documents the confirm. |
| **S3** | **Manual-sync countdown (HH:MM:SS)**: the `details#fr-countdown` section, `E.cdBig`, `E.cdLead`, `E.cdTargetDisplay`, `E.cdJoinInput`, `E.cdStatus`, `UI.armCountdown`, `UI.joinCountdown`, `Countdown.armIn`, plus `E.lobbyProtoNote` (*"Server has no lobby; using local countdown."*) and `Lobby.isOldServer` | `race.js:6567-6571`, `6602-6609`, `6817-6834`, `1787`, `6594`, `7154-7156`, `2093` | The relay lobby's synced countdown on the **Launch** screen (`Lobby._onStart` → `Countdown.arm` → `Shell.setScreen('launch')`). | Yes, in the classic `#fr-root` panel that shows on the Solo tab. Only useful with no relay or a proto-1 relay. | **Keep the `Countdown` module itself**: `Lobby._onStart` uses `Countdown.arm()`. Only `armIn` and the UI are superseded. `E.cdLead` is also the lead-time box the S1 card's Start buttons read (`7217`, `7223`), and ACCEPTANCE.md:39 tells the host to set it. The Gate ignores it and always uses `CONFIG.COUNTDOWN_LEAD_S` (`6175`, `6340`). |
| **S4** | **The Powerups → Room input** (`E.puRoom`) and the implicit course-hash room it overrides | `race.js:6534-6540`, `6638`; `Powerups.room()` `2752`; `Lobby.syncConnection()` `2302` | Ramp **Have a room code?** (`rampJoinCode` / `joinByCode`), **+ New room**, **Quick match**, and **`?room=` invite links** (`Shell.copyInvite`, `parseRoomParam`), all via `Lobby.joinRoom()` (`2314`). | Yes. The input is visible in Solo → classic panel → Powerups. `syncConnection()` still runs on every course load and every Race-bus event (`8043`), so loading a course in **Solo** can still join the course-hash room (or the last stored room) behind the shell's back. | This is a behavior decision, not only a deletion: removing it changes what a Solo course load does to the relay socket. `README.md:462-463` and `583-586`, ACCEPTANCE.md:15/35, and the root README's `POWERUP_ROOM` row (`README.md:260`) all document the typed Room box. |
| **S5** | **The classic panel's course row**: `E.select` + **Load** + **↻**, **Fly to start** (`E.flyBtn`), **Reset run**, the timer/nav readout | `race.js:6589-6600`; `UI.renderCourses` `6777`, `UI.loadSelected` `6799`, `UI.flyToStart` `6750`, `renderStartHint` `6902` | **Solo card** (`Shell.buildSolo` `5929`: `soloSelect`, `soloLoad`, `soloFly`, `soloReset`, `renderSolo`) plus the **Courses tab**. The HUD already owns the timer while armed or running (`fr-hud-owns-timer`, `7587`). | Yes. Both are on screen together on the Solo tab. The Solo card says *"The classic panel below has the full settings…"* (`5946`). | **Only the course row is superseded, not `#fr-root`.** The leaderboard, ghost and rival pickers, Your plane, Sound, the Powerups loadout, *Log velocity frame*, and the course editor exist only in `#fr-root`. They also keep separate "last course" keys: `lastCourse` (`r:<file>`/`l:<id>`, read at boot `8176`) and `lastSoloCourse` (a course id, `5965`). |
| S6 | **Classic panel minimize**: `UI.minimize`, `Hud.autoMinimize`, `Hud.autoMin`/`expandedThisRun`, the `fr-min` class | `race.js:6727-6735`, `7426-7430`, `7446-7451` | Shell **collapse / auto-collapse** (`setCollapsed` `5749`, `autoCollapse` `5781`) | Partly. `#fr-root` only shows on the Solo tab, where it can still be minimized and auto-minimizes on arm. | Goes when S5 goes. Until then both collapse mechanisms run on a Solo arm: the shell collapses on `start` and `#fr-root` minimizes on `armed`. |
| S7 | **"Next race" course-picker focus**: `Results.wantPicker`, `Results.focusPicker`, `UI.E.lobbyCourseSel` | `race.js:2515`, `2682-2688`, `7196`, `7238`; call site `2189` | None in the Gate (see B3) | Called on every `lobby` frame, and a no-op when `LOBBY_V2` is on. | Delete with S1, or port to `E.gateHostCourseSelect`. |

### Placeholders (live, not superseded; listed so nobody mistakes them for dead code)

- **Season tab** (`race.js:5678-5679`, `.fr-screen-stub` CSS `5120-5122`) and the Ramp "your card"
  line *"Season stats are coming — see the Season tab."* (`6142`). These are "coming soon" stubs.
  No endpoint exists for them (ACCEPTANCE.md:318).

---

## 3. FLAG-GATED: reachable only behind a CONFIG flag

| # | Flag (default) | Gated code | Is the flag still meaningful? |
|---|---|---|---|
| **F1** | `POWERUP_CONTROL_EFFECTS: false` | `G.controlWobble` (`race.js:795-803`); the wobble block in `Powerups.tick` (`3037-3040`) | **No.** CLAUDE.md: *"No writes to aircraft controls. `POWERUP_CONTROL_EFFECTS` stays `false`."* The only thing this flag can enable is forbidden by project rule, so the code can never ship. Tests assert only that it's `false` (`run.js:1356`, `2048`). **Deletion candidate**, but the rule text in CLAUDE.md names the flag, so the user has to agree to drop it. |
| **F2** | `BOOST_LLA_FALLBACK: false` | `G.nudgeForward` (`708-719`); the `llaLocation` branch of `Powerups.applyBoost` (`3013-3016`) | **Yes, for now.** It's the escape hatch in case the confirmed scalar writes are readouts GeoFS overwrites (README "Writing to the aircraft"). README still says *"Powerups are entirely live-untested"* (`README.md:1248`). Revisit once ACCEPTANCE confirms Boost visibly moves the plane with the flag off. Tested at `run.js:994`, `1028-1046`. |
| F3 | `SAFE_WRITES: true`, `VELOCITY_FRAME: null` | The vector-write half of `G.accelerateTo` / `G.setVelocityFromFrame` (`548`, `574`); `CruiseWatch`; the *Log velocity frame* button (`6529`) | **Yes.** The frame hasn't been captured. The button hides itself once it is (`7071`). |
| F4 | `POWERUP_SPEED_PENALTY: false` | `Powerups.armPenalty` (`2830`), `penaltyTarget` (`3114`), `G.aglM` (`780`) | **Yes.** An opt-in feature waiting on playtesting (CONFIG comment `89-94`). |
| **F5** | `LOBBY_V2: true` (the `false` side is the gated one) | The whole classic-lobby boot path. When `false`: no Shell, no Hub, and S1–S7 become the primary UI. | **Yes, until the 1.3.x client is signed off live.** The ACCEPTANCE "1.3.0" and "1.3.1" sections are still open items. **Retiring this flag is the gate for batches 5–7.** It also decides whether the ~11 lobby/results tests on `lobbyV2: false` (§6) get migrated or deleted. |
| F6 | `LOBBY: true` (the `false` side is gated) | Race-scoped relay lifecycle (connect on `start`, disconnect on `finish`/`dq`/`reset`, `race.js:8033-8041`); the *"Synced countdown"* summary label (`6602`) | **Marginal.** This is the pre-0.8 world. The shell assumes `Lobby` (the Gate and Launch read `Lobby.state`), so `LOBBY: false` with `LOBBY_V2: true` isn't a coherent configuration. Retire it with F5. Test: `run.js:1365` "relay lifecycle (CONFIG.LOBBY off)". |
| F7 | `HUD: true` (the `false` side is gated) | Alt+H → `UI.toggle()` → `Shell.toggle()` (`8085`, `6722`) | **Low value but cheap.** This is 0.6.0's panel-only mode. Tested at `run.js:2940-2953`. See X4 for the stale comment. |
| F8 | Kill switches: `TRACE`, `GHOST`, `RACING_LINE`, `RIVAL_GHOSTS`, `WAYPOINT_BRACKET`, `MINIMAP`, `POWERUPS`, `ITEMS`, `HIT_SHAKE`, `RESULTS`, `COURSE_MAP`, `CHAT_ENABLED`, `SHELL_AUTO_COLLAPSE` | Their modules | **Yes.** CLAUDE.md requires a flag for every feature. One caveat: **`CHAT_ENABLED: false` currently hides nothing** (D1/B1). |

---

## 4. SUSPECT: looks dead, but can't be proven

| # | Item | Location | Why it can't be proven dead |
|---|---|---|---|
| X1 | `Shell.toggleCollapsed()` | `race.js:5770` | No caller in `race.js` or the tests. It's reachable as `window.__finsRace.shell.toggleCollapsed()`. It looks like it was meant for a hotkey that was never bound. The collapse button and reopen tab call `setCollapsed()` directly. |
| X2 | `Hub.disconnect()` | `race.js:2415-2425` | No caller. It's reachable as `window.__finsRace.hub.disconnect()`. It mirrors `Relay.disconnect()`, but nothing in the shell ever drops the hub socket. That may be intended (the hub lives for the whole page) or a missing path, for example the hub staying up with `API_BASE` cleared at runtime. |
| X3 | `Powerups.isShielded(now)` | `race.js:2818` | Production never calls it: every production check is `powerupsActive(state, 'shield', now)`. **Three tests use it** (`run.js:1056`, `1057`, `1310`), so it isn't DEAD by the stated rule. Fold it into the tests as `powerupsActive(...)`, then delete. |
| X4 | `Shell.toggle()`'s **hide** branch | `race.js:5736-5744` | It's only reached through `UI.toggle()`. With the default `HUD: true`, that happens only on a second bookmarklet click (`race.js:8`), which always passes `force = true`, so it only shows. The hide branch runs only with `HUD: false` (F7). Its comment (`5740-5741`) *"Alt+H means 'all of it away'"* is wrong for the default config, where Alt+H toggles only the HUD (`8085`, tested `run.js:2948`). |
| X5 | `window.__finsRace._internals` (~110 names) | `race.js:8196-8216` | This is the test harness's whole surface, so every name is test-reachable by construction. Unused *exports* can't be seen from inside `race.js`. |
| X6 | `window.__finsRace.countdown` / `Countdown.armIn` | `race.js:8191`, `1787` | Used only by S3's *Arm* button and by `run.js:489`. It dies with S3 unless it's kept as a console tool. |
| X7 | `Race.unload()` | `race.js:1281` | One caller: `Editor.deleteSelected` (`7907`), when you delete the saved course you're currently on. Rare, but live. Listed only because the reference count flagged it. |

---

## 5. Duplicated helpers

| # | Duplicate | Locations | Recommendation |
|---|---|---|---|
| H1 | **Ordinal suffix**: `ordinal(n)` (HUD) and `ordinalOf(n)` (Results) | `race.js:7345`, `1598` | Use `ordinalOf` in both. `ordinal` is **wrong for 21 and up** (`21` → `"21th"`, because its teen-correction expression indexes the table with `n % 100`, not `n % 10`). It's latent today because `ROOM_MAX_PILOTS` is 12. |
| H2 | **Draggable header**: `UI.makeDraggable` and `Shell._makeDraggable` | `race.js:6701-6720`, `5715-5734` | Same algorithm with a different element, clamp and storage key. Use one `makeDraggable(handle, el, storeKey, clamp)`. |
| H3 | **Clipboard copy**, three ways: `Shell.copyInvite` (with a `textarea` + `execCommand` fallback), `UI.copyRoomCode` and `Results.copyChallengeLink` (sync `try` around an async `writeText`, so their `catch` never sees a rejection), and `Editor.copy` | `race.js:5853-5862`, `7140-7144`, `2723-2736`, `7891` | Use one `copyText(text, label)` helper. The two `try { navigator.clipboard.writeText() }` versions report "copied" even when the write is rejected. |
| H4 | **"Find a course by id → fetch it → `Race.load` / `Course.normalize`"**, written 8 times | `UI.loadSelected` `6800`, `Shell.soloLoad` `5955`, the `renderLobby` pickBtn `7203`, `Shell.hostSetCourse` `6204`, `Shell.enrichVoteCandidate` `6215`, `UI.raceNewsGhost` `6986`, the boot challenge loader `8153`, `Lobby.maybeLoadCourse` `2219` | Two keying schemes exist: `r:<file>`/`l:<id>` (classic) and bare course id (shell). Only `maybeLoadCourse` falls back to local courses and checks the hash. Use one `Courses.resolve(id)` for all of them. |
| H5 | **Two course pickers with two "last course" keys**: `lastCourse` and `lastSoloCourse` | `race.js:6807/8176` and `5965/5984` | Merges with S5. |
| H6 | **Socket lifecycle**: `Relay` and `Hub` have near-identical `_open`/`_retry`/`send`/`disconnect` | `Relay` `race.js:1953-2062`, `Hub` `2349-2432` | The duplication was deliberate ("modeled directly on Relay"), and the two sockets must fail independently. A small shared `makeSocket()` factory could still keep that independence. Low priority. |
| H7 | **Longitude wrap**, written three ways: `wrap180`, `destination()`'s inline `((l2/D2R + 540) % 360) - 180`, and `angleDelta` | `race.js:3085`, `833`, `3769` | Cosmetic. `destination` could call `wrap180`. |
| H8 | **Terrain status stored twice**: `KNOWN_TERRAIN_STATUS` (JS) is a hand-kept copy of README "Shared course status" and CUPS.md | `race.js:5606` | Already stale (B4). Store it once, for example as a `terrain` key in `courses/index.json`, which the client already fetches and which isn't part of the course hash. |
| H9 | **Enums duplicated on the server** as a named constant and a pydantic `Literal` | `app.py:742`↔`879`, `762`↔`1037`, `157`↔`758` | See D2–D4: keep the `Literal` and delete the constant. |

---

## 6. Tests that pin superseded behavior

**No test references code that no longer exists.** Every `R.x.y`, `_internals` name and
`getElementById` in `run.js` resolves in `race.js`. These tests do lock in S1–S7 and F5/F6, and
each has to be deleted or migrated in the batch that removes its code:

| Test (`test/run.js`) | Line | Pins |
|---|---|---|
| "Lobby: the relay connects for the lobby independent of Race.state, and the proto gate hides it" | 2222 | S3 (`lobbyProtoNote`, `#fr-countdown` "Manual sync"), S1 (`#fr-lobby` stays hidden), S4 (stored `powerupRoom` auto-joins) |
| "Lobby: ready flips, host detection, spectators, and the chat enum" | 2334 | S1 (`UI.toggleReady`) |
| "Results: the final table, cup standings, awards and the buttons a host and a guest get" | 2627 (asserts at 2668-2677) | S7 (`wantPicker`, focus lands on a `SELECT` in `#fr-lobby`) |
| "Results: the lobby shows the running cup, and only a proto-4 host is offered 'Start cup'" | 2834 | S1 cup controls (`lobbyCup`, `lobbyHost`, `lobbyCupName`). **Migrate, don't delete.** It's the only coverage for cups (B2). |
| "Shell: LOBBY_V2 suppresses the OLD floating lobby card …" | 4414 | The S1 suppression rule `body.fr-shell-active #fr-lobby` |
| "Powerups: relay lifecycle (CONFIG.LOBBY off)" | 1365 | F6 |
| "HUD: Alt+H toggles the HUD … falls back to the old panel-hide toggle when CONFIG.HUD is false" | 2940 | F7 |
| "1.3.1 rollback: CONFIG.LOBBY_V2 = false still boots the classic panel" | 4969 | F5 |
| `lobbyEnv()` helper and every Results test built on it | 2490 | Runs the whole Results suite with `lobbyV2: false`. When F5 retires, flip its default so Results is tested in the shipped configuration. |
| "Powerups: … control effects are off by default" / "control-write flag is still off" | 1354-1356, 2048 | F1 (they assert only that the flag is `false`) |
| `Countdown: no-op with no course loaded` (`CD.armIn`) | 489 | X6 |

`test_server.py`: no test pins a superseded server path. `_drain_ws` is environment-fragile; see B5.

---

## 7. Stale docs

| # | Doc | Location | What's stale |
|---|---|---|---|
| R1 | race/README.md file tree | `README.md:8-30` | *"PROTOCOL.md … proto 1–4"*, but proto 5 is documented. `tools/hub_smoke.py` is missing, and so is `docs/` (added by this PR). |
| R2 | race/README.md Controls | `README.md:75` | *"Alt+H — Hide/show panel"*. With the default `HUD: true` it toggles the HUD only (`race.js:8085`, test `run.js:2948`). The root README (`README.md:70`) is correct. |
| R3 | race/README.md Controls | `README.md:83-84` | *"Fly to start, the button under the course row"*. It's also on the Solo card now, and that's where players are pointed. |
| R4 | race/README.md "Lobby" | `README.md:500-537` | Describes the **old card**: joining the course-hash or typed room, "the lobby card shows every pilot", **Force start … after a confirm naming who**, and *"there's no free-text chat"* (proto 5 added it). There's no description of the Ramp, Gate or Launch anywhere in `race/README.md`. The only player-facing description is in the root README (`README.md:34-45`). |
| R5 | race/README.md "Results and cups" | `README.md:572-586` | *"presses **Start cup** in the lobby card"* and *"the cursor lands in the course picker"*. Under the default config neither is reachable (B2, B3). *"Type the same room code into the Relay room box"* describes S4. |
| R6 | race/README.md "Without the relay" | `README.md:462-463` | *"type a **Room** code to override that"* describes S4. |
| R7 | race/README.md "Shared course status" | `README.md:235-266` | *"All four courses"* (there are 16). It lists gorge-run and crater-rim as **FAIL** and "not flyable as authored", but both were repaired in `9508a18` (see CUPS.md). |
| R8 | PROTOCOL.md "Proto 2: lobby" intro | `PROTOCOL.md:387-390` | *"see 'Manual sync' below"*. There's no such section. |
| R9 | PROTOCOL.md "Route" and proto-5 compatibility | `PROTOCOL.md:30`, `789`, `1076` | *"derives `room` from the course hash by default, or a hand-typed code"* and *"types a code as before"*. True only for the classic path. Proto-5 clients join by Ramp, code or invite link. |
| R10 | ACCEPTANCE.md, Parts 0–5 | `ACCEPTANCE.md:15`, `35`, `39`, `41`, `44`, `145`, `174`, `184`, `186` | The race-night script predates 1.3.0. It uses *Powerups → Room*, "the lobby card", the *Manual sync* lead-time box, **Start cup** in the card (1.4), and "the cursor is in A's picker" (3.24). Under the default config, steps 1.1, 1.4 and 3.24 can't be done as written. Parts 1.3.0/1.3.1 (`223-370`) are current. |
| R11 | courses/CUPS.md | line 3-4 | *"the lobby card's **Start cup**"* (B2). |
| R12 | Root README CONFIG table | `README.md:210`, `260` | `COUNTDOWN_LEAD_S` *"… and under 'Manual sync'"* and `POWERUP_ROOM` *"the typed Room box"*. Both describe S3/S4. The Gate never reads the lead-time box. |
| R13 | `race.js` comments | `5740-5741` ("Alt+H means 'all of it away'"), `5692-5693` ("see the comment on _applyRootVisibility() above", but it's below) and `5795` ("set once in init() below", but it's above), `6516` ("Phase 1: loadout, no relay") | These are code comments, not docs. They're listed because they'll mislead whoever runs batches 5–7. |

---

## 8. Ranked deletion plan

Ranked by certainty and blast radius: the safest first. Each batch is one PR, runs both test
suites (after B5 is fixed), bumps `CONFIG.VERSION` only where a change is user-visible, and
comes with a one-line in-sim smoke test to run on geo-fs.com before merging. **Batches 0 and 4
aren't deletions.** They're the fixes and parity work the later batches depend on. They're
listed because merging 5–7 without them would regress live behavior.

### Batch 0: fix first (not deletions)
- B1: add `#fr-shell .fr-hidden, #fr-shell-reopen.fr-hidden { display: none }` (or the
  per-element rules), and add `fr-gate-chat-compose` to `E.gateChatCompose` (fixes D1). Add a
  test that checks **computed** display, not `classList`.
- B5: drain the socket without `_send_queue`, or pin `starlette` for the test run.
- B4: correct `KNOWN_TERRAIN_STATUS` from CUPS.md.
- **Smoke:** *Open the panel as a guest in someone else's room: the top bar shows only Back, room
  chip, count, Leave and –, there's no empty amber notice box, no FR tab while expanded, and no
  Start anyway / Abort to gate.*

### Batch 1: provably dead and doc truth (zero behavior change)
- Delete D2–D4 (server constants). Delete D5 (`.gitkeep`).
- Fix the stale docs that describe the **current** default wrongly and don't depend on later
  batches: R1, R2, R3, R7, R8, R11 (partly), R13's Alt+H comment.
- **Smoke:** *`curl https://race.finsonly.net/health` returns `{"ok":true}`, then a hub `ping_ramp`
  from `tools/hub_smoke.py` still reaches the second client (the ramp-day and activity paths
  still validate).*

### Batch 2: POWERUP_CONTROL_EFFECTS (F1)
- Needs the user to agree first: CLAUDE.md names the flag.
- Remove `G.controlWobble`, the wobble block in `Powerups.tick`, the flag, and its two
  "flag is false" asserts. Replace them with one assertion that `G` has no `controlWobble`.
- **Smoke:** *Take a banana and a missile hit in a lobby race: screen tint and wobble only, the
  stick stays centered, and there's no roll input in GeoFS's own control display.*

### Batch 3: SUSPECT cleanup and helper dedupe (no UI change)
- X3: move `isShielded` into the tests as `powerupsActive(…, 'shield', …)`, then delete it.
- X1: delete `Shell.toggleCollapsed`, or bind it to a key (the user decides).
- H1: use `ordinalOf` everywhere and delete `ordinal`. H2: one `makeDraggable`. H3: one
  `copyText`. H7: `destination` uses `wrap180`. H9 is done in Batch 1.
- **Smoke:** *Drag both the shell and (on Solo) the classic panel, reload, and both keep their
  positions. Copy invite and copy challenge link both paste a working URL. The HUD rank reads
  "1st", "2nd", "3rd".*

### Batch 4: bring the Gate to parity (prerequisite for 5, not a deletion)
- Port to the Gate: **Start cup** (name + 1–12 races, proto ≥ 4, host only), **rules toggles**
  (Powerups/Teleport, host only), local courses in the host picker, and the course-picker focus
  after **Next race** (B2, B3). Move `run.js:2834`'s cup coverage to the Gate.
- Repoint Alt+Y to `Lobby.setReady(!Lobby.ready)` plus a Gate re-render.
- Update R5, R10 (steps 1.1, 1.4, 3.24), R11, and README "Lobby" (R4) to describe the Gate.
- **Smoke:** *As host on the Gate, start a 3-race cup and toggle Teleport off. The guest's Gate
  shows the cup chip and "Teleport off", and after race 1 "Next race" lands the host on the Gate
  with the course picker focused.*

### Batch 5: delete the old lobby card and the ready-check dialog (S1, S2, S7)
- Needs Batch 4 merged, plus a user decision that `LOBBY_V2: false` stops meaning "old lobby card".
  Either retire F5 here, or keep F5 as "no hub, same Gate".
- Delete `UI.buildLobbyOverlay`, `renderLobby`, `copyRoomCode`, `toggleReady`, the `#fr-lobby`
  CSS, the `body.fr-shell-active #fr-lobby` rule, the `confirm()` force-start, and
  `Results.wantPicker`/`focusPicker`/`lobbyCourseSel`. Remove `renderLobby()` from `UI.hud()`
  and from the six `Lobby` call sites (`2135`-`2210`).
- Delete or migrate the tests at 2334, 2668-2677 and 4414. Flip `lobbyEnv()` to `lobbyV2: true`.
- **Smoke:** *A two-client lobby race from Ramp → Gate → ready (click and Alt+Y) → Launch →
  results → Rematch, with no floating plum card appearing at any point and no console errors.*

### Batch 6: manual sync, typed room box, LOBBY: false (S3, S4, F6)
- Needs a user decision: without a relay, is Solo alone enough, with no local countdown for
  voice-chat starts? And should a Solo course load ever join a relay room on its own (S4)?
- Delete `details#fr-countdown`, `UI.armCountdown`/`joinCountdown`, `Countdown.armIn`,
  `lobbyProtoNote`/`Lobby.isOldServer`, `E.puRoom`, `CONFIG.POWERUP_ROOM` (if S4 goes), and the
  `!CONFIG.LOBBY` relay lifecycle (retire `CONFIG.LOBBY`). Make `Lobby.syncConnection` run only
  for explicit joins, or remove it. Update R6, R9, R12. Delete or migrate tests 2222, 1365 and 489.
- **Smoke:** *Load a course from Solo with a relay configured: no relay socket opens (DevTools →
  Network → WS) until you Join a room from the Ramp, and the Ramp → Gate → Launch countdown
  still runs.*

### Batch 7: collapse the classic panel into Solo (S5, S6, H4, H5)
- The largest change and the last. Move the leaderboard, ghost/rival pickers, Your plane,
  Sound, the Powerups loadout, *Log velocity frame* and the course editor onto Solo (or a
  Settings tab). Then delete `#fr-root`'s course row, `UI.minimize`/`Hud.autoMinimize`, and
  `lastCourse`/`lastSoloCourse` duplication behind one `Courses.resolve(id)`.
- F7 (`HUD: false`) either goes here or gets redefined, since "hide the panel" no longer means
  one panel.
- **Smoke:** *On Solo only: load an air-start course, Fly to start, finish a run, see it on the
  leaderboard, pick "My best" as the ghost and race it. Then reload and the same course comes back
  selected, with one panel on screen throughout.*
