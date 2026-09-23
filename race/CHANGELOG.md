# Changelog

One line per shipped item. Details live in README.md, PROTOCOL.md and server/DEPLOY_CHECKLIST.md;
what still needs the live sim is in ACCEPTANCE.md.

## 1.4.0

- **CI** — `.github/workflows/test.yml` runs the JS suite, the server pytest suite and ruff on
  every PR and on pushes to main (#5).
- **Mode registry, proto 6** — `MODES` (race asc, landing desc), `mode_runs` table,
  `GET /modes`, `POST /modes/{mode}/runs`, `GET /modes/{mode}/leaderboard`, `join.mode` /
  `joined.mode`; `migrate_modes.py` backfills `runs` additively and idempotently (#1).
- **Touchdown detector** — `race/touchdown.js`, a pure-function liftoff/touchdown/bounce/
  go_around/settled state machine; owns the sample and touchdown-event schema (#2). The
  touchdown event now also carries `lat`, `lon` and `heading_deg`.
- **probe.js "touchdown inputs"** — reports the GeoFS reads for AGL, vertical speed, ground
  contact and IAS (#4).
- **Server-side landing scoring** — `POST /landings` scores touchdown.js's raw event against
  `RUNWAYS` (three seed runways) and stores it as a `landing` mode run; client scores and client
  offsets are ignored; `GET /landing-leaderboard` (#3).
- **Touchdown recorder + replay** — `tools/recorder.js` bookmarklet and
  `tools/replay_landing.mjs` CLI (now also works on Windows paths) (#6).
- **redeploy.sh** — one-command Unraid redeploy: pull, SQLite backup, migrate, build, swap,
  poll; `--dry-run` (#8).
- **Audit** — `docs/AUDIT.md`, a dead-code and superseded-UI report; nothing in it is applied (#7).
