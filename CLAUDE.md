# geofs repo

Repo root holds FINSONLY liveries (textures + airline.json for LiverySelector). Do not modify those unless asked.

## race/ — FINSONLY Racing
Checkpoint racing layer for GeoFS, loaded by bookmarklet (Tampermonkey is admin-blocked on the target machine; no extensions).
Read race/README.md first.

Rules:
- race/race.js must stay a single self-contained file, no build step, no external deps.
- All GeoFS/Cesium internals are touched ONLY in the `G` adapter and makeGateLayer. Keep it that way.
- Run both test suites before every commit; never commit with failures:
  - cd race/test && npm install && node run.js
  - cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q
- Add a test for every bug fix.
- The GeoFS-internal names in `G` are unverified against the live site; the user checks them manually on geo-fs.com and reports back.
- Leaderboard server deploys to an Unraid Docker Compose stack behind Caddy on the external `proxy` network. Never add Authelia to race.finsonly.net. Never edit the live Caddyfile or restart containers without explicit approval.
- Commit messages: short, imperative. Bump CONFIG.VERSION in race.js on user-visible changes.

## Feature series 0.7–1.0

These rules bind every later session working on race/ during the 0.7–1.0 feature series:

- Node is not on PATH. Use the portable Node at `C:\Users\Eric.Burgard\AppData\Local\nodejs\node-v22.14.0-win-x64` for `race/test/run.js`.
- `api.cesium.com` and `opentopodata.org` are unreachable from this network. Never add a runtime or test dependency on them.
- `race/race.js` stays one self-contained file: no build step, no external deps, no asset downloads beyond the existing `COURSE_BASE`/`MODEL_BASE`/`API_BASE`. Audio is WebAudio-synthesized, never sample files.
- Every GeoFS/Cesium internal is touched only inside the `G` adapter or a `make*Layer` factory next to `makeGateLayer`. New world-space rendering gets its own factory with the same contract: try/catch, `layer.ok` flag, `clear()`, fails closed with a `console.warn`, never throws into the race loop.
- Pure logic (state machines, interpolation, scoring, clock offset) is written as pure functions exported to the test harness the same way `powerups*` functions are, and gets tests. Anything untestable without the sim gets a line in `race/ACCEPTANCE.md` instead.
- No writes to aircraft controls. `POWERUP_CONTROL_EFFECTS` stays `false`. Allowed physics writes are exactly those already shipped in 0.6.0 (`trueAirSpeed`/`groundSpeed` scalars, `llaLocation`/`htr` for fly-to-start) behind their existing flags and clamps.
- Relay changes are additive and versioned: see `race/PROTOCOL.md`. The server never trusts a client for another player's state. In-memory room state stays in-memory; only finished-race results and traces go to SQLite.
- Every new feature has a CONFIG flag, defaults ON unless this file says otherwise, and the client must run correctly against an OLD server (feature off, one status-line note, no error spam).
- One commit per task, short imperative message, all test suites green before each commit. Pushing feature branches and opening PRs is allowed; never push to main or deploy. Never touch the live Caddyfile or containers.
- End every session with a report: commits (hash + one line), CONFIG flags added, protocol frames added, tests added (count), in-sim checks appended to `race/ACCEPTANCE.md`, anything skipped and why.
