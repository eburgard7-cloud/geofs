# Native laps: design

Status: **design only**. Nothing here is implemented. It's sized so one Claude Code session can
build it end to end.

## Why

The Pylon Cup circuits (`reno-stead…`, `chiba-makuhari…`, `budapest-chain-bridge…`,
`lake-hood…`) ship **unrolled**: one lap's K gates repeated N times, plus the lap's first gate
once more at the end. That works with today's race.js and server, but:

- a 3-lap, 12-gate course stores 37 gates, so the 201-gate cap limits circuit size and lap count;
- the HUD says "gate 17/37" instead of "lap 2/3, gate 5/12";
- splits are per gate, so there is no lap time and no best-lap board;
- editing one pylon means editing N copies, and forgetting one changes the course hash anyway.

## Schema

Two new optional top-level fields on a course file:

```json
{ "laps": 3, "gates": [ /* ONE lap: K gates, gate 0 = start/finish */ ] }
```

- `laps`: integer 1–20. Missing or 1 = today's behaviour (point-to-point).
- With `laps > 1`, `gates` holds exactly one lap. The race is gates `0..K-1` repeated `laps`
  times, then gate 0 once more to close the final lap. The lap's first gate is the start/finish
  line. Laps 2..N reuse identical coordinates by construction, so a lap can't be edited unevenly.
- `lap_gates` is **not** stored. It is always `gates.length`.
- The expanded gate count is `K × laps + 1` and must stay ≤ 201. That's the same cap as today, and
  it keeps every existing size limit (finish-frame splits, `FINISH_FRAME_MAX_BYTES`) true.

`Course.normalize()` (race.js), `add_course.py normalize()` and the server's `load_courses()` all
read `laps`. Unknown fields are already dropped by both normalizers, so an old client or tool
loading a new file sees a K-gate point-to-point course. That's wrong but harmless, and the hash
rule below makes sure it never shares a board with the real circuit.

## Hash

`Course.hash()` today is FNV-1a over `[aircraftId, gates…]`. **Include laps only when > 1**:

```js
const payload = c.laps > 1 ? [c.aircraftId, gates, c.laps] : [c.aircraftId, gates];
```

- Every existing course (no `laps`) keeps its hash byte for byte, so no board resets. Pin this
  with `race/test/course_hashes.json`, which run.js and test_server.py already check.
- A 3-lap and a 5-lap version of the same circuit are different races with different boards,
  which is correct.
- Hash the **one-lap** gate list plus `laps`, not the expanded list, so the payload stays small.
- `app.py course_hash()` and `add_course.py course_hash()` get the identical change. Add a
  cross-language fixture entry for a laps course so all three implementations are pinned.

### Board compatibility with the unrolled WS14 circuits

An unrolled circuit's hash (37 explicit gates, no `laps`) will never equal its native form's hash
(12 gates + `laps: 3`). Converting a Pylon Cup course is therefore a **new version with a fresh
board**. Recommended: convert before any Pylon Cup night, while the boards are empty. If times
exist by then, keep the unrolled file under its old id for one release and add the native one as
`<id>-v2`.

## Client (race.js)

- `Course.normalize()` accepts `laps` (clamp 1–20; drop it if `K×laps+1 > 201`, with
  `console.warn`). It produces `c.laps` plus an expanded `c.route` used by gate detection, and
  keeps `c.gates` as the one-lap list for rendering. Gate detection code only needs `route`
  instead of `gates`, and nothing else in the progress path changes.
- Gate rendering (`makeGateLayer`): render the K lap gates once. The "next gate" highlight maps
  route index `i` to lap gate `i % K`.
- HUD: `LAP 2/3 · 5/12` when `laps > 1`. The final closing gate shows as `FINISH`.
- Splits: unchanged per route gate, so the finish frame and server validation are untouched. Lap
  times are derived: lap `n` time = `splits[(n+1)·K] − splits[n·K]`, with lap 1 measured from GO
  (air start) or from gate 0 (ground start, today's clock). This is a pure function,
  `lapTimes(splits, K, laps)`, exported to run.js and tested like `bestSectorMs()`.
- Results card: best lap highlighted; a "fastest lap" line in the race results table.
- Ghost / racing line: they already follow the route. The minimap draws the lap once.

## Server (app.py) and relay

- `load_courses()`: read `laps` and expose it as `laps` in the catalog row.
  `course_length_km()` × laps for the chips.
- Race results (proto 4): `finish` frames carry per-gate splits already. The relay computes lap
  times with the same pure `lap_times()` (Python mirror, tested against the JS fixture) and adds
  `best_lap_ms` to the results row. This is an additive field; old clients ignore it.
- **Best-lap board:** add a mode `race_lap` to `MODES` (`metric: lap_ms`, `asc`, payload
  `{course_id, lap_index, race_run_id}`). POST /runs writes the run as today and, when the course
  has `laps > 1`, also one `race_lap` mode_runs row with the run's best lap, in the same
  transaction (same pattern as the proto 6 `race` row). GET `/modes/race_lap/leaderboard?course_hash=`
  then needs no new code.
- Plausibility: a lap faster than `lap_length / RACE_MAX_SPEED_MS` is rejected by the same check
  the whole run gets.
- Protocol: no new relay frames. `joined.proto` goes to the next integer only if the results
  frame change needs gating; if `best_lap_ms` is purely additive, it doesn't. Document it in
  PROTOCOL.md either way.
- CONFIG: `LAPS: true` in race.js (default ON). Against an old server the client still races
  correctly. Only the best-lap board is missing, with one status-line note.

## Migration from the unrolled circuits

`race/tools/roll_laps.py <course.json> [--laps N]`, outline:

1. Load the course and find the smallest K such that `gates[i] == gates[i % K]` for all
   `i < len-1` and `gates[-1] == gates[0]`, comparing lat/lon/alt/radius exactly.
2. If K doesn't exist or `(len-1) % K != 0`, refuse ("not an unrolled circuit").
3. Emit `{…, "gates": gates[:K], "laps": (len-1)//K, "version": version+1}`, keeping name and
   boxes.
4. Print old and new hashes, and write through `add_course.py --force` so index/cup tags are kept.

Tests: round-trip on the four Pylon Cup files (`unroll(roll(x)) == x`), refusal on a
non-periodic course, and hash stability for a course without laps.

## ACCEPTANCE rows (for race/ACCEPTANCE.md)

| # | Check (in sim) | Pass when |
|---|---|---|
| L1 | Load a 3-lap native circuit | HUD shows `LAP 1/3 · 1/K`; only K gates rendered |
| L2 | Fly lap 1 | HUD flips to `LAP 2/3` exactly at gate 0; lap-1 time shown |
| L3 | Finish lap 3 | Finish fires at the closing gate 0; results show 3 lap times + best |
| L4 | Skip a pylon on lap 2 | Same DQ/missed-gate behaviour as a point-to-point course |
| L5 | Old server | Race works; one status note "best-lap board unavailable" |
| L6 | Existing course | Hash unchanged (board still shows old times) |
| L7 | Best-lap board | `/modes/race_lap/leaderboard?course_hash=` lists the lap |
