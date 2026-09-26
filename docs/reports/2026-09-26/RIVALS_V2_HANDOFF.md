# Rival ladder v2: handoff (in progress)

Handed off mid-task from a cloud session to a local machine. Branch:
`claude/rival-ladder-v2-hmej9s`. The cloud harness only allowed pushing that name, not
`rival-ladder-v2`. No PR yet, no version bump, and origin/main is not merged yet.

## Commits so far

| Commit | What |
|---|---|
| `176a5ab` | Rebuild rival routes and anchor the ladder to DAWG (tasks 1 + 3 code; they share `plan_lines`/`generate_course`) |
| `dcda2f0` | Add the rival medal-time index and its validator (task 4) |
| `0a66c25` | Set BRAT's ladder ratio from the human records (task 2) |
| `b0bc5a4` | Keep rival lines inside the envelope at every solved pace (fixes found while running the full batch) |
| `1507ada` | Regenerate rivals with rival-gen-2, **interim run** (see "Still to do") |

The suites were green before every commit: `node run.js`, `node rivals.test.js`, `pytest test_server.py`
and `pytest test_rivals.py` (64 tests).

## What changed

- **Ladder by ratio.** DAWG keeps its persona (0.98 envelopeFrac, 0.7 gate window). MOO, BRAT and
  STEVE each target DAWG time × one global ratio (`personas.json` → `ladder.ratios`). Per course,
  `rival_personas.solve_pace()` derives speedCap first, then envelopeFrac: up toward DAWG's, or down
  at the speedCap floor on turn-bound courses. When one knob hits a time jump, it switches to the
  other knob, then scans frac rows. The solved pace goes in `race/rivals/ladder.json`, so the
  course files keep their exact v1 keys.
- **Global table changed once:** BRAT 1.20 → **1.12**. Record/DAWG over the 6 current-hash records
  is 1.102, 1.157, 1.162, 1.202, 1.518, 1.659 (median 1.182). At 1.20 the median casual record beat
  BRAT. 1.12 is the geometric midpoint of MOO (1.07) and that median. MOO stays 1.07 (the fastest
  record is 1.10, so nobody's casual flight beats MOO). STEVE stays 1.40, which leaves about 19%
  of room below the median casual flight for a tablet pilot.
- **Failure causes fixed in the generator** (the verifier was never loosened):
  - A g-feasibility penalty against the full envelope, steep enough that no residual excess buys
    lap time. The old model silently flew impossible hairpins at 50 m/s and 30–50 g.
  - Vias placed laterally and vertically, several per leg, with overshoot vias for teardrop turns
    at hairpin gates.
  - A downward-closed `v_limit` (n_inst jumps from 3.9 g to 7.8 g between 130 and 150 m/s).
  - DAWG adopts MOO's line when that line is faster.
  - A terrain re-check of every line at the shipped 5 m resolution.
  - No two trace samples closer than 50 ms.
  - Penalties stop at the finish, so the model's unraced run-out no longer counts.
- **Gate-altitude floor:** near a gate the course itself puts under 60 m AGL, the floor is that gate
  centre's AGL − 5 m (never below 0). It ramps back to 60 m over 1 km beyond the gate radius.
  `rival_verify.js` applies the identical rule from a `gate_terrain_m` sidecar; without the sidecar
  it keeps the flat 60 m floor.
- **Ground start:** a standing start at gate 0's centre, rolling at full throttle toward gate 1.
  starter-sprint-seatac now has all 4 rivals.
- **No envelope changes.** No new evidence (mined traces or a lab capture) exists, so the seed
  low-speed n (2.0 g below 90 m/s) stands.
- **Bug fixed in `rival_node.js`** (outside the brief's file list, but needed to run at all): it
  exited before stdout drained, which cut Linux pipe replies at 64 KiB. It has a regression test.
- **Index:** `race/rivals/index.json` (sorted, no traces). Its validator is in `test_rivals.py`:
  every entry must match its file, and every hash must match `course_hashes.json`.

## Interim data (commit `1507ada`)

- 65 course files, **253 rivals, all passing `rival_verify.js --write`**.
- 2 more were rejected by the verifier. The generator bugs behind both are fixed in `b0bc5a4`, but
  those fixes haven't been regenerated yet:
  - angkor-tonle-sap BRAT: 59 m against a 60 m floor at one narrow terrain spike.
  - kenai-fjords-exit-glacier BRAT: a 10 ms trace sliver read as a 200°/s roll.
  A 4-course test run with the new code gave angkor and kenai all 4 rivals.
- The generator declined these (terrain floor after re-routing; they sit right on the edge, and
  runs vary):
  - umpqua-dunes-run: BRAT and DAWG.
  - willamette-gauntlet: BRAT, MOO and DAWG.
  The rungs that did ship are anchored to DAWG's unshipped model time.
- Clamped rungs, which are named exceptions to the ±1% rule:
  - BRAT *high* (its wide gates can't get that fast): cabo, eidfjord, li-river, machu-picchu, madison.
  - MOO *high*: devils-lake.
  - MOO *gap* (1.038 vs 1.07): li-river.
  - STEVE *shifted* (pushed down by a clamped BRAT above it): eidfjord, willamette.
- Every other rung is within ±1% of its target, and every file keeps STEVE > BRAT > MOO > DAWG.
- Record landings: crater-rim falls MOO–BRAT; hood and diamond-head fall BRAT–STEVE; angkor falls
  MOO–STEVE because it has no BRAT; gorge-run and great-wall fall below STEVE.
- Career cups with a full 4×4 set: 13 of 16 F-16 cups. The missing ones are Alaska (kenai),
  Wonders (angkor) and Oregon (umpqua, willamette). The Bush Cup stays skipped because there is no
  envelope for aircraft 13 or 1.

## Still to do (local machine)

```
cd race
python tools/rival_gen.py --all --jobs 4 --cap-s 30     # ~60 min; the final run with every fix
node tools/rival_verify.js --write                      # the only judge
python tools/rival_ladder.py index
python tools/rival_ladder.py report > ../docs/reports/2026-09-26/ladder_report.md
cd test && node run.js && node rivals.test.js && cd .. && python -m pytest test/test_rivals.py -q
cd server && python -m pytest ../test/test_server.py -q
```

On Windows, run `rival_gen.py` with `FINS_NODE` set to the portable node. Terrarium tiles download
into `race/rivals/cache/`, which is gitignored.

1. Commit the regenerated rivals, `index.json` and `ladder.json`.
2. Merge origin/main. It changed `race/rivals/README.md` by 5 lines (keep both sides), and its
   `race/test/run.js` pins shipped rival data. Update only these fixture values:
   - `files.length === 55` becomes the new file count (65 in the interim data).
   - "zion-canyon has 3 rivals": zion now ships 4, so point it at a file that ships 3.
   - "copper-canyon-urique has 2": copper now ships 4, so point it at a file that ships 2, or
     say so if none does.
3. If umpqua or willamette are still short, list them in the report with their deficit.
4. Write the final report (headline table, solved-pace summary, failures, cups), then push and
   open the PR.
