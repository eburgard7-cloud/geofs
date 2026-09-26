# Rival generator: first run

Computed "perfect line" ghosts for four rival pilots — STEVE, BRAT, MOO, DAWG — built by
`race/tools/rival_gen.py` against `race/tools/envelope.py`'s F-16 envelope, judged by
`race/tools/rival_verify.js`. Branch `rivals-gen`, pushed, no PR opened yet (see the end of this
report). No version bump, per the brief.

## Headline (sorted by DAWG/Record where a record exists)

Only 6 of the 55 shipped courses have a human record on the current course hash. DAWG's ratio to
that record is 0.60–0.91 here — well under the 0.97 the design targets — because the ratio was
computed against **defaults**, not the calibrated fracs (see [Calibration](#calibration) for why).
No House ghost exists yet for any course (`robot_pilot.js` hasn't uploaded one), so that column is
empty throughout.

| Course | STEVE | BRAT | MOO | DAWG | Record | DAWG/Record | House |
|---|---|---|---|---|---|---|---|
| gorge-run | 5:58.125 | 4:41.542 | 4:23.717 | 4:13.753 | 7:00.848 | 0.603 | - |
| great-wall-ridge | 1:49.188 | 1:31.354 | 1:26.390 | 1:23.979 | 2:07.465 | 0.659 | - |
| angkor-tonle-sap | 2:21.048 | 1:53.146 | 1:46.166 | 1:42.568 | 2:03.320 | 0.832 | - |
| diamond-head-waikiki | 1:35.593 | 1:17.975 | 1:13.460 | 1:11.196 | 1:22.754 | 0.860 | - |
| hood-circuit | 2:40.008 | 2:08.218 | 2:00.646 | 1:56.668 | 2:14.953 | 0.865 | - |
| crater-rim | 1:31.129 | 1:15.089 | 1:10.585 | 1:08.576 | 1:15.579 | 0.907 | - |
| apostle-caves | 4:44.809 | 4:00.801 | 3:49.493 | 3:43.433 | - | - | - |
| chamonix-midi | 2:34.760 | 1:39.344 | 1:34.264 | 1:32.137 | - | - | - |
| chiba-makuhari-slalom | 4:15.697 | 4:04.029 | 3:35.617 | *fail* | - | - | - |
| copper-canyon-urique | *fail* | *fail* | 2:04.591 | 2:01.858 | - | - | - |
| dells-narrows | 0:46.473 | 0:43.928 | 0:40.235 | 0:39.242 | - | - | - |
| denali-ruth-gorge | 1:58.913 | 1:36.199 | 1:30.804 | 1:27.981 | - | - | - |
| edwards-rogers-mach1 | 2:37.115 | 2:05.965 | 1:58.063 | 1:54.036 | - | - | - |
| eidfjord-voringsfossen | 1:39.444 | 1:47.366 | *fail* | 1:11.828 | - | - | - |
| fuji-five-lakes | 3:03.627 | 2:40.411 | 2:31.742 | 2:18.351 | - | - | - |
| geiranger-sisters | 1:13.969 | 1:00.872 | 0:57.337 | 0:55.817 | - | - | - |
| giza-pyramids | 2:37.598 | 2:14.638 | 2:08.471 | 2:05.859 | - | - | - |
| glen-coe | 1:36.054 | 1:18.081 | 1:13.564 | 1:11.314 | - | - | - |
| grand-canyon-inner-gorge | 1:15.060 | 1:04.282 | 0:59.815 | 0:58.525 | - | - | - |
| ha-long-karsts | 1:28.588 | 1:21.166 | 1:15.575 | 1:13.332 | - | - | - |
| haleakala-crater | 1:57.661 | 1:37.485 | 1:32.468 | 1:29.837 | - | - | - |
| kai-tak-checkerboard | 1:23.422 | 1:08.837 | 1:04.968 | 1:03.094 | - | - | - |
| kenai-fjords-exit-glacier | 2:10.539 | 1:45.063 | 1:39.081 | 1:35.854 | - | - | - |
| kitty-hawk-kill-devil | 2:12.978 | 1:46.946 | 1:40.307 | 1:36.932 | - | - | - |
| knik-glacier | 2:39.300 | 2:07.353 | 1:59.659 | 1:55.551 | - | - | - |
| kurobe-gorge | 2:13.194 | 1:51.203 | 1:45.750 | 1:43.089 | - | - | - |
| la-paz-espiritu-santo | 2:30.553 | 2:00.485 | 1:53.364 | 1:49.492 | - | - | - |
| lake-hood-floatplane-circuit | 2:11.599 | 2:05.289 | *fail* | *fail* | - | - | - |
| lake-powell-glen-canyon | 2:04.109 | 1:42.426 | 1:34.846 | 1:31.652 | - | - | - |
| lauterbrunnen-falls | 1:23.436 | 1:08.571 | 1:04.573 | 1:02.757 | - | - | - |
| li-river-karsts | 2:52.074 | 2:36.255 | 2:27.611 | 2:24.357 | - | - | - |
| lysefjord-kjerag | 2:17.071 | 1:49.818 | 1:43.720 | 1:40.328 | - | - | - |
| mach-loop | 2:28.980 | 1:59.812 | 1:52.481 | 1:48.788 | - | - | - |
| machu-picchu-urubamba | 3:01.524 | 2:49.977 | 2:38.958 | 2:21.621 | - | - | - |
| madison-isthmus | 1:36.075 | 1:31.070 | 1:26.339 | 1:24.689 | - | - | - |
| milford-sound | 1:36.836 | 1:18.943 | 1:14.257 | 1:11.990 | - | - | - |
| molokai-sea-cliffs | 2:21.693 | 2:03.365 | 1:56.561 | 1:53.216 | - | - | - |
| monument-valley | 1:46.037 | 1:39.734 | 1:35.271 | 1:33.270 | - | - | - |
| na-pali-coast | 2:57.797 | 2:45.745 | 2:36.794 | 2:32.414 | - | - | - |
| oshkosh-fisk-arrival | 2:45.771 | 2:12.341 | 2:04.295 | 1:59.977 | - | - | - |
| petra-wadi-musa | 2:14.469 | 1:57.785 | 1:26.070 | 1:23.379 | - | - | - |
| qutang-gorge | 2:35.829 | 2:05.239 | 1:56.977 | 1:52.940 | - | - | - |
| reno-stead-unlimited | 2:12.126 | 1:56.279 | 1:49.977 | 1:47.667 | - | - | - |
| sakurajima-circuit | 2:45.528 | 2:14.837 | 2:07.950 | 2:03.803 | - | - | - |
| shimanami-straits | 2:52.008 | 2:33.517 | 2:27.123 | 2:24.228 | - | - | - |
| st-helens-crater | 1:55.680 | 1:56.484 | 1:41.896 | 1:39.892 | - | - | - |
| star-wars-canyon | 1:09.765 | 0:59.305 | 0:55.929 | 0:54.711 | - | - | - |
| three-sisters | 2:19.983 | 1:58.863 | 1:53.124 | 1:50.628 | - | - | - |
| todos-santos-coast | 2:29.132 | 1:59.097 | 1:52.021 | 1:48.201 | - | - | - |
| tokyo-bay-rainbow | 2:39.494 | 2:07.218 | 1:59.651 | 1:55.524 | - | - | - |
| valdez-keystone-canyon | 2:28.490 | 1:58.828 | 1:52.121 | 1:48.370 | - | - | - |
| waimea-canyon-gorge | 1:31.278 | 1:50.045 | 1:16.685 | 1:15.007 | - | - | - |
| zermatt-matterhorn | 2:00.602 | 1:37.886 | 1:32.574 | 1:29.790 | - | - | - |
| zhangjiajie-pillars | 2:04.816 | 1:53.596 | 1:20.563 | 1:19.138 | - | - | - |
| zion-canyon | *fail* | 1:44.782 | 1:38.819 | 1:36.296 | - | - | - |

## Envelope (`race/rivals/envelope-7.json`)

Mined from 8 traces on the leaderboard, all from 3 pilots (`petpiratepete`, `Aleksi`, `EB`), all
passing the jet-speed check (0 unattributed, 0 other-aircraft). 5153 samples total.
`envelope_version: "seed-1+mined"`.

| Table | mined bins | seed bins |
|---|---|---|
| n_inst | 13 | 6 |
| n_sus | 2 | 12 |
| accel_ms2 | 10 | 9 |
| decel_ms2 | 4 | 14 |
| ps_ms | 0 | 15 |
| vmax_ms | 2 (of 3 alt bands) | 1 |
| roll_rate_dps, roll_sign | 0 | seed (see below) |

25 thin bins fell back to seed (listed in the file's own `thin` array). **Roll is unverified**:
race.js's recorded `roll` column never leaves ±1.0 in any of the 8 traces (p99 = 0.63), which reads
as a control-deflection-like value, not a bank angle — `attitude_suspect: true` in the file, and
both `roll_rate_dps` and `roll_sign` stay at their seed values (180°/s, +1) until a capture card is
flown.

**Two bugs found and fixed in the seed table itself**, both from watching the first generation
batch fail physically:
- The forward/backward speed-integration pass had a hardcoded `5.0 m/s` fallback when required
  deceleration went negative (e.g. at a tight terrain-avoidance via). That's below any real
  aircraft's controllable speed and the envelope's own domain (lowest bin: 50 m/s); it produced a
  physically meaningless near-hover point that then read back as a spurious multi-g violation a
  few samples later. Now floors at the envelope's own lowest speed bin instead.
- The seed's `n_inst`/`n_sus` clamped to exactly 1.0 g below ~90 m/s — i.e. "cannot turn at all
  below 97 kt" — unrealistically conservative for a fighter well above stall. Raised the floor to
  2.0 g (instantaneous) / 1.5 g (sustained), which cleared most of the resulting failures.
- A residual, smaller class of over-g failures (see below) is real physical infeasibility in the
  model at the seed's current numbers, on specific mountainous/canyon courses, not a bug.

## Optimizer / verifier bugs found and fixed this session

One more bug, more serious than the two above, was found only by running the full batch:

- **`race/tools/rival_verify.js` could time a rival ~2 seconds early on a closed-loop course.**
  `Race.reset()` (called from `Race.load()`) deliberately reads the *existing* `race.prev` to seed
  `wasInStart` — correct behaviour for a live game where a course switch keeps the aircraft's
  actual position. Replayed offline, that same read let the *previous* replay's finish position (on
  a closed-loop course, sitting right at gate 0) leak into the next replay's `reset()`, before this
  file's own clearing of `race.prev`/`race.prevT` had run — `wasInStart` came out spuriously `true`,
  and `detectStart` fired a false GO at the top of the lead-in instead of at the real crossing,
  inflating every later split by very close to `LEAD_IN_MS` (2000 ms). Fixed by clearing
  `race.prev`/`race.prevT` **before** `load()`, not after, and (belt and braces) giving the CLI a
  fresh env per file rather than one shared across the whole batch. A regression test (a
  closed-loop synthetic course replayed twice on one env) is in `race/test/rivals.test.js`.
  This is what made `lake-hood-floatplane-circuit` and `reno-stead-unlimited` fail earlier runs;
  both ship correctly now (lake-hood still has 2/4 personas failing — see below — but for a
  genuine, different reason).

## Remaining failures (26 of 239 rival attempts, 9 of 64 attempted courses)

All genuine physics-limit violations now, not bugs: the persona's line demands more instantaneous
load factor than even the revised (still deliberately conservative) seed envelope allows at the low
speed a tight terrain-avoidance turn forces it down to. Concentrated on mountainous/canyon terrain:

| Course | Failing personas | Worst margin |
|---|---|---|
| budapest-danube-chain-bridge | all 4 | 6.4 g vs 2.0 g limit |
| cabo-lands-end | all 4 | 5.9 g vs 2.0 g limit |
| devils-lake-bluffs | all 4 | 5.0 g vs 2.0 g limit |
| paris-le-bourget-1927 | all 4 | 2.3 g vs 2.0 g limit |
| reine-lofoten | all 4 | 2.6 g vs 2.0 g limit |
| chiba-makuhari-slalom | dawg | 3.6 g vs 3.4 g limit |
| copper-canyon-urique | steve, brat | 2.2 g vs 2.0 g limit |
| lake-hood-floatplane-circuit | moo, dawg | 2.2 g vs 2.1 g limit |
| zion-canyon | steve | 2.1 g vs 2.0 g limit |

The largest margins (budapest, cabo-lands-end, devils-lake-bluffs) are 3–4x the limit, not a close
call — these courses likely need either a genuinely higher n_inst floor (once real capture-card
data replaces the seed) or a smarter terrain-avoidance mechanism than a single vertical lift/via
(see `race/tools/rival_gen.py`'s `lift_for_terrain`/`plan_vias`, which only ever adds vertical
clearance, never re-routes laterally). Flagged as unverified/needs more work, not fixed this
session — a defensible stopping point after three real bugs already found and fixed in this area.

## Skipped before generation (5 courses)

| Course | Reason |
|---|---|
| lake-clark-tanalian-bush | no envelope for aircraft 13 (DHC-2 Beaver) |
| middle-fork-salmon-bush | no envelope for aircraft 13 |
| ruth-gorge-bush | no envelope for aircraft 1 (Piper Cub) |
| stehekin-lake-chelan-bush | no envelope for aircraft 13 |
| starter-sprint-seatac | ground start: the solo-spawn entry model is air-start only |

## Skipped at generation, zero rivals (4 courses)

Every persona's terrain-avoidance line, at its full usable gate window, still landed under the
60 m AGL floor: `ecola-headland-run`, `tre-cime-loop`, `umpqua-dunes-run`, `willamette-gauntlet`.
`umpqua-dunes-run`'s centre line is 238 m *below* the floor at its worst point — this course likely
needs a real re-route (multiple vias), not just a vertical lift.

## Calibration

`--calibrate` requires 5 usable record courses (a record on the course's *current* hash, whose
record-holder trace passes the envelope's jet-speed check) before it touches the defaults, per the
brief. Exactly 6 qualified: `angkor-tonle-sap`, `crater-rim`, `diamond-head-waikiki`, `gorge-run`,
`great-wall-ridge`, `hood-circuit`. Two more records exist but are on a stale course hash
(`apostle-caves`, `cabo-lands-end`) and were correctly excluded.

Run once, calibration converged cleanly:

| Persona | Target | Calibrated frac | Default frac |
|---|---|---|---|
| DAWG | 0.97 | 0.826 | 0.98 |
| MOO | 1.00 | 0.797 | 0.94 |
| BRAT | 1.06 | 0.753 | 0.88 |
| STEVE | 1.15 | 0.800 | 0.80 |

**Judgment call: shipped the DEFAULTS, not the calibrated fracs**, and this needs Eric's sign-off.
The calibration is doing exactly what it's told, but the only "records" available are 3 pilots'
single, casual, un-optimized flights (not attempts at speed) — fitting to them pulls every
persona's aggressiveness down to nearly the same low level (0.75–0.83), which is a data-thinness
artifact, not what "DAWG flies at 98% of the envelope" is supposed to mean. Shipping the calibrated
numbers would also have made several more courses fail physics verification (checked: 76 failures
vs. the 26 above). Recommend re-running `--calibrate` once genuine timed-attempt records exist on
more than 6 courses — the mechanism itself needs no changes.

## What's unverified in-sim

- **Roll**: `roll_sign` (+1, unmeasured) and `roll_rate_dps` (180°/s, seed) — race.js's own
  recorded traces can't measure either (see above). The read-only in-sim cross-check for this is
  `race/tools/envelope_capture.js`'s "full-deflection rolls" step.
- **The seed envelope generally** below what real traces cover, especially `ps_ms` (climb rate)
  and `n_sus` (only 2 mined bins) — entirely seed-sourced right now.
- **Terrarium vs. GeoFS's rendered terrain** everywhere `race/tools/terrain_probe.js`'s rival
  cross-check hasn't been run yet (i.e. everywhere — it's new this session, never run in-sim).
- **Whether a rival actually reads as "a fighter jet"** — that's a judgment call only a human
  watching the replay can make; see below.

## Eric's 10-minute in-sim check

1. **Fly the envelope card** (`race/tools/envelope_capture.js`, ~6 minutes): load FINSONLY Racing
   in the F-16, click the bookmarklet, follow the on-screen steps. `python tools/envelope.py --lab
   <the copied JSON>` afterward will replace the thin/seed bins above with real data — rerun
   `rival_gen.py --all` + `rival_verify.js --write` after that to refresh every rival.
2. **Terrain cross-check 3 courses**: on `geo-fs.com`, paste `rival:hood-circuit`, then
   `rival:mach-loop`, then `rival:budapest-danube-chain-bridge` (one of the failing ones, for
   contrast) into the terrain-probe bookmarklet's prompt. PASS/FAIL/UNVERIFIED per rival, against
   GeoFS's own rendered terrain, not Terrarium's.
3. **Watch one DAWG trace on the site replay** — `hood-circuit` or `gorge-run` are good picks (both
   have real human records to compare against) — and judge: does it fly like a fighter jet, or does
   it read as slow/stiff/floaty? That single judgment call is the one this whole pipeline can't
   make for itself, and it should also inform whether the calibration decision above is right.

## CLAUDE.md end-of-session report

**Commits** (branch `rivals-gen`, pushed to `origin/rivals-gen`, not merged to `main`, no PR opened
— see below):

| Commit | What |
|---|---|
| `3b2b70b` | Add the F-16 envelope miner and read-only capture card |
| `8d6eac9` | Add the rival lap-time optimizer |
| `3e2f051` | Add rival personas and calibration |
| `7be0f11` | Add the rival verifier |
| `c16690d` | Add the rival terrain cross-check to the terrain probe |
| *(this one)* | Generate F-16 rivals, fix 3 bugs found running the full batch, this report |

**CONFIG flags added**: none (rivals are static files served alongside courses, not a race.js
runtime feature yet — a later session presumably wires `race/rivals/<id>.json` into the ghost
picker, at which point it gets its own flag per this file's own "every new feature has a CONFIG
flag" rule).

**Protocol frames added**: none (no relay/server changes; out of scope per the brief).

**Tests added**: 42 in `race/test/test_rivals.py` (pytest), plus the full `race/test/rivals.test.js`
(counts printed by the run, not gated on a fixed number — every `ok()` call is one assertion).
Commands for CLAUDE.md:
```
cd race && python -m pytest test/test_rivals.py -q
cd race/test && node rivals.test.js
```
Both were green before every commit, alongside the existing `node run.js` and
`python -m pytest ../test/test_server.py -q` suites (also green throughout).

**In-sim checks appended to `race/ACCEPTANCE.md`**: none — the brief scoped this session to *new*
files only (`race/tools/`, `race/rivals/`, new test files), and `ACCEPTANCE.md` is an existing file
outside that list. Eric's 10-minute check above covers the same ground; a later session should
promote it into `ACCEPTANCE.md` proper alongside wiring rivals into the actual ghost picker.

**Skipped / deferred, and why**:
- Roll rate/sign, and the seed envelope generally below the seed floor — needs the capture card.
- The 26 remaining physics failures on 9 courses — needs either better seed data or a
  laterally-rerouting terrain-avoidance mechanism (see above).
- The calibration decision (ship defaults vs. calibrated) needs Eric's call, not just mine.
- No PR opened yet, pending that calibration decision and the in-sim check above — opening one now
  would ship numbers (the DAWG/Record ratios in the headline table) that may change once
  calibration is revisited.
