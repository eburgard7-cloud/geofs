# Overnight report — 2026-09-23/24

| WS | Title | Status |
|----|-------|--------|
| WS1 | Physics Lab: GRAPHICS + RUNWAYS | DONE |
| WS2 | Addon manifest | DONE |
| WS3 | Joke plane pack v2 | DONE |
| WS4 | Worldwide terrain check | DONE |
| WS5 | Runway loader + world landing pack | DONE |
| WS6 | Europe cups | DONE |
| WS7 | Americas cups | TODO |
| WS8 | Pacific + Legends cups | TODO |
| WS9 | Repair + final reconcile | TODO |
| WS10 | Physics Lab: AIRCRAFT list | TODO |
| WS11 | Alaska Cup + Aloha Cup | TODO |
| WS12 | Japan Cup + China Cup | TODO |
| WS13 | Wonders Cup + Aviation History Cup | TODO |
| WS14 | Pylon Cup (circuits) | TODO |
| WS15 | Bush Cup + bush strips | TODO |
| WS16 | Design docs LAPS.md + BUSH_MODE.md | TODO |
| WS17 | Reconcile expansion | TODO |

## Log

### WS1 — Physics Lab GRAPHICS + RUNWAYS — DONE
- Files: `race/tools/physics_lab.js`, `race/README.md` (Physics Lab section: new GRAPHICS / RUNWAYS subsections).
- GRAPHICS: G0 read-only discover (13 Cesium settings, canvas/DPR, `geofs.preferences` graphics leaves, `data-*pref*` inputs, graphics-named functions); G1 opt-in per-setting write (FPS 5 s → write → 2 s → re-read STICKS/REVERTED/CHANGED → FPS 5 s → restore) plus "write ALL"; G2 toggles one GeoFS graphics pref via its own options-panel input + `change` event, diffs Cesium settings, restores.
- RUNWAYS: R0 read-only discover (runway/airport/nav containers, first-entry shape, nearest 5 records with raw + guess, approach/takeoff/flyTo functions with signature + source head, DOM takeoff/approach buttons incl. jQuery handler source); R1 export nearest runway in `race/runways/*.json` shape (zone rule 10–30 % clamp 60–450, ≥60 m deep — same as add_runway.py); R2 opt-in "try approach start here" (confirm() first).
- "Copy report (JSON)" button (renamed from Copy JSON).
- New pure exports: `GRAPHICS_PATHS, getPath, setPath, testValueFor, classifyStick, fpsFromTimestamps, haversineM, defaultZone, slugId, runwayExportShape, guessRunway, nearestN`. **No JS unit tests added** — race/test/*.js is off-limits this run; the owning session should add run.js cases. Smoke-tested with a jsdom fake geofs (scratch, not committed).
- Tests: node run.js all passed; pytest 363 passed.
- In-sim fly-check needed: everything (never run on geo-fs.com). Especially: which graphics settings STICK, what the takeoff/approach buttons really call, and the units of GeoFS runway records.

### WS2 — Addon manifest — DONE
- Files: `race/addons.json`, `race/tools/check_addons.py`, `race/test/test_check_addons.py` (11 tests), `race/ADDONS.md`.
- Pinned (upstream HEAD, verified by `git ls-remote` + fetch-by-SHA; GitHub API and jsDelivr are 403 from this sandbox): flight-path-vector `tylerbmusic/GeoFS-Flight-Path-Vector@d4b0b89`, sky-dolly `tylerbmusic/GeoFS-Sky-Dolly@39b228c`, camera-cycling `geofs-pilot/GeoFS-Camera-cycling@6d8df30`, information-display `geofs-pilot/GeoFS-Information-Display@c8a8363`, cockpit-volume `geofs-pilot/geofs-cockpit-volume@df302eb`, gpws-callouts `tylerbmusic/GeoFS-GPWS-Callouts@8c02d4d`.
- physics:false for all six (none writes aircraft state/controls). Keys: FPV `L` (loose collision with race.js Alt+L — harmless because race.js swallows the event in capture phase), camera-cycling `W` (strict), info-display `I`; others none.
- Licenses: 5 × no license found; information-display has conflicting CC BY-NC-SA 4.0 (LICENSE) vs GPL-3.0 (header).
- `check_addons.py` run: schema OK, 6/6 SHA OK, 1 loose collision.
- Not wired into race.js (by design). jsDelivr URLs not fetched (blocked) — check one in a browser.

### WS3 — Joke plane pack v2 — DONE
- Convention found: nose +X, up +Y (glTF), +X extent scaled to 15 m, flat vertex colours, one mesh/one material, `offset` all zeros in index.json. Originals are NOT centred on CG (e.g. goldfish centroid x≈+1.3 m); new six are centred on area-weighted centroid (|c| < 0.05 m) — originals left byte-identical (cow.glb regenerated with float drift, restored from git).
- Added: rubber-duck (640 tris, 84 KB), cheese-wedge (308, 41 KB), beer-stein (330, 44 KB; lies on its side, mouth forward, handle on top), pizza-slice (246, 33 KB; tip forward), flying-couch (180, 25 KB; flies armrest-first), shopping-cart (512, 67 KB; handle aft). All <5k tris, <120 KB.
- Files: `race/tools/build_models.py`, new `race/tools/render_models_preview.py`, `race/models/*.glb` (6 new), `race/models/index.json` (6 appended), `race/models/preview.png`, `race/README.md` (Generating the models), `race/test/test_models.py` (EXPECTED_IDS → 12), new `race/test/test_models_pack.py` (committed-file checks: glTF 2.0 header/version/length, no textures, <5k tris, <120 KB, +X extent = goldfish, max extent within 0.5–2× goldfish, centroid, index resolves, no stray .glb, assignments valid, preview.png).
- assignments.json untouched.
- In-sim check: swap each into GeoFS and confirm nose-forward / upright (fix via `offset`, not mesh).

### WS4 — Worldwide terrain check — DONE
- `race/tools/check_terrain.py`: new `--source global` (Terrarium PNG z12 via s3, stdlib PNG decoder incl. all 5 filter types, bilinear across tile edges, tiles cached at `<cache>.tiles/z/x/y.png`), new `--source auto` (now the DEFAULT: usgs inside CONUS bbox 24.4–49.5N / 125–66.9W, global elsewhere; if USGS is unreachable, CONUS falls back to global and the source label says so), `--zoom`.
- **Network from this sandbox:** s3 Terrarium reachable ✔; USGS epqs 403 ✘ → every CONUS number below is from Terrarium (fallback), not 3DEP. The four previously-verified Oregon courses (crater-rim, gorge-run, hood-circuit, st-helens-crater) still PASS on Terrarium, which is a decent sanity check of the decoder against the earlier USGS run.
- Tests: new `race/test/test_check_terrain_global.py` (15, fixture PNGs built with zlib, no network); existing 37 terrain tests unchanged and green. README terrain-sources list updated.
- `check_terrain.py --all --source auto` (step 250 m, margin 150 m), 2026-09-24:

| Course | Status | Min clearance (m) | Where | BURIED | CLIPPING | LOW |
|---|---|---|---|---|---|---|
| `apostle-caves` | FAIL | 80 | gate 5 | 0 | 0 | 174 |
| `cabo-lands-end` | FAIL | -6 | leg 5->6 @5.0 km | 2 | 1 | 148 |
| `crater-rim` | PASS | 153 | gate 1 | 0 | 0 | 0 |
| `dells-narrows` | FAIL | 26 | leg 2->3 @1.8 km | 0 | 0 | 50 |
| `devils-lake-bluffs` | FAIL | -68 | leg 7->8 @0.8 km | 10 | 0 | 32 |
| `ecola-headland-run` | FAIL | 34 | gate 5 | 0 | 0 | 43 |
| `gorge-run` | PASS | 155 | leg 5->6 @0.8 km | 0 | 0 | 0 |
| `hood-circuit` | PASS | 1332 | leg 2->3 @2.0 km | 0 | 0 | 0 |
| `madison-isthmus` | FAIL | 101 | leg 5->6 @1.5 km | 0 | 1 | 42 |
| `st-helens-crater` | PASS | 170 | leg 2->3 @0.2 km | 0 | 0 | 0 |
| `star-wars-canyon` | FAIL | -103 | leg 2->3 @1.0 km | 4 | 0 | 25 |
| `starter-sprint-seatac` | FAIL | -1 | leg 3->4 @0.2 km | 1 | 6 | 37 |
| `three-sisters` | FAIL | -365 | leg 3->4 @3.0 km | 9 | 0 | 11 |
| `umpqua-dunes-run` | FAIL | -52 | leg 6->7 @0.5 km | 23 | 0 | 135 |
| `willamette-gauntlet` | FAIL | 16 | leg 6->7 @0.5 km | 0 | 0 | 71 |
- The three "tight" Oregon courses (ecola, umpqua, willamette) are deliberately low-level; they fail the 150 m default margin by design. starter-sprint-seatac is the test course.

### WS5 — Runway loader + world landing pack — DONE
- (a) `race/server/app.py`: `RUNWAYS = load_runways(RUNWAYS_DIR)` — reads `race/runways/index.json` + files (validated by new `validate_runway()`; broken entries skipped with a warning; id must match index). `RUNWAYS_DIR` = `RACE_RUNWAYS_DIR` → `/app/runways` → checkout. The old dict is now `EMBEDDED_RUNWAYS`, used only when the dir is missing/empty/unreadable. `runway_hash()` unchanged (id+version) → the three launch boards keep their keys (pinned in tests). Startup logs `runways loaded: N from DIR`. `/health` unchanged.
  - Deploy plumbing: `Dockerfile` (COPY race/runways/ → /app/runways, ENV RACE_RUNWAYS_DIR), root `.dockerignore` (`!race/runways/*.json`), `compose.snippet.yml` (env + ro mount), `redeploy.sh` + `autodeploy.sh` (ro mount + env on the container run), `DEPLOY_CHECKLIST.md` (copy step, compose, no-compose fallback, expected log line). Live stack NOT touched.
  - Tests: drift test rewritten (files == loaded; embedded three byte-identical to their files), + loader/validator/env/fallback/endpoint tests (7 new in test_server.py), Docker/ignore test updated.
- (b) `race/tools/add_runway.py ICAO END`: downloads OurAirports runways.csv/airports.csv (cached, `--csv-dir`, `--refresh`), applies displaced threshold (moves threshold, shortens length_m), elevation ft→m with airport-elevation fallback (noted), heading from coordinates if blank (noted), zone rule = physics_lab defaultZone, `--notes/--name/--id/--version/--force/--dry-run`, `--derive-missing-end` (opt-in, noted). Refuses closed runways / unknown ends / geometry changes without --force. Index kept sorted by id. Tests: `race/test/test_add_runway.py` (11, fixture CSVs, + pinned runway_hash table for all 19 + LANDING_CUPS coverage).
- (c) 16 runways added (OurAirports reachable ✔): vnlk-06, vqpr-15, lflj-22, tncs-12 | tffj-10, tncm-10, lpma-05, lxgb-09 | nzqn-05, lowi-26, kase-15, ktex-09 | keug-16r, kpdx-10r, kmsn-36, mmsd-34. `race/runways/LANDING_CUPS.md` groups them.
  - **Courchevel:** spec implied the famous uphill landing; OurAirports elevations make 22 the uphill direction (04 end has no coordinates in OurAirports anyway) → shipped `lflj-22`, flagged for in-sim check.
  - **Saba:** no end elevations/heading in OurAirports → airport elevation + computed heading (noted in file).
- In-sim: fly every new runway once; check GeoFS's runway sits where OurAirports says (along_m/cross_m of a centreline landing ≈ 0).
- Tests: pytest 453 passed; node run.js all passed.

### WS6–WS8 — progress note (IN PROGRESS)
- Committed tooling: `race/tools/design_course.py` (waypoints → terrain-fitted gate altitudes that pass check_terrain at the default margin; valley snapping; item boxes; hillshade preview PNG) + `race/test/test_design_course.py` (5); `race/tools/add_course.py` now keeps/accepts `--cup/--difficulty` in index entries and sorts the index by id (+1 test).
- Course design for WS6/WS7/WS8 running in parallel (scratch), registration + commits follow sequentially per workstream.

### WS6 — Europe — DONE
- Alpine Cup: `lauterbrunnen-falls` (easy, 10 gates, 22.3 km), `zermatt-matterhorn` (medium, 10, 32.4 km, 2 boxes), `chamonix-midi` (medium, 14, 28.5 km, 2 boxes), `tre-cime-loop` (hard, 14, 20.1 km, 2 boxes).
- Fjord Cup: `geiranger-sisters` (easy, 12, 19.8 km), `lysefjord-kjerag` (medium, 14, 36.6 km, 2 boxes), `eidfjord-voringsfossen` (medium, 14, 24.6 km, 2 boxes), `reine-lofoten` (hard, 14, 20.1 km, 2 boxes).
- All 8: `check_terrain.py --source auto` PASS, min clearance 165.0 m (Terrarium; outside CONUS so no fallback involved). Designed with design_course.py (routes checked on hillshade previews), registered via add_course.py with --cup/--difficulty; `race/test/course_hashes.json` regenerated; CUPS.md rows added.
- Caveats: Terrarium (~30 m) smooths the narrow gorges (Lütschine, Mer de Glace, Måbødalen, Kjerkfjorden); lysefjord-kjerag plays mild for a medium; three courses are near the 120 s floor.
- Tests: pytest 459 passed; node run.js all passed.
