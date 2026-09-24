# Bush mode: design

Status: **design only**. Nothing here is implemented. It's sized so one Claude Code session can
build it end to end.

## What it is

A bush route is a ground-start race through low, tight gates, with one or more **STOP gates**. At a
STOP the pilot has to land on a backcountry strip, come to a full stop inside a zone, and take off
again to continue. Today's Bush Cup courses (WS15) are plain ground-start routes that finish with
a low pass over the destination strip. This mode adds the stops.

## Schema

Additive fields on a course file:

```json
{
  "mode": "bush",
  "aircraftId": "<GeoFS id>",
  "stops": [
    { "after_gate": 5, "runway_id": "3u2-17", "max_stop_s": 90 }
  ]
}
```

- `stops[].runway_id` references `race/runways/*.json` (the landing-mode runway shape: threshold,
  heading, length, width, zone). The **Bush Strips** group in `race/runways/LANDING_CUPS.md` is
  the pool.
- `after_gate`: the stop is armed once gate `after_gate` is passed. The next gate only counts
  after the stop is complete.
- `max_stop_s` (optional): the stop must be completed within this long after arming. Missing
  means no limit.
- Hash: `Course.hash()` includes `[runway_id, after_gate]` for each stop when `stops` is present,
  using the same only-if-present rule as `laps` in LAPS.md, so existing hashes don't change. The
  runway's own geometry is covered by `runway_hash()`, so include it:
  `[…, stops.map(s => [s.after_gate, s.runway_id, runwayHash])]`.

## Detecting a stop (reuse, don't rebuild)

`race/touchdown.js` already turns a sample stream plus a runway into `touchdown` / `bounce` /
`go_around` / `settled` events, and the server's `score_touchdown()` already scores a touchdown
against a runway. A stop is:

1. **touchdown** on the stop's runway: `along_m` between 0 and `length_m`, and `|cross_m|` ≤
   `width_m/2 + 5`;
2. then **settled**, which touchdown.js emits when IAS ≤ `settledIasMps` (15 m/s). A stop needs a
   stricter full stop, so add ground speed ≤ 1 m/s held for 2 s. That's a new
   `stopped` event in touchdown.js: pure, with its own tests, and it doesn't change the existing
   events;
3. with the stop point still on the runway (`along_m ≤ length_m`).

touchdown.js is **not wired into race.js yet** (it's a standalone module fed by
`tools/recorder.js` recordings and `tools/replay_landing.mjs`). Bush mode is the first client
consumer: add a sampler in the G adapter that reads the fields touchdown.js expects (lat/lon/alt,
AGL, VS, IAS, heading, bank, pitch, on-ground). Those are the same reads recorder.js already makes,
so the G adapter paths come from there. Wire it once, and landing mode can reuse the same sampler
later.

## Timing and penalties (recommendation)

The clock **keeps running** through the stop, so a good landing is a fast landing. Penalties
are added to the final time rather than DQ, except for a missed stop:

| Event | Penalty |
|---|---|
| Touchdown before the threshold (`along_m < 0`) | +10 s |
| Each bounce (touchdown.js `bounce`) | +5 s |
| Stop point past the runway end (overrun) | +20 s, and the stop still counts |
| Touchdown off the runway sideways | stop does not count; must go around and retry |
| `go_around` | no penalty (retry allowed) |
| Stop not completed before the next gate is crossed | **DQ** ("missed stop") |
| `max_stop_s` exceeded | **DQ** |

The recommendation is DQ for a missed stop rather than a time penalty. Otherwise the fastest
line always skips the landing, and the mode stops being bush flying. Softer mistakes (bounces,
overruns) cost time, so the landing can't be won by crashing through it.

A per-stop timing breakdown (armed→touchdown, touchdown→stopped, stopped→airborne) goes in the
results card, and in the finish frame as an additive `stops: [{t_arm, t_td, t_stop, t_air, pen}]`
field (compact, ≤ 8 stops).

## Aircraft class enforcement

`aircraftId` already exists and is in the hash. Bush courses set it to a GeoFS bush-type id,
filled from Physics Lab **A0/A1**. race.js already enforces it: a run in the wrong aircraft is
DQ'd ("This course requires aircraft id …", `Race` gate check). Worth adding as part of this
build: a pre-start warning in the lobby/HUD, so the DQ isn't the first the pilot hears of it. A later extension could allow a *class*
(`aircraftClass: "bush"` → an allow-list of ids), but that isn't in scope for the first build.

## Server and relay

- `load_courses()`: expose `mode`, `stops` (runway ids validated against `RUNWAYS`), plus a
  `stops` count chip.
- Finish frame (proto next): additive `stops[]`. The relay checks each reported stop's
  touchdown lat/lon against the runway with `runway_offsets_m()`, the same trust posture as
  landing mode. The client can lie about its own trajectory, but can't claim a stop on a runway
  it was nowhere near. A run whose stop fails that check is rejected with `detail: "stop not on
  runway"`.
- Board: bush runs are ordinary `race` mode_runs rows (final time including penalties), with
  `stops[]` in the payload. No new mode is needed.
- CONFIG: `BUSH_MODE: true`. Against an old server the course still loads and races with stops
  enforced client-side, but the finish is sent without `stops[]`. The status line notes
  "server doesn't verify stops".

## Floatplane / water strips (later)

Out of scope for the first build. It needs a water-landing detector: GeoFS's floatplane
on-water state is unverified, so run Physics Lab first. The runway shape would carry
`surface: "water"`, and touchdown.js would treat on-water as on-ground. Lake Hood (PALH) is the
obvious first water strip.

## Build order for one session

1. touchdown.js `stopped` event + tests; a G-adapter sampler feeding touchdown.js (paths from recorder.js).
2. Pure `bushStopState(stop, events, gateIndex)` state machine (armed → touched → stopped →
   airborne / missed), exported to run.js + tests.
3. `Course.normalize`/`hash` + `add_course.py` + `app.py course_hash` (fixture-pinned).
4. HUD: `STOP: land at <strip>` banner, stop timer, penalty toasts.
5. Finish-frame `stops[]` + relay verification + tests in test_server.py.
6. Convert one Bush Cup course to a native stop course as a new version.

## ACCEPTANCE rows (for race/ACCEPTANCE.md)

| # | Check (in sim) | Pass when |
|---|---|---|
| B1 | Start a bush course in the wrong aircraft | Pre-start warning names the aircraft; crossing gate 1 DQs |
| B2 | Pass the arming gate | HUD shows `STOP: land at <strip>` |
| B3 | Land, stop, take off | Stop completes; next gate becomes active; per-stop time shown |
| B4 | Fly past the strip without landing | DQ "missed stop" at the next gate |
| B5 | Bounce twice then stop | +10 s shown in results |
| B6 | Overrun the end, then stop | +20 s, stop counts |
| B7 | Old server | Race runs; status note "server doesn't verify stops" |
| B8 | Existing (non-bush) course | Hash unchanged |
