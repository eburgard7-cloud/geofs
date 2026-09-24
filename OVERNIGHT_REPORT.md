# Overnight report — 2026-09-23/24

| WS | Title | Status |
|----|-------|--------|
| WS1 | Physics Lab: GRAPHICS + RUNWAYS | DONE |
| WS2 | Addon manifest | DONE |
| WS3 | Joke plane pack v2 | DONE |
| WS4 | Worldwide terrain check | IN PROGRESS |
| WS5 | Runway loader + world landing pack | TODO |
| WS6 | Europe cups | TODO |
| WS7 | Americas cups | TODO |
| WS8 | Pacific + Legends cups | TODO |
| WS9 | Repair + final reconcile | TODO |

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
