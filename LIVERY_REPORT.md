# FINSONLY Livery Pack 1: report

Branch `livery-pack-1`, 2026-09-26. Everything here is **UNVERIFIED IN-SIM** until Eric runs the
checklist at the bottom. The maps come from the real GeoFS model files and agree with where the
shipped liveries put paint, but nothing has been looked at inside GeoFS yet.

Scope held: repo root only. No file in `race/` was changed, every existing texture is untouched,
and every existing `airline.json` entry is byte-identical (only insertions; a test strips the
inserted entries and checks the rest against the pre-pack file's sha256). No version bumps.

## The liveries

| # | Aircraft | Name in LiverySelector | Spec | Output | Size |
|---|---|---|---|---|---|
| 1 | F-16 | FINSONLY - Rival: STEVE (Team Goldfish) | `liveries/specs/f16_rival_steve.json` | `liveries/out/f16_rival_steve.webp` | 0.36 MB |
| 2 | F-16 | FINSONLY - Rival: BRAT (Team Brathaus) | `liveries/specs/f16_rival_brat.json` | `liveries/out/f16_rival_brat.webp` | 0.34 MB |
| 3 | F-16 | FINSONLY - Rival: MOO (Team Holstein) | `liveries/specs/f16_rival_moo.json` | `liveries/out/f16_rival_moo.webp` | 0.30 MB |
| 4 | F-16 | FINSONLY - Rival: DAWG (Top Dawg) | `liveries/specs/f16_rival_dawg.json` | `liveries/out/f16_rival_dawg.webp` | 0.23 MB |
| 5 | F-16 | FINSONLY - Medal: Bronze | `liveries/specs/f16_medal_bronze.json` | `liveries/out/f16_medal_bronze.webp` | 0.35 MB |
| 6 | F-16 | FINSONLY - Medal: Silver | `liveries/specs/f16_medal_silver.json` | `liveries/out/f16_medal_silver.webp` | 0.31 MB |
| 7 | F-16 | FINSONLY - Medal: Gold | `liveries/specs/f16_medal_gold.json` | `liveries/out/f16_medal_gold.webp` | 0.36 MB |
| 8 | F-16 | FINSONLY - Medal: DAWG Chrome | `liveries/specs/f16_medal_dawg_chrome.json` | `liveries/out/f16_medal_dawg_chrome.webp` | 0.31 MB |
| 9 | F-16 | FINSONLY - Oregon Cup | `liveries/specs/f16_cup_oregon.json` | `liveries/out/f16_cup_oregon.webp` | 0.27 MB |
| 10 | F-16 | FINSONLY - Badger Cup | `liveries/specs/f16_cup_badger.json` | `liveries/out/f16_cup_badger.webp` | 0.29 MB |
| 11 | F-16 | FINSONLY - KHABO Cup | `liveries/specs/f16_cup_khabo.json` | `liveries/out/f16_cup_khabo.webp` | 0.31 MB |
| 12 | F-16 | FINSONLY - Fjord Cup | `liveries/specs/f16_cup_fjord.json` | `liveries/out/f16_cup_fjord.webp` | 0.35 MB |
| 13 | 757-200 | FINSONLY Racing - Team Transport | `liveries/specs/b757_team_transport.json` | `liveries/out/b757_team_transport.png` | 0.12 MB |
| 14 | 757-200 | KHABO 2027 Race Week | `liveries/specs/b757_khabo2027_raceweek.json` | `liveries/out/b757_khabo2027_raceweek.png` | 0.12 MB |
| 15 | 757-200 | DAWG Charter | `liveries/specs/b757_dawg_charter.json` | `liveries/out/b757_dawg_charter.png` | 0.07 MB |
| 16 | 757-200 | FINSONLY Night Freight | `liveries/specs/b757_night_freight.json` | `liveries/out/b757_night_freight.png` | 0.06 MB |
| 17 | Rafale M | FINSONLY - Gold Chrome | `liveries/specs/rafale_gold_chrome.json` | `liveries/out/rafale_gold_chrome_main.webp` + `_spec.webp` | 0.65 MB + 4 KB |
| 18 | Rafale M | FINSONLY - DAWG Black Chrome | `liveries/specs/rafale_dawg_black_chrome.json` | `liveries/out/rafale_dawg_black_chrome_main.webp` + `_spec.webp` | 0.21 MB + 4 KB |

Plus two test entries, **UV REGION ID (test)**, on the F-16 (`liveries/test/f16_region_id.webp`)
and the 757 (`liveries/test/b757_region_id.png`).

Tail numbers: rivals N4101F to N4404F, medals N4510F to N4513F, cups N4620F to N4623F, 757s
N4700F to N4703F. All fictional. All art is original: decals are drawn from primitives by
`tools/make_decals.py`, and text uses the bundled OFL fonts Anton and Bungee. There are no airline
liveries, military markings, national insignia, brands or characters. The medal decal is a fish
on an orange/teal ribbon, not a star. The Rafale's stock roundels, unit badge, serial and
"ARMEE DE L'AIR" lettering are scrubbed before tinting (checked at 6x contrast), and the F-16
panel-line layer has the stock stars, serials and tail code removed.

See everything at once in [`liveries/out/CONTACT_SHEET.png`](liveries/out/CONTACT_SHEET.png).

## How the region maps were made (and why they're mostly "high")

There was no UV map, so I didn't guess one from the UVCAL sheets. GeoFS serves the models it
renders (`/models/aircraft/premium/f16/f16.gltf` and the 757's
`/backend/aircraft/repository/GXD04N_126645_238/*.glb`). `tools/uv_regions.py` fetches them into a
gitignored cache and rasterizes every triangle that uses the livery texture into UV space. Each
triangle is labelled from its part name, 3D position and facing. A visibility pass marks F-16
faces that can't be seen from outside (cockpit tub and panels, intake duct, bays) as `interior`.
UV orientation was verified on the pilot/helmet island (row = v * height).

Cross-check against Eric's shipped liveries: the share of each region's texels those liveries
repainted is ~100% for wings, fin, rudder, radome and fuselage top, and 0.7% for `mechanical`. The
map agrees with where paint really lands.

What the real mesh showed that the UVCAL guesses had wrong:

- **F-16:** the left planform in the texture is the wing *undersides*, and left and right share
  one mirrored island. The fin's two sides share one island, which is why the stock "313TFS" reads
  backwards in the texture. The strip UVCAL4 called SIDE_L is `fuselage_side_both`/`intake`. Most
  of the fuselage sides unwrap into the top and bottom halves. `wing_top_l` is stored upside-down
  relative to `wing_top_r`.
- **757:** the old "N1/N2" box is **winglets** (left half) and **engines + reversers** (right
  half). The upper band is the left (port) side; the lower band is the right side, mirrored,
  which matches Eric's flipped right-side text. Almost everything below y ~530 is unused, apart
  from thin wing, pylon and h-stab strips.

### F-16 regions

| id | region | confidence | paint | repainted by shipped liveries | where |
|---|---|---|---|---|---|
| 1 | `fuselage_top` | high | yes | 99.2% | upper fuselage and strakes, nose to tail |
| 2 | `fuselage_bottom` | high | yes | 82.3% | belly aft of the intake |
| 3 | `fuselage_side_l` | medium | yes | 98.1% | left side only (facing cut, see below) |
| 4 | `fuselage_side_r` | medium | yes | 41.7% | right side only (facing cut) |
| 5 | `fuselage_side_both` | medium | yes | 97.5% | side texels shared by both sides (mirrored) |
| 6 | `radome` | high | yes | 100% | nose cone; aft edge is a geometric cut 1.9 m from the tip |
| 7 | `canopy_frame` | high | yes | 43.5% | canopy frame and sill (glass is untextured) |
| 8 | `intake` | medium | yes | 72.6% | chin intake; the intake/belly boundary is a geometric cut |
| 9 | `nozzle` | high | yes | 55.3% | nozzle petals and tail pipe |
| 10 | `ventral_fins` | medium | yes | 100% | ventral fins (geometric cut, both share) |
| 11 | `fin` | high | yes | 92.2% | vertical fin, **both sides one island** |
| 12 | `rudder` | high | yes | 100% | rudder, both sides share |
| 13 | `wing_top_l` | high | yes | 100% | left wing top |
| 14 | `wing_top_r` | high | yes | 100% | right wing top |
| 15 | `wing_bottom` | high | yes | 100% | both wing undersides, **one island** |
| 16 | `wing_leading_edges` | high | yes | 97.6% | LE flaps + fixed LE, both wings share |
| 17 | `flaperons` | high | yes | 100% | flaperons, partly shared |
| 18 | `hstab_top_r` | high | yes | 98.7% | right h-stab top |
| 19 | `hstab_shared` | high | yes | 83.5% | left h-stab top + both undersides |
| 20 | `speedbrakes` | high | yes | 51.6% | speed brakes |
| 21 | `gear_doors` | high | yes | 27.0% | gear doors |
| 22 | `wingtip_rails` | high | yes | 100% | wingtip rails |
| 23 | `pilot` | high | no | 26.6% | pilot (Eric repainted the face on two liveries) |
| 24 | `mechanical` | high | no | 0.7% | gear, wheels, bays, hook |
| 25 | `interior` | high | no | 11.9% | faces not visible from outside |

"Medium" means the region's *boundary* is a threshold I chose (a facing angle or a length/height
cut), not a part in the model. None of the regions is a pure guess.

### 757 regions

All high: each comes from a named part or a clean cut in the model.

| id | region | confidence | where |
|---|---|---|---|
| 1 | `fuselage_l` | high | left side, upper band, nose at left, text reads normally |
| 2 | `fuselage_r` | high | right side, lower band, **mirrored**: text must be flipped (the factory does it) |
| 3 | `nose_cone` | high | nose cone (cut 1.9 m from the tip) |
| 4 | `tail_cone` | high | tail cone (cut 3.5 m from the tail) |
| 5 | `wing_fairing` | high | wing-to-body fairing |
| 6 | `fin_l` | high | fin, left side |
| 7 | `fin_r` | high | fin, right side (mirrored) |
| 8 | `rudder` | high | rudder |
| 9 | `engines` | high | nacelles + reversers, both share (old "N2") |
| 10 | `winglets` | high | winglets, both share (old "N1") |
| 11 | `pylons` | high | pylons |
| 12 | `wing_strip` | high | the only wing faces that take this texture |
| 13 | `hstab_strip` | high | the only h-stab faces that take this texture |
| 14 | `doors` | high | gear and wing doors (tiny) |

## Decisions made without asking

- **Real models over UVCAL guesses.** They were fetchable and gave exact answers. The UVCAL
  sheets and shipped liveries became the cross-check instead of the source.
- **F-16 chrome is painted.** From LiverySelector's `livery.json` (commit `4ca59db`, 2026-09-26):
  the F-16 entry is `"index": [3], "labels": {"Texture": [0]}`, a single texture slot.
  `generateTextureList()` maps an airline entry's URLs onto those labels by position, so a second
  URL is dropped. All 82 upstream F-16 liveries use one URL. The model does have a
  `specular.jpg` and a reflection map, but LiverySelector can't swap them. So the four medals use
  the factory's `chrome` layer (painted environment). The Rafale gets real chrome, using
  `tools/build_spec.py`'s packing (G roughness 14, B metal 255, stock gutters kept).
- **Rafale entries** mirror the existing Rafale entry's four-texture pattern: upstream normal map
  and cockpit through LiverySelector's jsDelivr URLs (as Eric's entry already does), our main +
  spec through raw.githubusercontent. None of our files go through jsDelivr.
- **Region-ID sheets are in both manifests** as "UV REGION ID (test)", next to the existing
  UVCAL entries.
- **Preview manifest** is named "Finsonly Air PREVIEW (livery-pack-1)", so it can be loaded next
  to the regular Finsonly Air without confusion.
- **F-16 stock pixels** (cockpit panels, pilot, gear) come from the shipped liveries: per texel,
  the value most of them agree on, or neutral grey where they all differ. No GeoFS file is
  committed. The panel-line layer is derived from GET DUCKED with markings removed.
- **Geometry map committed** (`liveries/uv/*_geom.png`): an 8-bit per-texel airframe position.
  The factory needs it for geometry-true stripes and text orientation. It's derived data, not the
  mesh. If you'd rather not have it in the repo, say so and I'll switch the factory to texture
  space.
- I worked in a separate git worktree (`C:\Users\Eric.Burgard\geofs-livery`) because another
  session was using the main checkout on `solo-race` with uncommitted `race/` changes. Early on my
  `git checkout -b` briefly switched that checkout's HEAD. All the branches were on the same
  commit, so no work was touched, and I put it back on `solo-race`.

## Skipped or limited, and why

- **Rafale region map / decals:** not needed for whole-airframe chrome, so there's no Rafale map
  or Rafale 3D preview. The Rafale liveries are plain tints: no text, no DAWG paw on the black one.
- **Text on shared islands** (F-16 fin, wing undersides) reads correctly on one side only; that's
  the mesh, not a bug. Fin tail numbers and DAWG/MOO read right from the left and backwards from
  the right.
- **757 rudder in the preview** renders slightly aft of the fin. The part offset from
  `aircraft.json` is right in height but not exact along the length. This affects only the
  preview and airframe coordinates on the rudder, not its region label.
- **3D preview** is a crude flat-shaded software render (no specular or reflections), so it
  can't show how the painted chrome actually looks in GeoFS lighting.
- **Multiplayer:** other players see LiverySelector airline liveries only if the airline URL is
  on its `whitelist.json`. Finsonly Air isn't on it, so these are local to you, same as today.
- The `winglets` label on the 757 region-ID sheet is too thin to print. The colour is still
  distinct (teal).

## Tests

`python -m pytest tests/`: 67 passed (spec validation incl. 16 bad-spec cases, output
size/format/1.5 MB cap, determinism by pixel hash with committed 757 PNGs reproduced bit-exact,
seed sensitivity, Rafale spec packing, encoder caps, stock underlay, manifest validator + byte
identity + idempotence, UV map consistency and geometry sanity). The race suites were also run
and are green (`node run.js`: all passed; server pytest: 355 passed, with `RACE_DB` pointed at a
private file because the other session held `/tmp/race-test.db`).

## Eric's 5-minute in-sim checklist

1. **Load the preview.** geo-fs.com, then the COMBINED bookmark. Press `l`, then under
   **Virtual Airlines** click **+ Add Airline** and paste
   `https://raw.githubusercontent.com/eburgard7-cloud/geofs/livery-pack-1/liveries/airline.preview.json`.
   "Finsonly Air PREVIEW (livery-pack-1)" appears. (If it's empty, wait 5 min for the raw cache.)
2. **F-16 region-ID sheet, 4 views.** Pick the F-16, apply **UV REGION ID (test)**, and look
   from:
   - **Front-left:** `6 RADOME` on the nose, `1 FUSELAGE_TOP` along the spine, `8 INTAKE` on
     the intake flank.
   - **Right side:** `11 FIN` should read *backwards* here and forwards from the left (shared
     island). `12 RUDDER` sits on the rudder.
   - **Above:** `14 WING_TOP_R` on the right wing, `13 WING_TOP_L` on the left, `16` along the
     leading edges, `17 FLAPERONS` at the trailing edges, `18`/`19` on the h-stabs.
   - **Below:** `15 WING_BOTTOM` on both undersides (backwards on one), `2 FUSELAGE_BOTTOM`,
     `21 GEAR_DOORS`, `10 VENTRAL_FINS`.

   On every island, the arrows should point to the nose. **Any magenta hatching on the jet is a
   map error:** note where. Then switch to the 757, apply its **UV REGION ID (test)**:
   `1 FUSELAGE_L` reads normally on the left, `2 FUSELAGE_R` reads mirrored on the right
   (expected), `9 ENGINES` on the nacelles, `10` on the winglets, `6`/`7` on the fin.
3. **Three liveries.**
   - **F-16 "Rival: DAWG":** gold DAWG on the fin, gold leading edges and rails, "DAWG" on both
     intake flanks reading nose-to-tail on the left and tail-to-nose on the right, paw prints on
     the wing tops.
   - **F-16 "Medal: Gold":** does the painted chrome read as metal in GeoFS lighting, or look
     muddy? (This is the one I can't judge offline.)
   - **757 "FINSONLY Racing - Team Transport":** "FINSONLY RACING" readable on *both* sides
     above the windows, orange/teal cheatline, checkers by the tail, fish mark on the fin.

   Optionally, the Rafale **Gold Chrome** checks real specular chrome.

Report back: magenta spots, any region label on the wrong part, any arrow not pointing at the
nose, and which text reads backwards where it shouldn't. Those go straight into
`tools/uv_regions.py` and a rebuild (`python tools/uv_regions.py`,
`python tools/region_id_sheet.py`, `python tools/livery_factory.py --all --contact-sheet`).
