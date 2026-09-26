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
race/tools/rival_gen.py           route + line + ladder pace per persona -> rivals/.pending/<id>.json
race/tools/rival_verify.js --write   the ONLY judge: replays through race.js's real Race -> rivals/<id>.json
race/tools/rival_ladder.py index  rivals/index.json (medal times) + rivals/ladder.json (solved pace)
race/tools/rival_ladder.py report where each human record lands on the ladder, solved paces, cups
race/tools/terrain_probe.js        in-sim cross-check of a shipped rival file against GeoFS's own terrain
```

```
cd race
python tools/envelope.py                              # mine the server -> rivals/envelope-7.json
python tools/rival_gen.py --all --jobs 4              # every eligible course -> rivals/.pending/
node tools/rival_verify.js --write                    # judges .pending/*.json -> rivals/<id>.json
python tools/rival_ladder.py index                    # rivals/index.json + rivals/ladder.json
python tools/rival_ladder.py report                   # the sanity table (records: --online, else the snapshot)
```

`FINS_NODE` must point at the portable Node build named in CLAUDE.md (Node is not on PATH there);
`rival_common.node_exe()` falls back to it automatically.

## Route (rival-gen-2)

- **Terrain floor**: 60 m AGL (`personas.json` `minAglM`) everywhere, except near a gate the course
  itself puts lower: there the floor is that gate centre's own AGL less 5 m (never below 0), ramping
  back to 60 m between the gate's radius and radius + 1 km (horizontal). Flying through a gate at its
  centre is never illegal. `rival_verify.js` applies the same rule from the pending file's
  `gate_terrain_m` sidecar (without it: 60 m everywhere).
- **Feasible turns**: the load factor a line needs is checked against the full envelope's `n_inst(v)`
  at every sample. A turn too tight for any speed (a hairpin at a small gate) is a penalty the route
  must remove, not a 50 m/s crawl at 30-50 g.
- **Vias**: free control points between gates, added where the line hits the floor or needs an
  impossible turn: searched laterally and vertically across the leg, several per leg, and past a
  hairpin gate (an overshoot: a teardrop turn). The shared route is planned on the gate-centre line;
  a persona that needs more (BRAT's wide gates) adds its own on its own copy of the geometry.
- **Ground start**: a standing start at gate 0's centre, full-throttle roll straight at gate 1; the
  clock still starts leaving gate 0's sphere.

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

## Personas and the ladder (`personas.json`)

Global knobs only — never tuned per course:

| Persona | Model | Line | gateWindow | Pace |
|---|---|---|---|---|
| DAWG | hot-dawg | fully optimized | 0.7 (never the outer 30%) | fixed: envelopeFrac 0.98 |
| MOO | cow | fully optimized | 0.6 | DAWG time x `ladder.ratios.moo` |
| BRAT | bratwurst | half of DAWG's line, wide on 2 seeded gates/lap | 0.9 | DAWG time x `ladder.ratios.brat` |
| STEVE | goldfish | gate centres | 0.9 | DAWG time x `ladder.ratios.steve` |

DAWG is the optimizer's best line. Every other rung is anchored to DAWG's time on the same course
through ONE global ratio table (`ladder.ratios`). Per course, with the persona's line fixed,
`rival_personas.solve_pace()` derives its pace: speedCap first (top speed only), then envelopeFrac
up to DAWG's if it must be faster, or down (at the speedCap floor) on a turn-bound course where top
speed alone can't slow it enough. A rung is always at least 2% slower than the one above it (a rung
that can't get fast enough pushes the ones below it down: `shifted` in `ladder.json`). The derived
envelopeFrac/speedCap per course are in `ladder.json`, never hand-edited.

## Files

- `envelope-<aircraftId>.json` — per-speed-bin tables (`n_inst`, `n_sus`, `accel_ms2`,
  `decel_ms2`, `ps_ms`, `vmax_ms` by altitude band, `roll_rate_dps`, `roll_sign`), each value
  tagged `sources` (mined/lab/seed/held) and `counts`, plus a `thin` list.
- `<course_id>.json` — `{course_id, course_hash, aircraftId, generator_version,
  envelope_version, rivals: [{rival_id, name, model, time_ms, splits_ms, trace}]}`. Only rivals
  that pass `rival_verify.js` are ever written here. race.js (`CONFIG.RIVALS`) fetches the loaded
  course's file from `RIVAL_BASE` (default: this folder on the branch `COURSE_BASE` names), uses it
  only when `course_hash` matches the loaded course, and offers each rival as a `rival:<rival_id>`
  ghost pick. Client-side only: a rival is never sent to the server or the relay.
- `index.json` — the medal times without the traces: `[{course_id, course_hash, generator_version,
  rivals: [{rival_id, name, model, time_ms, splits_ms}]}]`, sorted by course_id, one entry per
  shipped `<course_id>.json`. The Career server, the site and the solo picker read this.
- `ladder.json` — per course, each shipped rival's solved envelopeFrac/speedCap, solver stage and
  whether it was clamped or shifted.
- `records-snapshot.json` — the human records `rival_ladder.py report` falls back to when
  race.finsonly.net isn't reachable.
- `.pending/` and `cache/` are gitignored: pending files carry a `terrain_m` sidecar and full
  convergence/window diagnostics the verifier needs and the shipped file doesn't.

## Unverified in-sim

- `roll_sign` and `roll_rate_dps`: race.js's own recorded traces store the roll column as a
  control-deflection-like value (`|roll| <= ~1`), not a bank angle, so they cannot be mined; both
  fall back to the seed table until a capture card is flown.
- The seed envelope itself (Vmax, n, accel/decel) below what real traces cover.
- Terrarium vs GeoFS's rendered terrain, wherever `terrain_probe.js` hasn't been run yet.
