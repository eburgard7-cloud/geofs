# Merge report: 2026-09-24

How last night's branches were integrated into `integrate/2026-09-24`, what was checked, and what
still has to happen before anything is deployed. The branch was cut from `origin/main` at `844b229`.
Nothing was pushed, merged to `main` or deployed from this session.

Companion reports in this folder: [OVERNIGHT_REPORT.md](OVERNIGHT_REPORT.md) (the content
expansion) and [DOCS_REPORT.md](DOCS_REPORT.md) (the docs overhaul and its porting map).

## Merged, in order

| # | Branch | Tip merged | Merge commit | Conflicts |
|---|---|---|---|---|
| 1 | `origin/race-deploy-prune` | `1593b25` | `9e74520` | none |
| 2 | `origin/overnight-0923` | `6ffa0de` | `ceee37f` | none |
| 3 | `origin/claude/docs-overhaul-9p0xhq` | `bc8a9d8` | `3f728ce` | `race/README.md`, `race/server/DEPLOY_CHECKLIST.md` (docs only) |

Follow-up commits on the branch:

| Commit | What |
|---|---|
| `4939cc6` | ACCEPTANCE rows and `[Unreleased]` CHANGELOG entries for the merged work |
| `f25f1cf` | `compose.snippet.yml` comment names `race/runways` |
| *(this commit)* | This report, the runways mount in the RUNBOOK's manual rollback command, and the docs index entry |

All merges are `--no-ff` merge commits, with no rebases, so every branch's history stays traceable.

**Not merged, discarded (Eric's call, 2026-09-24):**
- `race-rename-settings-panel` (`57cd0f1`): its tip is a merge commit with **conflict markers
  committed into `race.js`** (3 markers). Everything else on it is already on `main`.
- `rolling-start` (`bc51a1e`, "WIP … temp commit for branch move"): every test, doc, protocol and
  server line is already on `main`. The rest is pre-ui-unify CSS and the old `puFrameBtn`
  (Manual sync), both superseded.
- Both carry one small rename UX that never reached `main`: an inline editor on the top-bar callsign
  chip, an "X is now Y" feed line on the `renamed` frame, and the callsign mirrored under Settings.
  On `main`, `Shell.startRename()`/`commitRename()` exist but are dead code (`E.meInput` is never
  built, and the chip routes to Solo). Listed under [Follow-ups](#follow-ups).

## Conflicts and how each was resolved

| File | Cause | Resolution |
|---|---|---|
| `race/README.md` | docs-overhaul rewrote it (1423 → 293 lines). overnight added terrain sources, Physics Lab G/R/A and joke-pack text to the old file. prune added two file-tree lines | Took the docs branch's file (its structure wins), then re-homed every overnight/prune block (below) |
| `race/server/DEPLOY_CHECKLIST.md` | docs-overhaul turned it into a stub. overnight added the runways copy/mount/env/log steps and prune added step 7 | Took the stub, then re-homed both into `docs/RUNBOOK.md` |

No code conflicts. `race.js` was untouched by all three branches. `app.py`, `redeploy.sh`,
`autodeploy.sh` and `test_server.py` merged cleanly, and I reviewed the combined deploy scripts by
hand. The prune step and the runways mount sit in separate hunks, and the rollback `docker run` in
`autodeploy.sh` has both.

**Index files:** only overnight touched them, so there was nothing to union.
`race/courses/index.json` has 69 entries and `race/runways/index.json` has 26, each sorted by id
with no duplicates. `race/models/index.json` (12) is **not** sorted by id. It never was on `main`:
it's in picker order with goldfish first. Only the six new models were appended, so it's left as is.

## Re-homed content (nothing overnight or prune wrote was dropped)

| Block | From | To |
|---|---|---|
| Terrain sources `auto` (new default) / `global` (Terrarium) / `usgs` | overnight → race/README "Checking a course against terrain" | RUNBOOK → [Terrain check](../../RUNBOOK.md#terrain-check), plus a no-structures note |
| Physics Lab GRAPHICS G0–G2 | overnight → race/README Physics Lab | RUNBOOK → [Physics Lab sections](../../RUNBOOK.md#physics-lab-sections) |
| Physics Lab RUNWAYS R0–R2 and the "Copy report (JSON)" rename | same | same, plus the "What to paste back" line |
| Physics Lab AIRCRAFT A0–A1 and the Bush Cup `aircraftId` note | same | same, plus RUNBOOK → Add a course "If it breaks" |
| Generating the models: 12 models, v2 re-centring, float-drift note, `render_models_preview.py` | overnight → race/README "Generating the models" | RUNBOOK → [Add or assign a joke model](../../RUNBOOK.md#add-or-assign-a-joke-model) |
| Copy `race/runways`, compose `RACE_RUNWAYS_DIR` and ro mount, no-compose `-v`/`-e`, `runways loaded: M` | overnight → DEPLOY_CHECKLIST §1, §3a, §3b, §5 | RUNBOOK → [Two layouts](../../RUNBOOK.md#two-layouts-on-the-box), [First-time or manual deploy](../../RUNBOOK.md#first-time-or-manual-deploy-scp-layout), [Redeploy by hand](../../RUNBOOK.md#redeploy-by-hand-redeploysh) Verify |
| Step 7 prune, its dangling-only safety rules, the PRUNE log line, `--no-prune` | prune → DEPLOY_CHECKLIST §7 | RUNBOOK → [Redeploy by hand](../../RUNBOOK.md#redeploy-by-hand-redeploysh) |
| Rollback-path prune, `--no-prune` pass-through | prune → DEPLOY_CHECKLIST §8 | RUNBOOK → [Autodeploy](../../RUNBOOK.md#autodeploy) |
| `redeploy.sh … --no-prune` and `prune.sh` file-tree lines | prune → race/README | race/README → [Files](../../../race/README.md#files) |

**Docs made stale by the merge, and fixed:**
- RUNBOOK → Backups said `prune.sh`/`--no-prune` don't exist. It now documents the 10-backup
  rotation.
- RUNBOOK → Add a runway said the server scores against the `RUNWAYS` dict in `app.py`. It now
  covers `load_runways()`, `RACE_RUNWAYS_DIR`, the embedded fallback, `add_runway.py` and
  LANDING_CUPS.md.
- RUNBOOK → Add a course said cup/difficulty are added by hand and dropped on re-import. It now
  covers `--cup`/`--difficulty` (kept on re-import) and `design_course.py`.
- RUNBOOK → Roll back: the manual `race:prev` command gains the runways mount.
- RUNBOOK gains an **Addons** entry (`race/ADDONS.md`, `check_addons.py`), the new test files in
  Run the tests, and the CLAUDE.md push rule under "The rules that bind every session".
- RUNBOOK → Parallel sessions: the worktree and "push from the VS Code terminal" setup, which
  DOCS_REPORT marked unverified, is now recorded as confirmed by Eric.
- race/README → Files lists every new file, tool and test. Landing mode links LANDING_CUPS.md and
  BUSH_MODE.md.
- Root README: 69 courses / 17 cups, 12 joke planes (+6 table rows, preview.png), 26 runways, and a
  repo tree with `docs/reports/`, `addons.json`/`ADDONS.md` and the designs.
- docs/README index: rows for LANDING_CUPS.md, ADDONS.md, LAPS.md, BUSH_MODE.md and this reports
  folder.
- `race/courses/CUPS.md`: the Physics Lab pointer now links the RUNBOOK section, not race/README.
- `docs/REFERENCE.md` regenerated: adds the `RACE_RUNWAYS_DIR` row.
- `OVERNIGHT_REPORT.md` and `DOCS_REPORT.md` moved here with `git mv`, and DOCS_REPORT's 96 relative
  links were rewritten for the new depth. Their text is otherwise unchanged, so DOCS_REPORT still
  describes the pre-merge state (e.g. "prune.sh doesn't exist").

## Test results

`node` via the portable Node 22.14.0. Python 3.14.4. Every suite was run after each step.

| After | `run.js` | `test_server.py` (CI job) | all `race/test/*.py` | ruff | shellcheck (3 scripts) |
|---|---|---|---|---|---|
| baseline `origin/main` | all passed | 252 | 363 | clean | clean |
| 1 race-deploy-prune | all passed | 259 | 370 | clean | clean |
| 2 overnight-0923 | all passed | 266 | 470 | clean | clean |
| 3 docs-overhaul | all passed | 266 | 477 | clean | clean |
| final | all passed | 266 | 477 | clean | clean |

shellcheck ran on the LF content. The Windows checkout has CRLF (`core.autocrlf=true`), which is a
local artifact: the committed blobs are LF.

## Verification of the integrated tree

| Check | Result |
|---|---|
| `python race/tools/gen_docs.py --check` | Stale after merge 3 (`RACE_RUNWAYS_DIR` missing), then regenerated and up to date |
| `python race/tools/check_addons.py` (online) | Schema OK, 6/6 pinned SHAs OK, 1 loose hotkey collision (flight-path-vector `L` vs race.js `Alt+L`, harmless) |
| Model validator (`test_models.py` + `test_models_pack.py`) | 60 passed (12 models) |
| `add_course.normalize()` dry run over every indexed course (nothing written) | 69/69 valid, `normalize()` is lossless on every file, all 69 hashes match `race/test/course_hashes.json`, no orphan hash entries |
| `check_terrain.py --all --source auto` | **57/69 PASS at 150 m**, the same 12 as OVERNIGHT_REPORT. The 8 Pylon/Bush courses were re-run at their own margins and **all 8 PASS** (Pylon at 30 m: 45.1–72.9 m; Bush at 60 m: 75.0–84.0 m). The other 4 are the known ones: the 3 deliberately low Oregon "tight" courses (`ecola` 45.3, `umpqua` −33.2, `willamette` 18.3) and the `starter-sprint-seatac` test course (−7.2). 0 UNVERIFIED samples. **USGS was reachable from here**, unlike overnight, so see the next section |
| Link check: every tracked `.md`, Markdown links plus `href`/`src`, file and `#anchor` targets, GitHub slug rules, outside code fences | 19 files, 0 broken (the checker is a scratchpad script, not committed) |
| Docker image build | **Not run.** Docker isn't installed on this PC. Verified statically (below) |

**The USGS re-check that OVERNIGHT_REPORT asked for is done.** Every course inside the CONUS
bounding box was checked on real USGS 3DEP this time (`source auto(global+usgs)`, no fallback).
Overnight's numbers were all Terrarium. Every new or repaired CONUS course still passes. Worst
clearance on USGS (the Terrarium design target was ~190 m):

| Course | USGS worst clearance | Note |
|---|---|---|
| `copper-canyon-urique` | **150.3 m** | Mexico, but inside the CONUS box, so it was sent to USGS (1″ data, which does cover it). Passes by 0.3 m. Watch it in the fly-through |
| `la-paz-espiritu-santo` | 163.8 m | Baja, same routing |
| `grand-canyon-inner-gorge` | 173.5 m | Terrarium smoothed the walls, and USGS is ~16 m tighter than the design |
| `monument-valley` | 175.2 m | |
| `lake-powell-glen-canyon` | 182.8 m | |
| `apostle-caves`, `three-sisters`, `zion-canyon`, `dells-narrows`, `kitty-hawk-kill-devil`, `star-wars-canyon`, `oshkosh-fisk-arrival`, `madison-isthmus`, `devils-lake-bluffs`, `edwards-rogers-mach1` | 185.0–189.6 m | Includes the WS9 v2 repairs |
| `crater-rim`, `gorge-run`, `st-helens-crater`, `hood-circuit` | 155.7, 155.2, 172.1, 1332.8 m | Core Oregon, unchanged |
| `stehekin-lake-chelan-bush`, `middle-fork-salmon-bush` | 76.0, 84.0 m (margin 60) | 90 m on Terrarium |
| `reno-stead-unlimited` | 66.5 m (margin 30) | |

**Static server check.** The Dockerfile has `COPY race/runways/ /app/runways/` and
`ENV RACE_RUNWAYS_DIR=/app/runways`. `.dockerignore` has `!race/runways/*.json`.
`compose.snippet.yml` has the env and the `./race-api/race/runways:/app/runways:ro` mount.
`redeploy.sh` step 5 and `autodeploy.sh`'s rollback `docker run` both add
`-v $APP_DIR/race/runways:/app/runways:ro -e RACE_RUNWAYS_DIR=/app/runways`. `app.py`'s
`_default_runways_dir()` resolves env → `/app/runways` → the checkout. `/health` and its PASS
criterion (200 plus `courses > 0`) are unchanged, so a runways problem can't fail a deploy: it
degrades to the 3 embedded runways instead. `prune.sh` is sourced from `$(dirname "$0")`, so it
comes along with the checkout.

## What changes on the Unraid side

**Git-checkout layout (`race`, run by `race-autodeploy`), which is how `main` reaches production:**
**nothing to do by hand.** No new env var, mount or host path needs creating:
- The new `race/runways/` directory arrives with the checkout. `redeploy.sh` mounts it read-only
  and sets the env itself.
- The first tick after the push still runs the **old** `autodeploy.sh` from disk (the one at the
  currently deployed SHA). It checks out the new SHA and calls the **new** `redeploy.sh`, which does
  the runways mount and the step-7 prune. From the next tick on, the new `autodeploy.sh` runs, and
  its rollback path also has the runways mount and prune.
- The prune is new behaviour: after the first PASS it deletes all but the 10 newest
  `race.db.bak-*` in `DATA_DIR`. If older backups matter, copy them off the box **before** pushing
  to `deploy`, or run that first deploy by hand with `redeploy.sh --no-prune` (with autodeploy
  paused).
- Confirm the User Scripts job still calls
  `/mnt/user/appdata/stack/race/app/race/server/autodeploy.sh` (the checkout's copy), not a copy
  of the script saved elsewhere. A copy would never pick up these changes.

**scp/Compose layout (`race-api`), if it's still in use anywhere:** copy `race/runways/*.json` to
`/mnt/user/appdata/stack/race-api/race/runways/`. Add `RACE_RUNWAYS_DIR: /app/runways` and
`- ./race-api/race/runways:/app/runways:ro` to the live compose file, then rebuild. These are live
changes that need your approval, and I haven't made any of them.

**Expect in `docker logs race`:** `runways loaded: 26 from /app/runways`. A count of `3` means the
mount is missing.

## In-sim before deploy

Nothing from the merged branches has been flown on geo-fs.com. Per the release rule, no version bump
and no push to `deploy` until these ACCEPTANCE rows pass. They were added in `4939cc6`:

| Rows | What |
|---|---|
| Course 1 | The Courses tab lists all 69 |
| Course 2–6 | **Fly these first:** `chamonix-midi`, `reine-lofoten`, `kai-tak-checkerboard` (buildings?), `denali-ruth-gorge`, `budapest-danube-chain-bridge` (bridges?) |
| Course 7 | The seven v2 repairs: `dells-narrows`, `madison-isthmus`, `apostle-caves`, `devils-lake-bluffs`, `three-sisters`, `star-wars-canyon`, `cabo-lands-end` |
| Course 8 | Structures: `tokyo-bay-rainbow`, `shimanami-straits`, `giza-pyramids`, `great-wall-ridge`, `diamond-head-waikiki`, `paris-le-bourget-1927` |
| Course 9–10 | A Pylon circuit (unrolled laps) and a Bush ground start |
| Model 1 | The six new joke models, orientation and size |
| Runway 1–3 | One landing on each of the 23 new runways, especially `lflj-22` (uphill?), `tncs-12` and `patk-01` |
| Deploy 1–2 | After deploy: `runways loaded: 26`, a PRUNE line, `race:prev` kept, ≤ 10 backups |
| Lab G0–A1 | Physics Lab discovery. **A0/A1 produce the Bush Cup aircraft ids** |

The ui-unify rows UI1–UI4 are still open from before, and are part of the same run.

## Bush Cup aircraft ids to fill in

All four ship `aircraftId: null` with `startType: "ground"`. Get the ids from Physics Lab A0/A1 on
geo-fs.com, then re-import each one with `python race/tools/add_course.py race/courses/<id>.json
--force` after setting `aircraftId`, and re-pin its hash in `race/test/course_hashes.json`. Do this
**before anyone sets a time**, because the aircraft lock is part of the hash.

| Course | Intended aircraft | `aircraftId` |
|---|---|---|
| `stehekin-lake-chelan-bush` | Piper Cub / Cessna 172, floatplane if GeoFS has one | *(fill in)* |
| `lake-clark-tanalian-bush` | Super Cub / C172 | *(fill in)* |
| `ruth-gorge-bush` | Super Cub on skis / C172 | *(fill in)* |
| `middle-fork-salmon-bush` | Super Cub / C172 | *(fill in)* |

## Decisions still open (carried from the two reports)

1. **License:** there's no LICENSE file, and the README says "All rights reserved". Separately,
   the six pinned addons: five have no license, and `information-display` conflicts (CC BY-NC-SA 4.0
   vs GPL-3.0). See ADDONS.md.
2. **AUDIT.md:** it's kept as dated history. Stub it if you'd rather not keep it.
3. **PROTOCOL.md stale facts** that the docs pass left alone: "five things", "`PROTO` (currently
   6)", the `joined` example `"proto": 6`, "see 'Manual sync' below", "race/formation.js".
4. **Stale code comments:** `race.js:166` names `race/formation.js`, and `KNOWN_TERRAIN_STATUS`
   still marks gorge-run and crater-rim as failing (AUDIT B4). It doesn't know the 54 new courses
   either, so their vote tiles have no terrain badge.
5. **No UI for cups or rules** in the default shell (AUDIT B2).
6. **The FALLBACK pin is still `race-v1.0.0`.**
7. **CLAUDE.md push rule:** race-deploy-prune changed "Never push." to "Pushing feature branches and
   opening PRs is allowed; never push to main or deploy." **Kept, on Eric's instruction.**
8. **USGS re-check** of the CONUS courses, which OVERNIGHT_REPORT only had on Terrarium: **done
   and passing** (see above). The one thin margin is `copper-canyon-urique` at 150.3 m.

## Follow-ups

- **Rename UX** from the discarded branches: port the inline chip editor, the "X is now Y" feed
  line and the Settings mirror onto the ui-unify shell. This needs `race.js`, `run.js` tests and a
  version bump, or else delete the dead `startRename()`/`cancelRename()`/`commitRename()`.
- **CI runs only `test_server.py`** of the Python suites. `test_add_course.py`,
  `test_check_terrain*.py`, `test_models*.py`, `test_add_runway.py`, `test_design_course.py`,
  `test_check_addons.py` and `test_gen_docs.py` (211 of the 477) only run locally. Consider a
  `pytest race/test` job plus `gen_docs.py --check`.
- **`physics_lab.js` pure exports** (`GRAPHICS_PATHS` … `normalizeAircraftList`) have no `run.js`
  cases.
- **Code comments** in `redeploy.sh`, `autodeploy.sh` and `app.py` still cite
  `DEPLOY_CHECKLIST.md` sections. The stub keeps them resolvable, and they should point at the
  RUNBOOK next time those files are touched.
- `docs/REFERENCE.md` shows `RACE_RUNWAYS_DIR` with default *(none)*. The real fallback chain is
  `/app/runways`, then the checkout (the generator can't see through `_default_runways_dir()`).
- `KNOWN_TERRAIN_STATUS` in `race.js` (see decision 4).

## Session report

- **Commits:** `9e74520`, `ceee37f` and `3f728ce` (the three merges), `4939cc6` (ACCEPTANCE +
  CHANGELOG), `f25f1cf` (compose comment), plus the commit that adds this report.
- **CONFIG flags added:** none (`race.js` unchanged). **Protocol frames added:** none.
  **Server:** the runway loader (`RACE_RUNWAYS_DIR`) from overnight. `SERVER_VERSION`/`PROTO`
  unchanged.
- **Tests added:** none by this session. Brought in by the merges: +7 (prune) + 100 (overnight) + 7
  (docs) = +114 pytest. Total pytest went from 363 to 477.
- **ACCEPTANCE rows added:** 23 (Course 1–10, Model 1, Runway 1–3, Deploy 1–2, Lab G0/G1/G2/R0/R1/R2/A0·A1).
- **Skipped:** the Docker build (no Docker here), and merging the two stale branches (discarded).
