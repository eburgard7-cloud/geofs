# Changelog

All notable changes to FINSONLY Racing, newest first, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Versions are the client's
`CONFIG.VERSION`. The server reports its own `SERVER_VERSION` on `GET /version`. Details are in
[README.md](README.md), [PROTOCOL.md](PROTOCOL.md) and the [runbook](../docs/RUNBOOK.md). What still
needs the live sim is in [ACCEPTANCE.md](ACCEPTANCE.md). Dates are the day the change landed on
`main` (from git history).

Versions 0.1–1.3.1 predate this file. Their history is in git and in the per-feature notes of
[README.md](README.md) and [PROTOCOL.md](PROTOCOL.md).

## [Unreleased] — start-flow: minimize before GO, throttle keys reach GeoFS, a 20 s default lead

`CONFIG.VERSION` stays as shipped until [ACCEPTANCE](ACCEPTANCE.md#countdown-grid-teleport-and-rolling-start)
(SF1–SF4) passes in-sim. No relay frame changed.

### Added
- **`SHELL_CLICK_AWAY`**: a pointerdown outside `#fr-shell` (and its reopen tab, and any other
  `.fr-ui` surface — toasts, the landing scorecard, …) collapses the shell, so a pilot doesn't have
  to find the collapse button before clicking into the sim. **Esc** (focus in the shell, not in a
  text field) collapses it too, under the same flag.
- **`SHELL_KEY_HANDBACK`**: focus hand-back plus narrowed key isolation (see Changed below). Off
  restores 1.6.x exactly: `#fr-shell` stops every key, and nothing is blurred.
- **`COLLAPSE_ON_SPAWN`**: for a lobby grid or rolling-start race, the shell now collapses the
  moment the countdown arms **and** this pilot is actually placed for it, instead of waiting for
  GO — the whole lead time is free to set up the throttle. A skipped teleport (ground start,
  teleport off, not on the grid) still falls back to the existing GO-time auto-collapse. A manual
  reopen (Alt+K) during that window is honored for the rest of the run, same as reopening after GO
  always has been.
- **HUD countdown + throttle readout**: while a lobby countdown is armed or has just gone green,
  the HUD's own timer plate shows a big centered T-minus (and `GO`) instead of `0:00.000` — the one
  clock left on screen once `COLLAPSE_ON_SPAWN` has taken the shell away — plus a `THROTTLE`
  readout (`GeoPhysics.throttle()`, read-only) that goes green once it's above half, or once the
  pilot has moved it from where the countdown started.
- **Lead-time presets**: `COUNTDOWN_LEAD_S` default 10 → 20, and the free-text lead-time number
  input (Solo tab's no-relay manual sync, and a new host-only picker on the Gate screen for the
  room countdown) is now a `COUNTDOWN_LEAD_PRESETS_S` preset select (10/20/30/45 s), remembering
  the host's last pick (`store` key `countdownLeadS`, shared by both surfaces).

### Changed
- Key isolation inside `#fr-shell` narrows to editable targets only (`input`/`textarea`/`select`/
  contenteditable) — a focused **button** no longer swallows every keydown/keyup/keypress the way
  it did through 1.6.x, so clicking Ready or Start and then reaching for the throttle key actually
  works. Enter/Space on a focused button stay the button's own: it activates once, natively, and
  the key is stopped so GeoFS doesn't also act on it (no double fire, and keyboard users can still
  press shell buttons). Every other key reaches GeoFS. Pure `shellKeyRoute`,
  `clickAwayShouldCollapse` and `throttleReadout` are exported to the test harness.
- Whichever path collapses the shell (button, click-away, Esc, an auto-collapse), and every
  spawn/teleport that hands a pilot the controls for a start (grid, formation, solo Fly to start),
  now blurs a focused control inside the shell first, so a key meant for GeoFS never lands back on
  a button instead.

### Fixed (found before release)
- The HUD T-minus subtracted the render clock (`clockNow()`, a `performance.now()` clock) from
  `Countdown.target` (epoch ms), so it would have shown a ten-digit number in-sim. It now uses
  `Date.now()`, like the Launch screen. The test pins it to seconds-to-GO.

## [Unreleased] — site-3d-resilience: the HQ site's 3D globe recovers instead of wedging on 2D

`SITE_VERSION` (race/server/static/js/config.js) is now `hq-1.1.1`. Client only
(`race/server/static/**`); the tile *routes* themselves are a parallel branch's work.

### Fixed
- **globe.js's tile-host probe cache**: a success is still cached for the tab, but a failure now
  expires after 15 s instead of forever. Under hash routing (which never reloads the page) one bad
  tile response used to leave every globe in the tab stuck on the 2D fallback for the rest of the
  visit; a later mount now gets a fresh probe. A visitor-driven "Retry 3D" bypasses the cache
  outright rather than waiting out the 15 s.
- The 2D fallback note used to say "aren't reachable from here" for any failure, including this
  site's own tile proxy erroring out. It now distinguishes CSP/network ("blocked on this network")
  from an upstream 5xx ("The map server hit an error; 3D is temporarily unavailable"), via
  `site.js`'s `classifyBlockReason`. The short reason code is always in the note's `title`; `?debug=1`
  still appends it inline.
- The fallback note no longer sits `position:absolute` over the 2D route/replay stage (it could
  cover gates near the top edge, e.g. `angkor-tonle-sap`'s 7–9). It's now a normal-flow bar under
  the stage (`.viewer-fallback`, not the `.viewer-note` overlay class, which stays for the
  "terrain is flat" degraded-3D note).
- 2D framing: `makeProjector`/`routeMiniMap` take an asymmetric pad (`{top, right, bottom, left}`,
  `site.js` `normPad`). The course map (top 56) and the replay stage (top 100, under its HUD chips)
  fit the route bounds with extra headroom where gate labels and the HUD sit, so a height-bound
  route's northernmost gates (angkor-tonle-sap 7–9) are never clipped or covered.
- Replay's camera buttons (1–5) and the "Clamp ghosts above terrain" toggle are disabled
  (`title="3D only"`) until a 3D mount succeeds, and keys 1–5 are ignored too — 2D replay had no
  camera to switch, so they used to just silently do nothing.
- "Copy link at this moment" no longer sits visually higher than the camera buttons beside it (a
  stray `margin-top` on `.cams` meant for its usual spot under the stage).
- The route-change heading focus (`app.js`, for screen readers) no longer draws a visible focus
  ring. It was never a keyboard tab stop, so the big yellow outline was a false affordance. Any
  `tabindex="-1"` target is ring-free; real controls keep their `:focus-visible` ring.

### Added
- A "Retry 3D" button on the fallback note on the course page, the replay page, and the home hero
  (after a visitor has opted into the flyover). Re-runs the same mount; no double mount or leaked
  Cesium widget (the existing dead/abort guards cover the retry path too).
- `site.js`: `probeCacheValid`, `classifyBlockReason`, `normPad`, `PROBE_FAILURE_TTL_MS` (pure,
  tested). `site_smoke.py`: a tile-route 500 shows the server-error note + Retry 3D with zero CSP
  violations, and Retry mounts a Cesium canvas once the upstream recovers (no reload); a 2D replay
  has its camera buttons, clamp toggle and keys 1–5 disabled.
  `globe.js`: `buildFallbackNote`, `fallbackText`, `reasonCodeOf`.

## [Unreleased] — landing-score-v2: a fixed sink-rate curve, a geometric sink check, a HARD LANDING badge

`CONFIG.VERSION` stays `1.7.0` until [ACCEPTANCE](ACCEPTANCE.md#landing-score-v2) passes in-sim.
`PROTO` stays 9: no relay frame changed (see PROTOCOL.md "Landing score v2"). `SERVER_VERSION` ->
1.7.0.

### Fixed
- **Landing scores floored at 0 for every ordinary landing.** `score_touchdown()`'s vertical-speed
  penalty was the only uncapped component (`60 * (|vs| - 0.5) ** 1.6`, no ceiling), contradicting
  its own docstring's promise that each penalty's cap keeps one bad component from zeroing the
  score: 600 fpm already cost ~270 points and 1000 fpm ~680, so a normal firm landing (not a crash)
  routinely hit 0, and every bad landing tied at "Personal best 0, rank 1". Found in-sim 2026-09-24
  (Portland 10R, -1794 fpm/1744 fpm sink, scored 0).

### Changed
- **Sink-rate scoring v2**: no penalty up to 240 fpm (was a flat 0.5 m/s "greaser" band), a smooth
  ramp through 600 fpm, a steeper ramp through 900 fpm, then an asymptotic tail capped at
  `LANDING_VS_CAP` (450) — so, as the docstring says, this component alone can no longer zero a
  score. Calibration (see `score_touchdown()`'s docstring for the full table): a clean 180 fpm
  landing scores 900+, an average 450 fpm/50 m out/6 m off landing scores ~700-750, an isolated
  firm 800 fpm landing scores ~580-650 (not ~450 — the cap makes that unreachable from vs alone,
  see the docstring), and a genuinely crash-grade landing (1800 fpm, a bounce, badly off zone/
  centerline/crab all at once — a real write-off is never just one bad number) scores in the
  50-150 range, only rarely 0.
- Every stored `landing` row was rescored once on deploy under the new formula
  (`rescore_landings_v2()`, called on every server start like `migrate_modes()`; idempotent, and
  additive-only — nothing is inserted or deleted, `metric_value`/`payload_json` are rewritten in
  place). `LandingPayload` already stored the raw touchdown/bounce_count/total_rollout_m a score
  was computed from, so no client replay was needed (case A of the "raw inputs stored?" question).

### Added
- **`touchdown.vs_geom_mps`** (race/touchdown.js): a least-squares sink rate fit to the last ~500ms
  of altitude before contact (`leastSquaresSlope()`, `DEFAULT_SINK_WINDOW_MS`), alongside the
  existing `vs_at_contact`. `score_touchdown()` scores `min(|vs_at_contact|, |vs_geom_mps| * 1.25)`
  when both exist, so one lagged or spiky GeoFS `verticalSpeed` sample can no longer zero a landing
  by itself. Null when the detector didn't see enough airborne samples to fit one (an old client,
  or a very short approach) — the server falls back to `vs_at_contact` alone, same as before.
- **`hard_landing`** flag (sink >= `LANDING_HARD_VS_FPM`, 1000 fpm): in `score_touchdown()`'s
  breakdown, `POST /landings`'s response, and a "⚠ HARD LANDING" badge on the scorecard — a state,
  not just a number.
- **`score_version`**: on the stored breakdown, `POST /landings`'s response and
  `GET /landing-leaderboard`'s response (currently `2`). See PROTOCOL.md "Landing score v2".
- Scorecard: an "Aim zone `min`-`max` m" row from the runway's `zone`; the sink row shows the
  server-scored reading and, when `vs_at_contact` and `vs_geom_mps` disagree by more than 25%,
  both readings side by side; a 0 score reads "unranked" instead of a confusing "rank 1".

### Tests
- Server: the calibration table as parametrized tests; every penalty capped except the
  deliberately-uncapped `bounce_penalty`; the `hard_landing` threshold; the `vs_at_contact`/
  `vs_geom_mps` blend (both directions); `score_version` on every response;
  `rescore_landings_v2()` idempotent and skipping a runway-version mismatch.
- Client (`run.js`): `leastSquaresSlope()` on synthetic altitude traces (flat, perfectly linear,
  noisy, too few points); the detector emits `vs_geom_mps` on a realistic descent and `null` when
  there isn't enough pre-contact history; `race.js`'s `Touchdown` copy stays byte-identical to
  `touchdown.js`; `scorecardRows()`'s new aim-zone row, hard-landing flag and dual-sink display.

## [Unreleased] — ramp-single-owner: one tab holds the ramp, no more reconnect flicker

`CONFIG.VERSION` stays `1.7.0` until the in-sim ACCEPTANCE rows below pass. `PROTO` stays 9: no
relay frame changed, only the hub's close-code behavior (additive, see PROTOCOL.md "Route").
`SERVER_VERSION` -> 1.6.3.

### Fixed
- Two GeoFS tabs in one browser share `localStorage`, hence one `pilot_token`. Without
  coordination, each tab's hub `hello` replaced the other's `/ws/hub` connection, and the replaced
  tab's `onclose` reconnected unconditionally — so the two tabs fought forever, each replacing the
  other every `POWERUP_RECONNECT_MS` (~2 s): "Ramp disconnected — reconnecting" flickered
  continuously and the pilot blinked on and off everyone else's presence list. Racing itself was
  unaffected (a separate socket, PROTOCOL.md's "a pilot who never opens the hub races exactly as
  they did in 1.1.0").

### Added
- **`CONFIG.RAMP_SINGLE_OWNER`** (default on). A `BroadcastChannel('finsRace-hub')` tab election
  (best-effort fallback with no coordination if `BroadcastChannel` is unavailable) so only the
  owning tab opens `/ws/hub`; a non-owning tab shows "Ramp is open in another tab" and a "Use ramp
  here" button that hands ownership over cleanly (`pagehide`/teardown of the owner also releases
  it). The server's replaced-socket close is now `4001` reason `"replaced"` (was `1001`); the
  client never auto-reconnects on `4001` — any other close code keeps today's backoff. The
  reconnect banner only shows after the ramp has been down continuously for
  `CONFIG.RAMP_RECONNECT_BANNER_DEBOUNCE_MS` (8 s default), clearing immediately on reconnect. Off
  restores today's behavior exactly: every tab opens its own hub connection and retries on every
  close code.
- **`HUB_REJOIN_GRACE_S`** (server, default 6 s). A pilot whose hub socket closes stays on
  `presence` for this long before being dropped, so a reconnect inside the window — the same tab
  after a network blip, or a tab handoff — causes no presence change for anyone watching the ramp.
- Every hub close code and reason is now logged to the Debug overlay (Alt+D).

### Tests
- Server: a replaced socket gets `4001`/`"replaced"`; a reconnect inside `HUB_REJOIN_GRACE_S`
  causes no presence change; the reaper still drops a pilot whose heartbeats stopped
  (`HUB_DROP_S`, unaffected by the grace logic); the grace window really drops a pilot once it
  elapses.
- Client (`run.js`): `hubShouldRetryClose` (only `4001` says no), `hubShowReconnectBanner`
  (debounce), `hubOwnerReduce` (the BroadcastChannel election's pure step, with a mock channel),
  and `RAMP_SINGLE_OWNER: false` restoring the pre-fix retry-on-everything behavior.

## [Unreleased] — robot-and-landing: the Landing tab, the robot test pilot, House ghosts

`CONFIG.VERSION` stays `1.7.0` until [ACCEPTANCE](ACCEPTANCE.md#landing-challenge) passes in-sim.
`PROTO` stays 9: no relay frame changed (see PROTOCOL.md "The House ghost and the reserved callsign").

### Added
- **Landing tab** (`CONFIG.LANDING`, `LANDING_CUP`, `LANDING_SETTLE_TIMEOUT_MS`,
  `LANDING_GS_DOT_DEG`, `LANDING_LOC_DOT_DEG`). A runway picker grouped by landing cup with
  difficulty chips and your best and top 3. A spawn on the approach (`landingSpawn()`: 3 nm / 3°
  or the runway's `approach` override, at the aircraft's `approachKt`, throttle 0.4). The Landing
  HUD (ILS localizer and glidepath dots, height on the path, sink, IAS, AGL, a stability pill). The
  touchdown detector, a verbatim copy of `touchdown.js` checked by a drift test. `POST /landings`
  on settle, and the server's scorecard with PB and rank. Retry, Next runway, and a four-runway
  **Landing Cup**. A runway's `env` is applied and restored like a course's.
- **Guidance** (pure): leg bearing/distance, turn radius and fly-by lead, the gate switch distance
  (the lead capped so the arc stays in the gate), rate-limited altitude commands in feet,
  glidepath, runway frame, virtual ILS dots, approach steering, stability. Plus
  `GeoPhysics.autopilotTo({courseDeg, altFt, speedKt})`, and G reads `haglM`, `vsFpm`,
  `groundContact`, `landingSample` and `nearestRunway` (TODO-PROBE).
- **Robot test pilot** (`race/tools/robot_pilot.js`, the ROBOT dev bookmarklet, via the new
  dev-only `window.__finsRace.dev`, `CONFIG.DEV_API`). COURSE mode flies gate to gate and reports
  PASS / FAIL / UNREACHABLE / SKIPPED per course with a per-gate log. APPROACH mode flies each
  runway's ILS to 50 ft and goes around, reporting PASS / TERRAIN / OFFSET / SPAWN_LOW. Batches
  pause for aircraft switches. `race/tools/robot_report.py` writes `docs/reports/<date>/ROBOT.md`
  with suggested fixes that are never applied.
- **House ghosts**: `POST /ghosts/house` (`RACE_ADMIN_TOKEN`, Bearer; 503 when unset) stores a
  robot PASS trace under callsign `HOUSE`. It's in `/ghosts` (`is_house`) and the site's replay,
  and on no board, record, medal, news item, pilot page or cup. The site's ghost picker gives it a
  House chip and no medal.
- `race/tools/check_terrain.py --approach`: profiles every runway's approach glidepath against
  Terrarium.
- Runway JSON gains the optional `aircraftId`, `approach` and `env`. All three are validated, and
  none of them affects `runway_hash()`. `GET /runways` serves them plus `version`, `zone`, `notes`
  and `course_hash`.

### Changed
- The callsign `HOUSE` is reserved on every write path (runs, landings, mode runs, hub `hello`,
  relay `join`/`rename`), and `migrate()` never backfills a pilot for it.
- Provisional `approach` overrides for `vnlk-06`, `vqpr-15`, `lpma-05`, `3u2-17`, `3u2-35`, `s81-04`
  and `s81-22`, from the terrain check (the default straight-in meets terrain). They're marked
  PROVISIONAL in `notes` until the robot's APPROACH mode confirms them. `lflj-22` clears at 3° and
  needed none.
- `docs/REFERENCE.md` regenerated (it was stale on main). gen_docs renders an empty-string env
  default as *(unset)*.

## [Unreleased] — tiles-warm: async tile proxy, one fetch per tile, terrain warm

Server + tools only (`race/server/app.py`, `race/tools/warm_tiles.py`, tests, `docs/`); no race.js
or site change. `SERVER_VERSION` -> 1.6.3. `PROTO` unchanged.

### Changed
- **The `/tiles/*` routes are async** on one pooled `httpx.AsyncClient`, opened and closed in the
  app lifespan. They used to be sync handlers doing a blocking `httpx.get` in FastAPI's
  threadpool, so a cold region's fan-out of upstream fetches starved every other sync route. Cache
  file reads and writes stay off the event loop (`asyncio.to_thread`).
- **Concurrent requests for the same tile share one upstream fetch.** A request that joins a fetch
  already in flight is not charged a rate-limit token.
- **Upstream cap**: at most `RACE_TILE_UPSTREAM_MAX` (default 12) upstream tile fetches in flight
  across all viewers and routes.
- **Upstream timeout 5 s** for the whole fetch (was 8 s per phase), under `globe.js`'s 6 s probe
  abort. A slow upstream now gets a real 502 instead of looking like "blocked".

### Added
- **Terrain warm**: a startup background task (`RACE_TILE_WARM`, default on, starts 10 s after
  boot) and `race/tools/warm_tiles.py` for doing it by hand. It fetches Terrarium tiles over each
  course's gate corridor (about a 3 km buffer) at z8-z12, plus z0-z2 globally. Tiles go through the
  normal cache path, already-cached tiles are skipped, and the rate is throttled to
  `RACE_TILE_WARM_PER_S` (default 4/s). A manifest
  (`<tile cache>/.warm-manifest.json`, never LRU-evicted) is keyed by course hash, so each new or
  changed course is warmed exactly once. A course with a failed tile is retried on the next run.
  The current catalog is about 1,650 tiles, roughly 7 minutes on first boot.
- **Imagery and labels are never bulk-prefetched.** Esri's basemap terms restrict bulk
  download and offline caching, so they stay on-demand only.

## [Unreleased] — tiles-p0: tile cache follows RACE_DB, fails open, gated on deploy

Server + deploy only (`race/server/{app.py,Dockerfile,redeploy.sh,prune.sh}`,
`.github/workflows/test.yml`, `docs/`); no race.js change. `SERVER_VERSION` -> 1.6.2. `PROTO`
unchanged.

### Fixed
- **Every 3D view on race.finsonly.net was falling back to 2D**: `GET /tiles/imagery/*` and
  `/tiles/terrain/*` were 500ing on the live server (verified against SHA `1e96f91`, 2026-09-24).
  Root cause: the Dockerfile hardcoded `RACE_TILE_CACHE_DIR=/data/tiles` and declared `VOLUME
  /data`, but `redeploy.sh`'s layout only ever mounts a host dir at `/app/data`
  (`RACE_DB=/app/data/race.db`) and never touches `/data` at all -- so that path landed on the
  image's anonymous, root-owned volume, unwritable as the container's `99:100` user. The unhandled
  `PermissionError` in `_tile_cache_write`'s `os.makedirs` turned every tile request into a 500,
  which `globe.js`'s `probe()` read as "tile hosts blocked."
- **`_default_tile_cache_dir()` now follows `RACE_DB`'s directory** (a `tiles/` dir next to it)
  instead of assuming a separate `/data` volume exists, so it lands wherever a deploy actually
  bind-mounts its data -- `/app/data` for `redeploy.sh`'s layout, `/data` for
  `compose.snippet.yml`'s. `RACE_TILE_CACHE_DIR` still overrides it outright.
- **Tile cache read/write/evict errors now fail open**: an unwritable/misconfigured cache dir
  serves the upstream bytes uncached instead of 500ing the request, and logs one warning per
  process per error kind (not per tile).
- Dropped the Dockerfile's `VOLUME /data`: nothing in `compose.snippet.yml`, `redeploy.sh`,
  `autodeploy.sh` or the runbook's manual rollback command depends on the declaration itself, and
  it was the actual mechanism creating the root-owned volume above -- and, separately, an orphan
  left behind by every `docker rm -f race` (no deploy script passes `-v`).

### Added
- **Startup self-check**: the tile cache dir is `mkdir`+write-tested at boot. `GET /health` gains
  `tiles: {proxy, cache_writable, imagery}`; `ok` and `courses` are unchanged (`redeploy.sh` still
  greps them the same way).
- **Deploy gate**: `redeploy.sh` step 6 now also requires `tiles.cache_writable` true (only when
  `tiles.proxy` is on) and a live `GET /tiles/terrain/0/0/0.png` (200, `image/*`), with the same
  502/000 boot tolerance as the health poll. A failure takes the existing FAIL path, so
  `autodeploy.sh` rolls back to `race:prev`.
- **`prune.sh`** now counts dangling anonymous Docker volumes and prints the exact review command
  in its `PRUNE` summary line, but never removes one automatically -- a shared Unraid host's
  dangling list can hold other containers' volumes too.
- **CI**: a new `docker-tile-cache` job builds the image and runs it exactly as `redeploy.sh` step
  5 does (`--user 99:100`, `/app/data` mount, no `/data` mount), then asserts
  `tiles.cache_writable`. No dependency on upstream tile hosts.

## [Unreleased] — site-3d-fixes: token-bucket tile limiter, CSP audit, same-origin models

Server-only (`race/server/**` + `race/test/site_smoke.py` + deploy scripts); no race.js change.
`SERVER_VERSION` -> 1.6.1. `PROTO` unchanged.

### Fixed
- **The globe's tile rate limiter was a per-IP MIN INTERVAL shared across every tile route**, so
  the concurrent terrain/imagery/labels probe every globe load ran (and Cesium's own parallel tile
  loading) 429'd the second of any two concurrent requests from the same visitor. `createGlobe()`
  read that 429 as "tile hosts blocked" and silently fell back to the 2D route map -- under
  completely normal load, not an actual outage. Replaced with a per-IP **token bucket**
  (`RACE_TILE_BURST`, default 300; `RACE_TILE_RATE_PER_S` is now the refill rate, default 60/s, up
  from the old min-interval's 20/s). A disk-cache hit never charges the bucket -- only an upstream
  fetch does.
- **`client_ip()`** now falls back to `X-Real-Ip` when there's no `X-Forwarded-For`, so a front door
  that sets that header instead doesn't put every visitor behind Caddy into the same bucket.
- **`globe.js`'s `probe()` now treats a 429 as "reachable, rate-limited," not "blocked"**: it
  retries once after 300 ms, but either way reports the host reachable (a 429 proves the server
  answered). Only a real network failure, the page's own CSP ruling the URL out, or a non-429
  non-ok response still count as blocked.
- **Ghost models (`config.js` `MODEL_BASE`) now come from this server's own `GET /models/*`**
  mount (`race/models/*.glb`, baked into the image and mounted read-only like `courses`/`runways`,
  `RACE_MODELS_DIR`) instead of `raw.githubusercontent.com`, which the site's `connect-src 'self'`
  CSP was silently refusing -- every ghost rendered as a plain point, never its model.
- **CSP additions, each confirmed by `race/test/site_smoke.py` actually loading the course/replay
  pages under the real header** (not guesswork -- see the long comment above `_STATIC_CSP` in
  `app.py`): `worker-src 'self'` (Cesium's module task-processor workers), `script-src
  'wasm-unsafe-eval'` (Cesium calls `WebAssembly.instantiate()` on load regardless of whether a
  course uses Draco/KTX2), `style-src 'unsafe-inline'` (Cesium sets inline styles directly on
  widget DOM it creates), `img-src data:` (Cesium's glTF model rendering path on the replay page),
  and `font-src 'self'` (the site's own self-hosted Saira/Saira Condensed `@font-face` rules in
  `site.css` -- this one was already broken before this pass, unrelated to Cesium, and silently
  dropped every local webfont to a system-font fallback).
- **`?debug=1`** on a course/replay page now appends the fallback reason (e.g. `"imagery probe:
  network"`) to the 2D-fallback note when the globe genuinely can't start.

### Added
- `race/test/site_smoke.py`: Playwright/headless Chromium guardrail. Starts a real local server
  with the tile proxy's upstream fetch faked out (no dependency on S3/Esri/EOX), seeds one ghost
  trace, opens the course and replay pages, and asserts a Cesium canvas exists (not the 2D
  fallback), zero CSP violations (`securitypolicyviolation` listener), zero 429 responses, and a
  ghost model loads from this server's own `/models/` mount. Wired into
  `.github/workflows/test.yml` as its own job so a silent fallback fails CI instead of shipping
  quietly.

## [Unreleased] — site-hq-server: tile proxy, replays, record history, pilots, OG images

Server-only (`race/server/**` + tests + deploy scripts); no race.js change. `PROTO` bumps to 9
(one additive field, `trace`, on `finish`/`dnf` — see PROTOCOL.md "Proto 9: full-race replays").
`SERVER_VERSION` -> 1.6.0.

### Added
- **Tile proxy + disk cache** (`RACE_TILE_PROXY`, default on): `GET /tiles/terrain/{z}/{x}/{y}.png`
  (AWS Terrarium), `GET /tiles/imagery/{z}/{y}/{x}` (Esri World Imagery, or EOX Sentinel-2
  cloudless with `RACE_IMAGERY=eox`), `GET /tiles/labels/{z}/{y}/{x}` (Esri place names/borders)
  and `GET /tiles/attribution`. Disk-cached under `RACE_TILE_CACHE_DIR` (default `/data/tiles`),
  LRU-evicted past `RACE_TILE_CACHE_MB` (default 2048), rate-limited per IP
  (`RACE_TILE_RATE_PER_S`, default 20/s), `Cache-Control: public, max-age=2592000, immutable` on
  every tile. `race/server/static/js/config.js`'s `TILE_SOURCES` now points at these routes
  instead of the third-party hosts directly, so the site's CSP can stay `img-src 'self'`.
  `race/tools/prefetch_tiles.py` warms the cache from every course's bbox.
- **Full-race replays**: `race_traces` table, an optional `trace` field on the `finish`/`dnf` relay
  frames (proto 9), and `GET /races/{race_id}/replay`. Pruned to the newest 200 races by
  `prune.sh`'s new `prune_race_traces` step. race.js does not send a trace yet (out of scope for
  this branch) — see PROTOCOL.md "Proto 9" for the gap this leaves and why.
- **Record history**: `record_events` table, written from `POST /runs` whenever a submission
  strictly beats the current course record (across every pilot, not just a personal best).
  `GET /records/history?course_hash=&limit=`. `race/tools/backfill_records.py --db race.db`
  reconstructs history for runs that predate this feature (idempotent).
- **Pilot profiles**: `GET /pilots` (list) and `GET /pilots/{pilot_id-or-callsign}` (personal
  bests, lobby races, wins, and `?vs=` head-to-head against another pilot). No medal system exists
  yet — the response's `medal_inputs` are the raw counts (wins, cup points, records taken) one
  would be built from; see the report on the PR/commit that introduced this for what's deferred.
- **Dynamic OG images**: `GET /og/{record|course|pilot|replay}/{id}.png` (Pillow, 1200x630,
  sunset gradient, the course's own route traced from its gates), disk-cached, and
  `GET /share/{kind}/{id}` — a small server-rendered HTML shell with correct `og:image`/
  `twitter:image`/`og:title` meta tags that immediately forwards a human on to the SPA's real
  hash route (the SPA routes entirely by `location.hash`, which the server never sees, so this is
  the smallest hook that lets an unfurl bot see real per-page metadata). `pilot`/`record`/`replay`
  have no SPA view yet, so their share pages fall back to the course page or home — a documented,
  plainly-visible gap, not a broken link.
- `httpx` and `Pillow` added to `race/server/requirements.txt` (runtime dependencies, not just
  `test_server.py`'s existing test-only `httpx` install step).

## [Unreleased] — airstart-env: flyTo air starts, course env, bush aircraft

No version bump until the "Air start and course env" rows (AS1–AS6, ENV1–ENV6) and Lab G1/V/E0–E2/A0
in race/ACCEPTANCE.md pass in-sim. No relay protocol change. One additive HTTP route (`GET
/runways`) and a server-side hash change, which arrive with the next deploy. Until then a windy
course loads on the old relay's geometry-only hash.

### Added
- **`GeoPhysics.airStart`** (`AIR_START_FLYTO`, `AIR_START_STABILIZE_MS`, `AIR_START_PAUSE_WAIT_MS`,
  `AIR_START_THROTTLE`): `geofs.flyTo` (verified 2026-09-24) with `place()` as the fallback. It waits
  for flyTo's pause, sets the speed along the heading, steps the throttle with
  `increaseThrottle`/`decreaseThrottle`, and holds on the autopilot before handing back. Solo Fly to
  start, the grid and the formation spawn all use it. Solo now spawns `COUNTDOWN_LEAD_S` behind gate 1
  instead of on it. Per-aircraft speeds are in `AIR_START_PROFILES`, and the grid is sized for each
  pilot's own speed.
- **Practice approach** (`PRACTICE_APPROACH`, `APPROACH_*`): Solo tab, 3 nm final on a 3° path to
  any runway from the new **`GET /runways`**.
- **Course `env`** (`COURSE_ENV`): per-course buildings, time of day and weather. It's applied on load
  (for everyone in a room), restored at race end, Leave, teardown and unload, and shown on the Gate.
  Wind, turbulence and precip are hashed; the rest is cosmetic (README "Course env").
  `add_course.py` validates it, and `test/env_hash_vectors.json` pins race.js, add_course.py and
  app.py to the same hashes.
- **Physics Lab:** an ENV section (E0–E2), and A/B/A frame-rate windows of at least 10 s with
  `geofs.debug.fps` and forced continuous rendering.

### Changed
- Every cupped course has a themed env (CUPS.md "Course env"). Hashes are unchanged except
  **v2 with fresh boards** for the Alaska Cup four and `kai-tak-checkerboard` (wind).
- Bush Cup v2: `aircraftId` `13` (Beaver), and `1` (Cub) on `ruth-gorge-bush`.
- CLAUDE.md's allowed writes gain `geofs.flyTo` and `controls.setters.decreaseThrottle`.

### Fixed
- Physics Lab 4d called `getLinearVelocity` instead of `setLinearVelocity`.
- Physics Lab G1 no longer writes MSAA/HDR/bloom, which caused visible glitches.

## [Unreleased] — ui-unify, the 2026-09-24 content expansion, runway loader, deploy prune

No version bump until the ui-unify rows (UI1–UI4) and the 2026-09-24 rows (Course 1–10, Model 1,
Runway 1–3, Deploy 1–2, Lab G0–A1) in race/ACCEPTANCE.md pass in-sim. `race.js` is unchanged by the
2026-09-24 work, so the client needs no new `CONFIG` flags. The content reaches players through
`COURSE_BASE`/`MODEL_BASE`, and the server changes arrive with the next deploy.

### Added
- **Theme tokens:** `THEME_CSS` (`<style id="fr-theme">`) holds the sunset palette, type scale,
  spacing, radii, z-layers and motion as `--fr-*` vars on `.fr-ui`. Every stylesheet uses them. A
  test fails on a literal z-index, an off-scale font size or a stray color literal.
- **Flags:** `CONFIG.THEME_WEBFONT` (off: Saira Condensed from Google Fonts) and `CONFIG.SEASONS`
  (off: hides the Season tab).
- **tools/ui_gallery.html:** every surface on fixture data at 1366×768 and 1920×1080.
- **Courses: 15 → 69, in 17 cups of four** (2026-09-24). Alpine, Fjord, Canyon, KHABO, Pacific and
  Legends. Then Alaska, Aloha, Japan, China, Wonders, Aviation History, Pylon (unrolled multi-lap
  circuits) and Bush (ground starts, `aircraftId` still `null`). See `race/courses/CUPS.md`.
- **Runways: 3 → 26** (2026-09-24): a 16-runway world landing pack plus 7 bush strips
  (`race/runways/LANDING_CUPS.md`).
- **Joke planes: 6 → 12** (2026-09-24): rubber duck, cheese wedge, beer stein, pizza slice, flying
  couch, shopping cart, plus `models/preview.png`.
- **Server: runway loader** (2026-09-24). `app.py` reads `race/runways/` at startup
  (`RACE_RUNWAYS_DIR`, logs `runways loaded: N`) and falls back to the three embedded runways.
  The Dockerfile, compose snippet and both deploy scripts mount it. Existing runway boards keep
  their keys. `SERVER_VERSION` is not bumped.
- **Deploy: `prune.sh`** (2026-09-23). After a passing deploy (or a healthy autodeploy rollback) it
  runs `docker image prune -f` (dangling only) and keeps the 10 newest `race.db.bak-*`.
  `--no-prune` skips it. CI shellchecks it.
- **Tools** (2026-09-24): `design_course.py` (terrain-fitted courses, laps, ground starts),
  `add_runway.py` (OurAirports), `check_addons.py` + `race/addons.json` + `race/ADDONS.md` (six pinned
  third-party addons), `render_models_preview.py`, `add_course.py --cup/--difficulty`,
  `check_terrain.py --source auto|global` (Terrarium worldwide; `auto` is the new default). Physics
  Lab gains GRAPHICS, RUNWAYS and AIRCRAFT discovery sections.
- **Docs** (2026-09-24): `docs/RUNBOOK.md`, generated `docs/REFERENCE.md` (`race/tools/gen_docs.py`),
  `docs/README.md` index, a player-first root README, and the `race/docs/LAPS.md` and
  `race/docs/BUSH_MODE.md` designs.

### Changed
- **HUD:** every readout sits on one plate in a 4-corner grid with 16 px margins, with numbers in
  the num font. Toasts and the news card share a top-right stack under the feed. The reopen pill
  moves bottom-left and hides mid-run. **Alt+K** collapses/reopens the panel.
- **Rollback UI:** the classic panel and old lobby card live in a `LegacyUI` module that's only
  built when `LOBBY_V2` is off. The shell, results card and toasts fade/slide in and out.
- **Copy:** relay/ramp refusals and other system states read as plain sentences.
- **Seven courses repaired as version 2** (fresh boards): `dells-narrows`, `madison-isthmus`,
  `apostle-caves`, `devils-lake-bluffs`, `three-sisters`, `star-wars-canyon`, `cabo-lands-end`.
  The gates keep their lat/lon, and the altitudes are refitted to clear terrain.
- **Docs restructure:** `race/README.md` is a module guide. `race/server/DEPLOY_CHECKLIST.md` and
  `race/docs/ACCEPTANCE.md` are stubs pointing to the runbook and the merged `race/ACCEPTANCE.md`.
  This changelog uses Keep-a-Changelog headings.

### Removed
- `#fr-shell`'s navy/amber palette and the per-panel var copies.

### Fixed
- The Launch course facts and the rollback lobby card no longer print a stray "null". The
  end-of-race banner no longer covers the results table.

## [1.7.0] — 2026-09-23 — rolling start, rebuilt Boost, GeoPhysics

Rebuilt airstart, teleport and Boost on the GeoFS APIs verified in-sim on 2026-09-23: `place()`,
`rigidBody.v_linearVelocity`/`setLinearVelocity`, `geofs.autopilot.*` and
`controls.setters.increaseThrottle`.

### Added
- **GeoPhysics** (in `race.js`, no new file, per the single-file rule): the one place GeoFS physics
  is touched. It covers `placeAircraft`, `getVelocityENU`/`setVelocityENU`, `addSpeedAlongPath`,
  the autopilot calls and the throttle read/press. SI units in, kt/ft conversion inside, and every
  write is logged.
- **Formation:** pure holding-pattern geometry (the oval, slot targets, along-track error, the
  speed P-controller, start-line crossing, terrain-margin altitude), with no GeoFS dependency.
- **Rolling start (relay proto 8):** a new room phase, `formation`, between `lobby` and `racing`.
  It's offered only on an air-start course with `rules.rolling` on, when every racer's connection
  proves proto 8.
  - Server: `formation`/`formation_drop` frames and ready-order slots. A late `ready` joins at the
    back, and `formation_drop` fires on an unexpected autopilot-off.
  - Client: places each pilot in the oval and engages the autopilot, steers at
    `CONFIG.FORMATION_STEER_HZ`, then disengages and checks the throttle at the synced green. It
    falls straight through to the existing grid against an older relay, a ground start, or
    `rules.rolling` off.
- Tests: GeoPhysics unit conversions and write paths, Formation's pure geometry (numeric-derivative
  heading check, slot spacing, controller convergence, terrain clearance), the server FORMATION
  phase (8 new server tests), and the client wiring against the existing GeoFS mock (6 new tests).
  That's 252 pytest, with the full JS suite green.

### Changed
- **Boost rewritten:** `GeoPhysics.addSpeedAlongPath`, ramped +50 m/s over 1.0 s in 10 steps,
  capped at `CONFIG.BOOST_MAX_KT`. It never stacks. The missile speed penalty (off by default) is
  the same adapter with a negative delta, floored.
- **Fly to start** now uses `GeoPhysics.placeAircraft`: one call, arriving already flying at
  `CONFIG.PACE_KT`.

### Removed
- `resetFlight`, direct `trueAirSpeed`/`groundSpeed` writes and thrust multipliers (confirmed
  broken), along with `CONFIG.VELOCITY_FRAME`/`SAFE_WRITES`/`BOOST_LLA_FALLBACK`.

## [1.6.0] — 2026-09-23 — rename, HUD timer fix, classic-panel migration

### Added
- **Callsign rename (proto 7):** a `rename` frame lets a pilot change their room-visible callsign
  at any time, including mid-race, from the top-bar chip (every screen) or the Settings tab. The
  room re-keys presence, host, votes, live bananas and (mid-race) standings under the new name and
  broadcasts `renamed`. Identity stays `pilot_id`/`pilot_token`. A rename also re-presents the
  hub's `hello` handshake, so ghosts, seasons and leaderboards resolve to the new name for past runs
  too, by `pilot_id`, at read time. An old relay just never receives the frame.

### Changed
- **Classic panel retired from the shipped client:** under the default `CONFIG.LOBBY_V2`, the old
  `#fr-root` settings panel is no longer built at all. It only ever showed on the Solo tab,
  duplicating the new HUD/shell. Its unique controls moved into the shell, reusing the exact same
  elements and handlers:
  - course-scoped, on Solo: leaderboard + callsign, the ghost/rival pickers, the course editor, and
    the manual-sync countdown fallback
  - account-scoped, on a new Settings tab: Your plane, Sound and the Powerups loadout

  `#fr-root` itself is unchanged and still boots as the primary UI under the
  `CONFIG.LOBBY_V2 = false` rollback.

### Fixed
- **HUD/timer legibility:** the race clock (`#fr-hud-timer`, `#fr-timer`) no longer inherits a
  `text-shadow` onto its gradient-clipped fill (the "smeared shadow" bug). Both now sit on a solid
  dark pill in a solid color, with an explicit system-font fallback stack and tabular numerals, so
  they stay legible even if a page font is blocked.

## [1.5.0] — 2026-09-23 — race.finsonly.net redesign

### Added
- **New read-only endpoints:** `GET /stats` (races/pilots/gates/missiles_hit), `GET /rooms/live`
  (live rooms, never a join code or pilot_token), `GET /courses/catalog` (every course, raced or
  not, for the per-cup tabs) and `GET /bookmarklet`. All are cached a few seconds in memory and
  rate-limited per IP (`RACE_GET_MIN_INTERVAL_S`).
- **Course metadata:** `race/courses/index.json` entries carry `cup`/`difficulty`. `GET /courses`
  and `/courses/catalog` add `cup`/`difficulty`/`length_km`/`gate_coords` alongside the existing
  fields.
- **hits_landed_by_item:** the relay now tallies offensive hits by item (missile/goop/banana)
  alongside the existing `hits_landed` total, purely so `/stats` can report real missiles landed.
  Results screens, awards and every other field are unchanged.

### Changed
- **Public site rebuilt** as `race/server/static/{index.html,site.css,site.js}`: plain static
  files (`StaticFiles(html=True)` answers `/`) replacing the old inline-HTML page. It has a hero
  record replay (an animated ghost trace over an SVG route map), a live departures board, per-cup
  course records with mini route maps, recent races and open cups, and a real draggable bookmarklet
  built from `race/bookmarklet.txt` at server start. Google Fonts (Saira/Saira Condensed) is the one
  allowed external request. The CSP is `script-src 'self'` (no inline script at all, tighter than
  before). Every section has a loading skeleton, an empty state and an error state, and times out
  at 8 s.

## Lobby reliability pass — 2026-09-23 (no version bump)

Landed between 1.4.0 and 1.5.0. It was listed as "Unreleased" at the time.

### Added
- **Auto-deploy:** `server/autodeploy.sh` polls `origin/deploy` from the Unraid box (no inbound
  access, no hosted runner), deploys only a commit whose GitHub check-runs already passed, tags
  `race:prev` before every build and rolls back to it on a failed health check. `GET /version`
  (`sha`/`version`/`proto`/`courses`/`started_at`, with `sha` baked in at build time via a
  `GIT_SHA` build-arg) is how to confirm a deploy landed. See the
  [runbook](../docs/RUNBOOK.md#autodeploy) (formerly `DEPLOY_CHECKLIST.md` §8).
- **Debug:** the `CONFIG.DEBUG` / Alt+D overlay, with a Test grid slot button.
- **Tests and docs:** `tools/smoke_lobby.py` (also run by pytest against a local uvicorn), the lobby
  acceptance checklist (now the `LB` rows of `ACCEPTANCE.md`), and PROTOCOL.md's
  no-bump-without-proof rule.

### Changed
- **Courses on the server:** the vote draws from `RACE_COURSES_DIR` (the image snapshot, with the
  checkout mounted read-only over it), not from `runs`. Startup fails on zero courses. `/health`
  reports `courses`. GO is refused with `no course selected`.
- **Deploy:** the image builds from the repo root (`-f race/server/Dockerfile`, root
  `.dockerignore`). `redeploy.sh` mounts `race/courses` read-only, refuses a missing or run-less
  `race.db` unless you pass `--allow-empty-db`, and polls `/health` for a non-empty catalog.
- **One socket per tab:** Relay and Hub detach their handlers before closing. There's no auto-join
  under `LOBBY_V2`. Leave forgets the room. The loader replaces a different version and reuses the
  same one.
- **Old UI gone under the shell:** the floating lobby card and its confirm() force-start are never
  built. Alt+Y goes to the Gate. Manual sync hides in a proto-5 room. A relay below proto 5 gets a
  persistent banner.
- **Send path:** every lobby frame that can't go out, every relay/hub refusal and every thrown
  handler becomes a toast. `fr-hidden` actually hides shell elements. Typed chat renders (`from`).
  `join.client_proto` is sent. A voting room can start (the host picker is always shown, and it
  starts on one vote).
- **Start:** `start.course` (additive). The client loads and hash-checks the course before arming,
  re-arms on the first pong, and logs the teleport method and the state before and after.
- **Away** is reachable: 60 s with no input at the Gate reports `idle`.

### Fixed
- The Launch screen threw on every render (`launchRouteSvg`), and a blocked missile on someone
  else threw in `Items.onResolved`. A catch-all had hidden both.

## [1.4.0] — 2026-09-23

### Added
- **CI:** `.github/workflows/test.yml` runs the JS suite, the server pytest suite and ruff on every
  PR and on pushes to main (#5).
- **Mode registry, proto 6:** `MODES` (race asc, landing desc), the `mode_runs` table,
  `GET /modes`, `POST /modes/{mode}/runs`, `GET /modes/{mode}/leaderboard`, and `join.mode` /
  `joined.mode`. `migrate_modes.py` backfills `runs` additively and idempotently (#1).
- **Touchdown detector:** `race/touchdown.js`, a pure-function liftoff/touchdown/bounce/
  go_around/settled state machine that owns the sample and touchdown-event schema (#2). The
  touchdown event now also carries `lat`, `lon` and `heading_deg`.
- **probe.js "touchdown inputs":** reports the GeoFS reads for AGL, vertical speed, ground contact
  and IAS (#4).
- **Server-side landing scoring:** `POST /landings` scores touchdown.js's raw event against
  `RUNWAYS` (three seed runways) and stores it as a `landing` mode run. Client scores and client
  offsets are ignored. Also `GET /landing-leaderboard` (#3).
- **Touchdown recorder + replay:** the `tools/recorder.js` bookmarklet and the
  `tools/replay_landing.mjs` CLI (which now also works on Windows paths) (#6).
- **redeploy.sh:** a one-command Unraid redeploy (pull, SQLite backup, migrate, build, swap, poll)
  with `--dry-run` (#8).
- **Audit:** `docs/AUDIT.md`, a dead-code and superseded-UI report. Nothing in it was applied (#7).

