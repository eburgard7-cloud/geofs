# Cups

Groupings of `race/courses/*.json` for cup night (host picks a name and a race count in the lobby
card's **Start cup**). Docs only: the `cup`/`difficulty` values also live in
`race/courses/index.json` (the server's `load_courses()` reads them for the course chips), but nothing
reads this file. IDs are exactly what's in `index.json`.

## Core

### Oregon Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `ecola-headland-run` — Ecola Headland Run (tight) | tight | FAIL 34 m ¹ | Low along the Cannon Beach headlands and sea stacks. |
| `hood-circuit` — Mt. Hood Circuit (tight) | tight | PASS 1332 m ¹ | High ring around Mt. Hood's summit cone. |
| `umpqua-dunes-run` — Umpqua Dunes Run (tight) | tight | FAIL -52 m ¹ | Dune-skimming down the Oregon Dunes coast. |
| `willamette-gauntlet` — Willamette Bridge Gauntlet (tight) | tight | FAIL 16 m ¹ | Under-the-bridges run up the Willamette through Portland. |

### Cascade Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `gorge-run` — Columbia Gorge Run (easy) | easy | PASS 155 m ¹ | Columbia River Gorge, Portland side to The Dalles. |
| `crater-rim` — Crater Lake Rim (medium) | medium | PASS 153 m ¹ | Around the rim of Crater Lake. |
| `st-helens-crater` — St. Helens Crater (hard) | hard | PASS 170 m ¹ | Into the blast zone and over St. Helens' crater. |
| `three-sisters` — Three Sisters Slalom (hard) | hard | PASS 190 m ¹ | Slalom between North, Middle and South Sister (v2: altitudes refitted). |

### Badger Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `apostle-caves` — Apostle Islands Sea Caves (medium) | medium | PASS 190 m ¹ | Island hop past the Apostle Islands sea caves (v2). |
| `madison-isthmus` — Madison Isthmus (medium) | medium | PASS 190 m ¹ | Lakes Mendota and Monona across the Madison isthmus (v2). |
| `dells-narrows` — Dells Narrows (hard) | hard | PASS 190 m ¹ | Wisconsin River narrows through the Dells (v2: altitudes refitted). |
| `devils-lake-bluffs` — Devil's Lake Bluffs (hard) | hard | PASS 190 m ¹ | Tight turns under Devil's Lake's quartzite bluffs (v2). |

## World (2026-09-24, WS6–WS8)

### Alpine Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `lauterbrunnen-falls` — Lauterbrunnen Falls (easy) | easy | PASS 165 m | Interlaken up the Lütschine into the valley of 72 waterfalls. |
| `chamonix-midi` — Chamonix Aiguille du Midi (medium) | medium | PASS 165 m | Mer de Glace, Vallée Blanche and over the Col du Midi. |
| `zermatt-matterhorn` — Zermatt Matterhorn Run (medium) | medium | PASS 165 m | Up the Mattertal to Zermatt and the foot of the Hörnli ridge. |
| `tre-cime-loop` — Tre Cime di Lavaredo Loop (hard) | hard | PASS 165 m | Tight loop around the Three Peaks of Lavaredo. |

### Fjord Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `geiranger-sisters` — Geirangerfjord Seven Sisters (easy) | easy | PASS 165 m | Down the Geirangerfjord past the Seven Sisters. |
| `eidfjord-voringsfossen` — Eidfjord to Voringsfossen (medium) | medium | PASS 165 m | Eidfjorden into the Måbødalen gorge to Vøringsfossen. |
| `lysefjord-kjerag` — Lysefjord Preikestolen-Kjerag (medium) | medium | PASS 165 m | Under Preikestolen and the Kjerag wall to Lysebotn. |
| `reine-lofoten` — Lofoten Reine Fjord Thread (hard) | hard | PASS 165 m | Threading Reinefjorden and Kjerkfjorden in Lofoten. |

### Canyon Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `lake-powell-glen-canyon` — Lake Powell & Glen Canyon (easy) | easy | PASS 190 m ¹ | Glen Canyon Dam and up Lake Powell's main channel. |
| `monument-valley` — Monument Valley (medium) | medium | PASS 190 m ¹ | Figure-eight between the Mittens and Merrick Butte. |
| `zion-canyon` — Zion Canyon (medium) | medium | PASS 190 m ¹ | Up Zion Canyon past the Great White Throne and Angels Landing. |
| `grand-canyon-inner-gorge` — Grand Canyon Inner Gorge (hard) | hard | PASS 190 m ¹ | Below the rims in the Colorado's Granite Gorge. |

### KHABO Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `todos-santos-coast` — Todos Santos Coast (easy) | easy | PASS 165 m | Pacific surf line past Todos Santos and Cerritos. |
| `cabo-lands-end` — Cabo Land's End (medium) | medium | PASS 165 m | Around El Arco and up the Corridor (v2: placeholder altitude fixed). |
| `la-paz-espiritu-santo` — La Paz & Espiritu Santo (medium) | medium | PASS 165 m ¹ | Balandra and the coves of Isla Espíritu Santo. |
| `copper-canyon-urique` — Copper Canyon Urique Gorge (hard) | hard | PASS 165 m ¹ | Deep in the Urique gorge of the Barrancas del Cobre. |

### Pacific Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `milford-sound` — Milford Sound (easy) | easy | PASS 165 m | In from the Tasman Sea under Mitre Peak, up the Arthur valley. |
| `fuji-five-lakes` — Fuji Five Lakes (medium) | medium | PASS 165 m | Motosuko to Yamanakako along Fuji's northern lakes. |
| `ha-long-karsts` — Ha Long Bay Karsts (medium) | medium | PASS 165 m | Among Ha Long Bay's larger karst islands. |
| `na-pali-coast` — Na Pali Coast (hard) | hard | PASS 165 m | Na Pali sea cliffs, into Kalalau and down Waimea Canyon. |

### Legends Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `glen-coe` — Glen Coe (easy) | easy | PASS 165 m | Rannoch Moor down the Pass of Glencoe to Ballachulish. |
| `kai-tak-checkerboard` — Kai Tak Checkerboard (medium) | medium | PASS 165 m | The IGS 13 approach and checkerboard turn (no buildings in terrain!). |
| `mach-loop` — Mach Loop (medium) | medium | PASS 165 m | The LFA7 Mach Loop around Cadair Idris. |
| `star-wars-canyon` — Star Wars Canyon (hard) | hard | PASS 190 m ¹ | Rainbow Canyon, Death Valley's jet-training slot (v2). |

## Expansion (2026-09-24, WS11–WS15)

### Alaska Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `knik-glacier` — Knik Glacier (easy) | easy | PASS 165 m | Chase the braided Knik River up a wide glacial valley to the ice face and Lake George. A gentle Alaskan warm-up. |
| `denali-ruth-gorge` — Denali Ruth Gorge (medium) | medium | PASS 165 m | Fly the Great Gorge of the Ruth Glacier between mile-high granite walls into the Don Sheldon Amphitheater under Denali. |
| `kenai-fjords-exit-glacier` — Kenai Fjords & Exit Glacier (medium) | medium | PASS 165 m | Sweep up Resurrection Bay past Seward, then follow the river valley to Exit Glacier spilling off the Harding Icefield. |
| `valdez-keystone-canyon` — Valdez Keystone Canyon (hard) | hard | PASS 165 m | Port Valdez, the Lowe River, then 42 m gates through the waterfall-lined slot of Keystone Canyon toward Thompson Pass. |

### Aloha Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `diamond-head-waikiki` — Diamond Head & Waikiki (easy) | easy | PASS 165 m | Cruise Oahu's south shore from Waikiki over Diamond Head crater to Hanauma Bay and Makapuu Point. |
| `haleakala-crater` — Haleakala Crater Gaps (medium) | medium | PASS 165 m | Climb Kaupo Gap from the sea, cross Haleakala's summit crater among the cinder cones, and dive out Ko'olau Gap to Ke'anae. |
| `molokai-sea-cliffs` — Molokai Sea Cliffs (medium) | medium | PASS 165 m | Skim the base of the world's tallest sea cliffs from Kalaupapa past Pelekunu and Wailau to Halawa Bay. |
| `waimea-canyon-gorge` — Waimea Canyon Gorge (hard) | hard | PASS 165 m | Up the floor of the "Grand Canyon of the Pacific" from Waimea town, over the ridge, and back down its eastern branch. |

## Not in a cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `starter-sprint-seatac` — Starter Sprint (Sea-Tac test course) | easy | FAIL -1 m ¹ | Ground-start test course at Sea-Tac. |

## Terrain status

`python race/tools/check_terrain.py --all --source auto` (250 m step, 150 m margin unless noted), run 2026-09-24.
Source for this run: `auto(global) [USGS unreachable: CONUS fell back to global]`. "PASS 165 m" = worst clearance along the whole route.

¹ Inside CONUS. `--source auto` would use USGS 3DEP there, but USGS was unreachable from the machine
that ran this, so these were checked on AWS Terrarium tiles (~30 m) instead. Courses designed with
`race/tools/design_course.py` inside CONUS carry an extra 40 m pad for that reason; re-run where USGS
is reachable before trusting a narrow canyon.

- The three Oregon Cup "tight" courses (`ecola-headland-run`, `umpqua-dunes-run`, `willamette-gauntlet`) are
  deliberately flown below 150 m and FAIL the default margin by design; `starter-sprint-seatac` is the ground-start
  test course and dips 1.5 m under the Terrarium surface on one leg. None of the four is in the checked cups' scope.
- The six Badger/Cascade/Legends courses that were hand-placed and failing (`dells-narrows`, `madison-isthmus`,
  `apostle-caves`, `devils-lake-bluffs`, `three-sisters`, `star-wars-canyon`) were repaired on 2026-09-24 as version 2:
  same gate lat/lons and radii, altitudes refitted by `design_course.py` (pad 40 m). New hashes → fresh boards.
- Terrain has no buildings or structures: Kai Tak's Kowloon, bridges and towers are not in the data.
- None of the courses above has been flown in GeoFS yet except the Oregon/Cascade ones.
