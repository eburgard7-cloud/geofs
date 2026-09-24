# Cups

Groupings of `race/courses/*.json` for cup night (host picks a name and a race count in the
lobby card's **Start cup** — see the root README/`race/README.md` "Results and cups"). This file
is docs only: it adds no schema field and isn't read by `race.js`, `add_course.py`, or the
server. IDs below are exactly what's in `race/courses/index.json` as of this writing; re-check
there before flying a cup, since a course's `id` is the only thing that has to match.

| Cup | Courses |
|---|---|
| Oregon Cup | `hood-circuit`, `ecola-headland-run`, `umpqua-dunes-run`, `willamette-gauntlet` |
| Cascade Cup | `gorge-run`, `crater-rim`, `three-sisters`, `st-helens-crater` |
| Badger Cup | `dells-narrows`, `madison-isthmus`, `apostle-caves`, `devils-lake-bluffs` |
| Alpine Cup | `lauterbrunnen-falls` (easy), `zermatt-matterhorn` (medium), `chamonix-midi` (medium), `tre-cime-loop` (hard) |
| Fjord Cup | `geiranger-sisters` (easy), `lysefjord-kjerag` (medium), `eidfjord-voringsfossen` (medium), `reine-lofoten` (hard) |
| Alpine Cup | `lauterbrunnen-falls` (easy), `zermatt-matterhorn` (medium), `chamonix-midi` (medium), `tre-cime-loop` (hard) |
| Fjord Cup | `geiranger-sisters` (easy), `lysefjord-kjerag` (medium), `eidfjord-voringsfossen` (medium), `reine-lofoten` (hard) |
| Legends Cup (in progress) | `star-wars-canyon` |
| KHABO Cup (in progress) | `cabo-lands-end` |

Terrain status (`race/tools/check_terrain.py`, USGS 3DEP, 250 m step, 150 m margin) as of
2026-09-22 — see the courses README section and the session report for the full table:

- **Flyable as authored:** `hood-circuit`, `gorge-run`, `crater-rim` (the latter two repaired to
  version 2 this session), `st-helens-crater`.
- **Not yet flyable / hand-placed from landmark coordinates, not flown:** `dells-narrows`,
  `madison-isthmus`, `apostle-caves`, `devils-lake-bluffs`, `three-sisters`, `star-wars-canyon`,
  `cabo-lands-end` — each has real terrain findings (see the report); none of the Badger, Legends
  or KHABO courses are ready for cup night yet without either re-flying the route or another
  repair pass. `cabo-lands-end` additionally has one placeholder gate altitude (gate 2, Pedregal
  ridge) pending a real elevation check.

The Legends and KHABO cups are single-course "in progress" because that's all `star-wars-canyon`
/ `cabo-lands-end` back — expand them if more courses in the same theme get added later.
