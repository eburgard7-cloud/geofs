# Rival generator

Four computed "perfect line" ghosts per course — STEVE, BRAT, MOO, DAWG — fast enough to feel
like a fighter jet, beatable by a human. They are never flown in-sim: a point-mass lap-time model
computes each trace offline against GeoFS's own measured F-16 envelope, then race.js's real gate
logic and real terrain verify it. A rival is a ghost trace (traceEncode v1, 4 Hz), exactly like a
recorded human run, so this needs zero new physics writes.

Why not `race/tools/robot_pilot.js`? It flies on the GeoFS autopilot (`ROBOT.BANK_DEG` 25,
`CONFIG.PACE_KT` 180) because CLAUDE.md forbids control writes beyond throttle. It can never fly
aggressively, so it stays the flyability/terrain validator — its House ghost is a different thing
from a rival.

## Pipeline

```
race/tools/envelope.py            mine race.finsonly.net + optional --lab capture -> envelope-<id>.json
race/tools/rival_gen.py           optimize a line + speed profile per persona -> rivals/.pending/<id>.json
race/tools/rival_verify.js --write   the ONLY judge: replays through race.js's real Race -> rivals/<id>.json
race/tools/terrain_probe.js        in-sim cross-check of a shipped rival file against GeoFS's own terrain
```

```
cd race
python tools/envelope.py                              # mine the server -> rivals/envelope-7.json
python tools/rival_gen.py --all --calibrate            # every eligible course -> rivals/.pending/
node tools/rival_verify.js --write                     # judges .pending/*.json -> rivals/<id>.json
```

`FINS_NODE` must point at the portable Node build named in CLAUDE.md (Node is not on PATH here);
`rival_common.node_exe()` falls back to it automatically.

## Envelope capture (race/tools/envelope_capture.js)

A read-only bookmarklet, same rules as `race/tools/probe.js`: reads only through
`window.__finsRace.dev.G`, never writes. Load FINSONLY Racing (`CONFIG.DEV_API` on), sit in the
F-16, click the ENVELOPE CAPTURE bookmark. A 6-minute flight card walks through full-throttle
level accel (500 ft, 10,000 ft), sustained turns at 250/350/450/550 kt, full-deflection rolls, a
zoom climb, and idle deceleration. DONE copies a JSON report; feed it back with:

```
python tools/envelope.py --lab capture.json
```

Lab data fills whatever the mined race traces leave thin; mined data still wins where it isn't.

## Terrain cross-check (race/tools/terrain_probe.js)

Terrarium (the generator's terrain source) is not GeoFS's rendered terrain everywhere. In the
same bookmarklet used for course terrain checks, answer the prompt with `rival:<course_id>`, a
rival file URL, or the pasted file itself, to sample every rival's trace against
`Cesium.sampleTerrainMostDetailed` and get a PASS/FAIL/UNVERIFIED per rival against the 60 m floor.

## Personas (`personas.json`)

Global knobs only — never tuned per course:

| Persona | Model | envelopeFrac | Line | gateWindow |
|---|---|---|---|---|
| STEVE | goldfish | 0.80 | gate centres | 0.9 |
| BRAT | bratwurst | 0.88 | half of DAWG's line, wide on 2 seeded gates/lap | 0.9 |
| MOO | cow | 0.94 | fully optimized | 0.6 |
| DAWG | hot-dawg | 0.98 | fully optimized | 0.7 (never the outer 30%) |

`--calibrate` fits one `envelopeFrac` per persona so the median of rival-time/human-record hits
`personas.json`'s `calibration.targets`, using courses with a jet-speed record trace on the
course's *current* hash. Fewer than `calibration.min_records` (5) such courses: defaults are kept.

## Files

- `envelope-<aircraftId>.json` — per-speed-bin tables (`n_inst`, `n_sus`, `accel_ms2`,
  `decel_ms2`, `ps_ms`, `vmax_ms` by altitude band, `roll_rate_dps`, `roll_sign`), each value
  tagged `sources` (mined/lab/seed/held) and `counts`, plus a `thin` list.
- `<course_id>.json` — `{course_id, course_hash, aircraftId, generator_version,
  envelope_version, rivals: [{rival_id, name, model, time_ms, splits_ms, trace}]}`. Only rivals
  that pass `rival_verify.js` are ever written here.
- `.pending/` and `cache/` are gitignored: pending files carry a `terrain_m` sidecar and full
  convergence/window diagnostics the verifier needs and the shipped file doesn't.

## Unverified in-sim

- `roll_sign` and `roll_rate_dps`: race.js's own recorded traces store the roll column as a
  control-deflection-like value (`|roll| <= ~1`), not a bank angle, so they cannot be mined; both
  fall back to the seed table until a capture card is flown.
- The seed envelope itself (Vmax, n, accel/decel) below what real traces cover.
- Terrarium vs GeoFS's rendered terrain, wherever `terrain_probe.js` hasn't been run yet.
