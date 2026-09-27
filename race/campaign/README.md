# Career data

The FINSONLY Pilot Career's data. It is **data only**: [app.py](../server/app.py) validates it
at startup (`validate_campaign()`) and computes each pilot's progress (`campaign_progress()`).
race.js reads it only through `GET /campaign/meta`. See race/README.md "Play home and Career".

- `campaign.json`:
  - `tiers`, in order. Each has catalog `cups` (the `cup` names in race/courses/index.json),
    an `unlock.stars` (stars earned in the previous tier, which also needs its checkride passed),
    and a `checkride` (runway ids and a `min_score` every runway's best landing must reach).
  - `checkride0`: the first-launch race.
  - `hidden_tier`: every DAWG trophy.
- `rewards.json`: models, trails, titles and liveries, each with one `requires` (see its
  `_comment`).

**Editing.** Change the JSON and run `python -m pytest race/test/test_server.py -k campaign -q`.
The validator catches:

- an unknown cup or runway
- a cup in two tiers
- a threshold above what the previous tier can earn
- a joke model with no unlock
- a bad requirement

A server whose data fails validation turns the Career off and keeps running. Thresholds are
absolute star counts; regenerating the rivals can change how many courses count (only courses
with all four rivals do), so re-run the tests after a rival regeneration.
