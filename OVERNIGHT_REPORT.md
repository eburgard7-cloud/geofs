# Overnight report — 2026-09-23/24

| WS | Title | Status |
|----|-------|--------|
| WS1 | Physics Lab: GRAPHICS + RUNWAYS | DONE |
| WS2 | Addon manifest | IN PROGRESS |
| WS3 | Joke plane pack v2 | TODO |
| WS4 | Worldwide terrain check | TODO |
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
