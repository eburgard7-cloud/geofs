# Rival ladder v2: final report

Branch `claude/rival-ladder-v2-hmej9s`. It follows on from `RIVALS_V2_HANDOFF.md`, which covers
the design and the interim run. The full per-course table is in `ladder_report.md`.

## Headline

| | Interim (`1507ada`) | Final (`936c87d`) |
|---|---|---|
| Course files | 65 | 65 |
| Rivals shipped (all pass `rival_verify.js --write`) | 253 | **257** |
| Rejected by the verifier | 2 | **0** |
| Courses with all 4 rivals | 61 | **63** |
| Declined by the generator | umpqua (BRAT, DAWG), willamette (BRAT, MOO, DAWG) | umpqua (STEVE, MOO), willamette (MOO) |
| F-16 cups with a full 4×4 set | 13 of 16 | **15 of 16** |

Final run: `rival_gen.py --all --jobs 4 --cap-s 30` on Windows with the portable Node. It
generated 65 courses and skipped 4 Bush courses (there is no envelope for aircraft 13 or 1). Only
the verifier decides what ships, and it was not changed.

Per persona: STEVE 64, BRAT 65, MOO 63, DAWG 65.

## Records against the ladder

Six records match the current course hashes, taken from the 2026-09-25 snapshot. Median
record/DAWG is **1.182** (min 1.102, max 1.659), the same figure BRAT's 1.12 ratio was derived from.

| Course | Record/DAWG | Record lands |
|---|---|---|
| crater-rim | 1.102 | MOO–BRAT |
| hood-circuit | 1.157 | BRAT–STEVE |
| diamond-head-waikiki | 1.162 | BRAT–STEVE |
| angkor-tonle-sap | 1.202 | BRAT–STEVE (now has a BRAT; interim was MOO–STEVE) |
| great-wall-ridge | 1.518 | below STEVE |
| gorge-run | 1.659 | below STEVE |

## Solved pace

| Persona | Target ratio | Ratio to DAWG min / median / max | envelopeFrac median | speedCap median |
|---|---|---|---|---|
| MOO | 1.07 | 1.0385 / 1.0699 / 1.0728 | 0.940 | 0.912 |
| BRAT | 1.12 | 1.1167 / 1.1202 / 1.4234 | 0.880 | 0.956 |
| STEVE | 1.40 | 1.3959 / 1.3995 / 1.4540 | 0.800 | 0.781 |

Every rung is within ±1% of its target except these named exceptions:

| Course | Rung | Ratio | Why |
|---|---|---|---|
| eidfjord-voringsfossen | BRAT | 1.423 | clamped *high*: its wide gates can't get that fast |
| eidfjord-voringsfossen | STEVE | 1.454 | *shifted*: pushed down by the clamped BRAT above it |
| madison-isthmus | BRAT | 1.158 | clamped *high* |
| cabo-lands-end | BRAT | 1.131 | clamped *gap* |
| machu-picchu-urubamba | BRAT | 1.132 | clamped *gap* |
| li-river-karsts | MOO | 1.039 | clamped *gap* (1.038 vs 1.07) |
| umpqua-dunes-run | BRAT | 1.319 | *shifted* (solver flag); MOO and STEVE didn't ship on this course |
| willamette-gauntlet | BRAT | 1.137 | *shifted* (solver flag); MOO didn't ship on this course |

Every file keeps STEVE > BRAT > MOO > DAWG over the rivals it ships.

Changes since the interim run:
- devils-lake MOO and li-river BRAT are still marked clamped *high*, but both land within 1%.
- cabo and machu-picchu BRAT moved from *high* to *gap*.

## Failures (still short)

Both are the terrain edge cases the handoff predicted. The gate-window floor rejects them inside
the generator, before the verifier sees them.

| Course | Ships | Missing | Deficit |
|---|---|---|---|
| umpqua-dunes-run | BRAT, DAWG | STEVE, MOO | STEVE: min AGL 31 m, 12 m under the floor inside the gate window. MOO: min AGL 3 m, 29 m under. (885 s) |
| willamette-gauntlet | STEVE, BRAT, DAWG | MOO | MOO: min AGL 16 m, 2 m under the floor inside the gate window. (698 s) |

The remaining gap is at umpqua: a slower line has to hold altitude through a gate window that
sits low over the dunes. Willamette's MOO misses by 2 m, and another seed may clear it. No
envelope, floor or verifier rule was loosened to get them.

## Career cups

- **Full 4×4:** Alaska, Aloha, Alpine, Aviation History, Badger, Canyon, Cascade, China, Fjord,
  Japan, KHABO, Legends, Pacific, Pylon and Wonders. Alaska and Wonders are new since the interim
  run.
- **Oregon Cup:** 2 of 4 courses complete. umpqua-dunes-run ships 2/4 and willamette-gauntlet 3/4.
- **Bush Cup:** skipped. There is no envelope for aircraft 13 or 1.

## Merge with origin/main

- `race/rivals/README.md`: kept both sides. main's paragraph on how `race.js` fetches rival files
  comes first, then this branch's `index.json` / `ladder.json` / `records-snapshot.json` entries.
- `race/test/run.js`: only the three pinned fixture values changed:
  - `files.length === 55` → `65`.
  - The 3-rival file is now `willamette-gauntlet.json` (zion ships 4).
  - The 2-rival file is now `umpqua-dunes-run.json` (copper ships 4).

## Tests

All four suites are green on the final data, and again after the merge:
- `node run.js`
- `node rivals.test.js`
- `pytest test_rivals.py` (64 passed)
- `pytest test_server.py` (355 passed)

No `race.js` code changed on this branch, so `CONFIG.VERSION` is not bumped.
