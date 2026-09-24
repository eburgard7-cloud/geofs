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

### Japan Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `tokyo-bay-rainbow` — Tokyo Bay to Rainbow Bridge (easy) | easy | PASS 165 m | A long, gentle run up Tokyo Bay from the Uraga Strait, past Haneda's approach, to Odaiba and Rainbow Bridge. |
| `sakurajima-circuit` — Sakurajima Volcano Circuit (medium) | medium | PASS 165 m | A lap of Kagoshima Bay's smoking volcano, with a pop-up over Sakurajima's summit saddle. |
| `shimanami-straits` — Shimanami Kaido Straits (medium) | medium | PASS 165 m | Island-hopping down the Shimanami Kaidō straits, under the bridges from Innoshima to Kurushima. |
| `kurobe-gorge` — Kurobe Gorge (hard) | hard | PASS 165 m | Japan's deepest V-gorge: chase the Kurobe River upstream from Unazuki to Kurobe Dam, with tight walls and small gates. |

### China Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `qutang-gorge` — Three Gorges: Qutang to Wushan (easy) | easy | PASS 165 m | The Yangtze through Qutang Gorge's Kuimen gate and on to Wushan. |
| `great-wall-ridge` — Great Wall Ridge to Mutianyu (medium) | medium | PASS 165 m | Fly the crest where the Great Wall climbs from Huanghuacheng over Jiankou to Mutianyu. |
| `li-river-karsts` — Li River Karsts, Guilin-Yangshuo (medium) | medium | PASS 165 m | The Li River's karst towers, bend after bend, from Yangdi through Xingping toward Yangshuo. |
| `zhangjiajie-pillars` — Zhangjiajie Pillars (hard) | hard | PASS 165 m | Golden Whip Stream and Ten-Mile Gallery among Wulingyuan's sandstone pillars, then over the Tianzi rim. |

### Wonders Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `angkor-tonle-sap` — Angkor Wat & Tonle Sap (easy) | easy | PASS 165 m | Low and easy over the Khmer temples: Tonlé Sap, Angkor Wat, the Bayon and the West Baray reservoir. *History:* Angkor Wat was built in the early 12th century under Suryavarman II and is the largest religious monument in the world. The West Baray is a huge Khmer reservoir about 8 km long. |
| `giza-pyramids` — Giza & Saqqara Pyramids (medium) | medium | PASS 165 m | Circle the Giza pyramids and Sphinx, then chase the desert edge south to Saqqara and Dahshur. *History:* The Great Pyramid of Khufu (about 2560 BC) is the oldest of the Seven Wonders of the Ancient World and the only one still standing. Djoser's Step Pyramid at Saqqara is older still, and Sneferu's Bent and Red Pyramids at Dahshur mark the move to true smooth-sided pyramids. |
| `petra-wadi-musa` — Petra & Wadi Musa (medium) | medium | PASS 165 m | Over the Siq to the Treasury and Monastery, then drop through Wadi Siyyagh to the Wadi Araba rift edge. *History:* Petra was the Nabataean capital, reached through the narrow Siq gorge. Its rock-cut Treasury (Al-Khazneh) and Monastery (Ad Deir) date to around the 1st century AD. |
| `machu-picchu-urubamba` — Machu Picchu & Urubamba Gorge (hard) | hard | PASS 165 m | Thread the Urubamba gorge to Aguas Calientes and whip around Huayna Picchu below the citadel. *History:* Machu Picchu is a 15th-century Inca estate, usually linked to Pachacuti, on a ridge above the Urubamba River. It became internationally known after Hiram Bingham's 1911 visit. |

### Aviation History Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `kitty-hawk-kill-devil` — Kitty Hawk & Kill Devil Hills (easy) | easy | PASS 190 m ¹ | A gentle beach cruise over the dunes where powered flight began. *History:* On 17 December 1903 Orville and Wilbur Wright made the first controlled, sustained powered airplane flights at Kill Devil Hills near Kitty Hawk. The longest that day was 852 ft (Wilbur). |
| `edwards-rogers-mach1` — Edwards & Rogers Dry Lake (medium) | medium | PASS 190 m ¹ | Flat-out straights across the Mojave and the Rogers Dry Lake bed. *History:* On 14 October 1947 Chuck Yeager flew the Bell X-1 "Glamorous Glennis" past Mach 1 over the Mojave, flying from Muroc Army Air Field, now Edwards AFB. The Rogers Dry Lake bed has served as a natural runway ever since. |
| `oshkosh-fisk-arrival` — Oshkosh Fisk Arrival (medium) | medium | PASS 190 m ¹ | Fly the famous AirVenture Fisk arrival from Ripon along the tracks to Wittman field and out over Lake Winnebago. *History:* EAA AirVenture at Wittman Regional, Oshkosh, is the world's largest fly-in, held every July. Arrivals fly the published Fisk VFR arrival from Ripon along the railroad tracks, and Wittman becomes the busiest control tower in the world for that week. |
| `paris-le-bourget-1927` — Paris Seine to Le Bourget (hard) | hard | PASS 165 m | Lindbergh's arrival: down the Seine past the Eiffel Tower and Notre-Dame, then north to Le Bourget. *History:* On 20–21 May 1927 Charles Lindbergh flew the Spirit of St. Louis solo and nonstop from New York to Paris in about 33.5 hours. He landed at Le Bourget at night in front of a huge crowd. |

### Pylon Cup

| Course | Difficulty | Terrain | Theme |
|---|---|---|---|
| `lake-hood-floatplane-circuit` — Lake Hood Floatplane Circuit (2 laps, easy) | easy | PASS 73 m (margin 30 m) | Gentle oval around Lake Hood, the world's busiest seaplane base (2 laps × 10 gates, ~84 s/lap at 120 kt). |
| `chiba-makuhari-slalom` — Chiba Makuhari Slalom (3 laps, medium) | medium | PASS 60 m (margin 30 m) | Red Bull-style slalom over Tokyo Bay off Makuhari beach (3 laps × 8 gates, ~65 s/lap at 200 kt). *History:* Chiba's Makuhari seaside hosted Red Bull Air Race rounds from 2015 to 2019. |
| `reno-stead-unlimited` — Reno Stead Unlimited (3 laps, medium) | medium | PASS 67 m (margin 30 m) ¹ | Unlimited-class pylon laps at Reno-Stead (3 laps × 8 gates, ~87 s/lap at 250 kt). *History:* The National Championship Air Races ran at Reno-Stead from 1966 to 2023; Unlimited-class warbirds raced a pylon course of roughly 8 miles. |
| `budapest-danube-chain-bridge` — Budapest Danube Chain Bridge (3 laps, hard) | hard | PASS 45 m (margin 30 m) | Danube hairpins between Margaret and Liberty Bridges past Parliament and the Chain Bridge (3 laps × 10 gates, ~74 s/lap). Bridges/buildings are NOT in terrain. *History:* Budapest hosted Red Bull Air Race rounds over the Danube, where pilots flew under the Chain Bridge. |

Circuits are stored **unrolled** (race.js has no laps yet — see `race/docs/LAPS.md`): the course's gates are one
lap repeated N times plus the lap's first gate again to close the last lap. `laps`/`lap_gates` are NOT in the
files: `Course.normalize()` (race.js) and `add_course.py` both whitelist fields and would drop them, so they're
recorded here instead. Checked with `--margin 30` (pylons fly 45–80 m AGL by design).

| Course | Laps N | Lap gates K | Gates (N×K+1) | Lap length | Lap time (est.) |
|---|---|---|---|---|---|
| `lake-hood-floatplane-circuit` | 2 | 10 | 21 | 5.2 km | ~84 s @ 120 kt |
| `reno-stead-unlimited` | 3 | 8 | 25 | 11.2 km | ~87 s @ 250 kt |
| `chiba-makuhari-slalom` | 3 | 8 | 25 | 6.7 km | ~65 s @ 200 kt |
| `budapest-danube-chain-bridge` | 3 | 10 | 31 | 7.6 km | ~74 s @ 200 kt |

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
