# Liveries and the Garage (server 1.9.0)

Server side of FINSONLY liveries: everyone running FINSONLY Racing sees everyone's paint, instead
of LiverySelector's "only the person who picked it". This file is the endpoint reference; the
relay frames are in [`race/PROTOCOL.md`](../PROTOCOL.md) ("Proto 12: liveries"). Code:
`app.py` (routes, render worker, relay glue) and `garage.py` (rules and SQLite rows).

## Data

| What | Where | Notes |
|---|---|---|
| Catalog, textures, kits, templates, UV maps | `RACE_LIVERIES_DIR` (image: `/app/livery/liveries`) | the repo's `liveries/`, baked in and mounted over read-only |
| Livery tools | `RACE_LIVERY_TOOLS` (image: `/app/livery/tools`) | the repo's `tools/`; must be the sibling of `RACE_LIVERIES_DIR` (the tools find `liveries/` from their own location) |
| Root classic textures, Rafale stock maps | `/app/livery/*.png|*.webp`, `/app/livery/rafale/` | baked only; change with a rebuild |
| Pilots' textures, blueprints | `RACE_LIVERY_DATA_DIR`, default `liveries/` next to `RACE_DB` | `/app/data/liveries` in redeploy.sh's layout: survives redeploys |
| Equips, customs, link codes, garage tokens, render cache | `race.db` | tables in `garage.SCHEMA` (additive) |

`RACE_LIVERIES=0` turns the whole layer off: every route below answers 503, the relay sends no
livery data and refuses `livery` frames. A missing catalog or tools directory does the same, with
one line in the startup log (`liveries: OFF ...`). `/health` reports `liveries: <catalog size>`.

## Endpoints

No auth unless stated. Every `/liveries/*` response carries `Access-Control-Allow-Origin: *`
(GeoFS loads them as WebGL textures from geo-fs.com). URLs in responses are root-relative
(`/liveries/files/...`): prefix the API base.

| Method | Path | Auth | Answer |
|---|---|---|---|
| GET | `/liveries/catalog` | - | `catalog.json` + per entry `urls` (in `files` order; Rafale `[main, spec]`; `null` if a file is missing) and `blueprint_url`. ETag, `max-age=300` |
| GET | `/liveries/files/<sha256>.<png\|webp\|jpg>` | - | a catalog or custom texture, content-addressed, `Cache-Control: immutable`. Rejected customs: 404 |
| GET | `/liveries/templates` | - | pilot templates' form schema (`tools/livery_templates.py schema()`) |
| GET | `/liveries/kit/<file>` | - | paint kits (`liveries/kit/`) |
| GET | `/liveries/blueprint/<sha256>.png` | - | left, right, top views of a served main texture, rendered on first request and cached. 404 for the Rafale |
| POST | `/garage/link` | `{pilot_token}` | `{code, expires_in: 300, expires_at}`: 6 chars, single use |
| POST | `/garage/link/redeem` | `{code}` | `{garage_token, pilot_id, callsign, expires_at}` (30 days). 10 tries/min/IP |
| POST | `/garage/link/revoke` | `{token}` | garage token: revokes itself; pilot_token: revokes all of that pilot's garage tokens |
| GET | `/garage/{pilot_id}` | optional `Authorization: Bearer <token>` | per aircraft `{equipped, equipped_urls, liveries: [...]}`; with the owner's own token also pending/rejected customs and `limits` |
| PUT / POST | `/garage/equip` | `{token, aircraft, livery_id\|null}` | `{aircraft, equipped, urls}`; pushes the change to the pilot's live relay rooms |
| POST | `/garage/recolor` | `{token, template, params, name?}` | a job (`_job_public`); instant `done` when the same (template, params) was ever rendered |
| GET | `/garage/jobs/{job_id}` | - | `{status: queued\|running\|done\|failed, position, livery_id, urls, blueprint_url, error}` |
| POST | `/garage/upload` | multipart `token, aircraft, file, name?` | `{livery_id, status: "pending", urls, blueprint_url}`; owner can equip at once |
| POST | `/garage/customs/{id}/delete` | `{token}` | own customs only; unequips it |
| GET | `/admin/liveries/pending` | admin bearer | pending uploads (and recolors when approval is on) |
| POST | `/admin/liveries/{id}/approve` | admin bearer | `{id, status: "approved"}` |
| POST | `/admin/liveries/{id}/reject` | admin bearer, `{reason}` | `{id, status: "rejected", unequipped: n}`; unequips everyone, deletes the file |

`token` is a `pilot_token` or a `garage_token`. Admin is `Authorization: Bearer <RACE_ADMIN_TOKEN>`
(same as house ghosts; unset = 503).

### Livery list entries (`GET /garage/{pilot_id}`)

`{id, name, category, kind, state, unlock_text, reason, urls, blueprint_url}` and, for customs,
`template, params, created_at`. `state`: `owned`, `locked` (with `unlock_text`, plain words:
"Gold or better on every Aloha Cup course", "Unlocks with seasons", "Win 5 Gun Games"),
`pending`, `rejected` (with `reason`). `kind`: `catalog`, `recolor`, `upload`. Gun Game paints
and unlisted entries are not listed: the mode applies them.

### Equip rules

Refused: an unknown aircraft or livery (400/404), a livery for another aircraft (400), a Gun Game
paint (400), a locked one (403, `Locked: <unlock text>`), another pilot's custom (403), a
rejected custom (409). A pilot's own pending upload is allowed; nobody else sees it until it is
approved (they see stock).

### Unlocks

`livery_unlocked(requires, ctx)` in `app.py`, one pure function for every kind in
`tools/livery_catalog.py`: `null` always; the Career kinds (medal+count, stars, tier, checkride,
trophies, cup+medal, hidden_tier) through the Career's own `requirement_met()` against the
pilot's `/campaign/{pilot_id}` snapshot; `mode` never; `season+place` through the
`SEASON_STANDINGS` hook (None today: locked, "Unlocks with seasons"); `gungame_wins` through the
`GUNGAME_WINS` hook (0 until Gun Game records wins).

## Limits (env)

| Env | Default | |
|---|---|---|
| `RACE_GARAGE_JOBS_PER_PILOT` | 1 | queued or running recolors per pilot |
| `RACE_GARAGE_RENDERS_PER_DAY` | 20 | recolor renders per pilot per day (UTC-7 day; cache hits are free) |
| `RACE_GARAGE_UPLOADS_PER_DAY` | 10 | uploads per pilot per day |
| `RACE_GARAGE_MAX_CUSTOMS` | 30 | stored (non-rejected) customs per pilot |
| `RACE_GARAGE_RENDER_TIMEOUT_S` | 180 | a render process is killed after this |
| `RACE_GARAGE_RECOLOR_NEEDS_APPROVAL` | 0 | 1: recolors wait in the admin queue like uploads |
| `RACE_GARAGE_REDEEM_PER_MIN` | 10 | link-code redeem attempts per IP per minute |
| `RACE_LIVERY_MIN_INTERVAL_S` | 2 | relay `livery` frames per pilot |

## Render worker

`POST /garage/recolor` queues a job; one consumer runs one job at a time, each in its own
process (`livery_worker.py`, `os.nice(10)`), so the event loop never blocks. Measured on a dev
box: F-16 45 s, Cub 7 s, Paraglider 3 s. Output is content-addressed and written atomically.
