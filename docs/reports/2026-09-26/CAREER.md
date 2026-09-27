# FINSONLY Pilot Career and the Play home: report

Branch `campaign`, from origin/main `7d8e8a3`. This is a local Windows session, not the cloud
session the brief assumed: Node isn't on PATH here, so every JS run used the portable Node from
CLAUDE.md. Work was done in a sibling worktree (`geofs-1-campaign`), so the shared checkout was
never switched. No version bump (CHANGELOG "Unreleased"). `PROTO` is unchanged, since no relay
frame changed.

## Commits

| Commit | What |
|---|---|
| `e2b7b6f` | Serve rival medal times and reserve the rival callsigns (`GET /rivals`, `RACE_RIVALS_DIR`, Dockerfile/.dockerignore/redeploy.sh/compose) |
| `a688674` | Add REST pilot claim, token-credited runs and outbox dedupe (`POST /pilots/claim`, `pilot_token`/`client_run_id`/`input` on `/runs`, `/version` features) |
| `53b999d` | Let pilots who already hold a rival name keep it (grandfathering, your call) |
| `c97d59f` | Add the Career data: tiers, checkrides and rewards (`race/campaign/*.json`, validator, `RACE_CAMPAIGN_DIR`) |
| `16b553d` | Compute the Career on the server and serve it per pilot (`campaign_progress()`, events, `/campaign/*`) |
| `34274ea` | Save every finished run to an outbox and retry it until it posts |
| `9743698` | Add the client Career model: Continue, Quick race, unlock diff, model locks |
| `8482a57` | Make the Play home the front door, with Continue and Checkride 0 |
| `def36d9` | Add the Career screen, unlock reveal, coach, model locks and titles |
| `c5a5438` | Show the Career on the site: medal cabinet and rival par lines |
| (this commit) | Document the Career, the Play home and the outbox; this report |

Every commit went through `run.js`, `rivals.test.js`, `site_hq.test.js`, `test_server.py` and
ruff on race/server.

One slip, fixed before anything was pushed: C2 was first committed with two JS failures, because
a `| tail` hid node's exit code. I amended it after the fix. From then on a gate script checked
each suite's own exit code.

## CONFIG flags added (race.js)

All default on:

| Flag | What it does |
|---|---|
| `HOME: 'play'` | Boot on Play; `'ramp'` restores the Ramp-first boot |
| `RUN_OUTBOX` | Save each finish locally and retry until it posts |
| `CAREER` | The Career |
| `CAREER_MODEL_LOCK` | Lock joke models until earned |
| `CAREER_TITLES` | Titles next to callsigns |
| `COACH` | Checkride 0's coach prompts |

Server env:

- `RACE_RIVALS_DIR`
- `RACE_CAMPAIGN_DIR`
- `RACE_CLAIM_MIN_INTERVAL_S` (2 s)

## Protocol

**No relay frames were added or changed**, and `PROTO` stays 9. All the additions are REST, and
additive (PROTOCOL.md "Career REST"):

- `GET /version` gains `features`.
- New routes:
  - `POST /pilots/claim`
  - `GET /rivals`
  - `GET /campaign/meta`, `/campaign/{pilot_id}`, `/campaign/titles`, `/campaign/news`,
    `/campaign/course/{course_hash}`
- `POST /runs` takes optional `pilot_token`, `client_run_id` and `input`.
- `POST /landings` takes an optional `pilot_token`.

## Tests added

| Suite | Before | After | Covers |
|---|---|---|---|
| `test_server.py` | 355 | 401 (+46) | `/rivals` shape, reserved + grandfathered callsigns on every write path, the no-leakage sweep across every board/record/news/pilot/cup/ghost/mode/landing/career endpoint, REST claim, token-credited runs and landings, dedupe (incl. the unique index and no second career news on a retry), malformed fields never 422, the input field stored and never returned, migrations; the shipped Career data validates, and every kind of data mistake is caught; `campaign_progress` fixtures (ties, variants, missing rivals, checkride gating both ways, trophies incl. Oregon's two counted courses, the hidden tier, rewards), the event diff, the routes, cache replacement, 503 when off |
| `run.js` | 3282 checks | 3430 (+148) | outbox (ids, cap, trace-first eviction, the retry rule per server age, backoff, exactly-once after a lost answer, 4xx drops only that run), identity, the Career model (boot screen, Continue, Quick race, unlock diff, locked models, coach), Play (boot, first launch, Continue routing, Ramp tile, pad A/B, never mid-race), the Career screen, reveal (incl. reduced motion), titles, trail colour, the cup card's next step, the coach walking a real run |
| `site_hq.test.js` | 263 | 275 (+12) | the cabinet, par lines (a tie sits under the par line), holders |

I changed these existing tests on purpose:

- **Boot screen**: the panel now boots on Play, so the test that expected the Ramp was updated.
- **"Steve" fixtures**: tests that used "Steve" as a pilot now use "Stevie", since the name is
  reserved.
- **Two pad tests**: they now collapse the panel first. On Play, A means Continue, and a collapsed
  panel is the state a pilot is actually in while flying.
- **Pinned lists**: the deploy-file and print-call lists and the landing-body field count gained
  the new entries.

I also ran two checks by hand; neither is committed:

- **Client/server contract**: a live uvicorn fed the pure Career functions in race.js with real
  answers. That covered Checkride 0, Continue, the ladder, the unlock diff, the reveal lines, the
  model locks, Quick race, titles, the features list and dedupe, and all of them agreed.
- **Site in a browser**: Playwright loaded the pilot and course pages against the same server. The
  Career section and the par rows rendered with no page errors.

## In-sim checks (race/ACCEPTANCE.md "Career")

There are 14 rows. They include every tablet row the brief asked for:

- first launch → callsign → Checkride 0 → Career home
- a medal → the reveal
- airplane mode → the run posts exactly once
- a locked model
- a tier unlock
- the Ramp tile lighting up

They also cover reduced motion, the pad, titles in a room, an old server and the site.

## Decisions and deviations

- **Joke-model lock: grandfathered** (your answer). A model already selected, or assigned in
  `assignments.json`, stays free.
- **Rival callsigns: grandfathered** (your answer). `assignments.json` has a real "Steve". A
  `pilots` row for a rival name keeps it. Before deploying, run the query in RUNBOOK "Rival
  callsigns (Career)" to see who that is. The live server wasn't reachable from here, so I
  couldn't check.
- **Checkride pass rule**: every listed runway's best landing is at least `min_score`. The server
  can't see a client-side landing cup session, so it checks per-runway bests.
  - Minimums are 600 / 650 / 650 / 600 / 700.
  - TEST PILOT's checkride is White-Knuckle again at 700+, because there are only four landing
    cups for five tiers.
- **Star thresholds**: 22 stars for PRIVATE, COMMERCIAL and ATP, 29 for TEST PILOT, which is about
  90 % of silver across the tier before. They're absolute numbers in the JSON, and a test checks
  each one is reachable.
- **Tier cups**:

  | Tier | Cups |
  |---|---|
  | STUDENT | Aloha, Alpine, Canyon |
  | PRIVATE | Fjord, Pacific, Aviation History |
  | COMMERCIAL | KHABO, Japan, Wonders |
  | ATP | Alaska, China, Cascade, Pylon |
  | TEST PILOT | Legends, Badger, Oregon |

  Bush has no rivals and is left out. Oregon counts only hood-circuit and ecola-headland-run
  (umpqua has 2 rivals, willamette 3).
- **Career news** goes into `record_events` with a new `kind` column. Every record reader
  (`/records/history`, `records_taken`, `backfill_records.py`) now filters to `kind IS NULL`.
- **"Laid out with safePlace()"**: the Play screen lives inside the shell, which LayoutKeeper
  already clamps. The body-level Career card (the coach) is placed with `safePlace()` in touch
  mode. The reveal card uses the top-right stack.
- **Two medal systems on the site**: the pilot page's license card still shows the existing
  record-ratio medals (gold within 2 % of the record). The Career medals are a separate,
  labelled section. You may want to rename one.
- **Titles**: they appear on the relay tower and results. On the solo grid tower, titles show only
  on your own row: the other rows are rivals, which aren't pilots.

## Fixed along the way

- **pilot_id on new runs**: a new run's `pilot_id` was left NULL until the next server restart.
  It is now set at insert, and has a test.
- **Merged pilots' landings**: `_merge_pilot` didn't move `mode_runs` (landings) when a pilot
  adopted an unclaimed name. It does now, with a test.

## Not done / known

- **The in-sim rows**: they need you and the tablet.
- **Two failing addon tests**: `test_check_addons.py` has two tests that fail on this machine on
  untouched main too (the hotkey scan finds none on Windows). They aren't in the required suites,
  so I left them.
- **A flaky Ramp test**: `run.js`'s "not shown yet — inside the debounce window" (a 5 ms debounce
  checked synchronously) failed once under load and passed on reruns. It's an existing test; I
  didn't change it.
- **Landings aren't in the outbox**: the brief scoped the outbox to runs, so a checkride landing
  lost to the network is still lost.

## Deploy note

This needs a server redeploy: merge to main, then move the deploy branch. `redeploy.sh` now mounts
`race/rivals` (the server reads only `index.json`) and `race/campaign` read-only. Both are also
baked into the image. There's no Caddy change and no manual migration: `migrate()` adds the new
columns and index on start.

After the deploy, check:

- `GET /version` lists `features` with `campaign`.
- `docker logs` shows `rivals loaded: 65` and `career: on`.
