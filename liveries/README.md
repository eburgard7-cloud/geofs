# Finsonly Air livery factory

Liveries for the Finsonly Air airline (the root [`airline.json`](../airline.json), loaded in
GeoFS by [LiverySelector](https://github.com/kolos26/GEOFS-LiverySelector)) are built here from
JSON specs. The factory knows where paint lands on each airframe, so a spec says "fin gold, nose
pink, name on both intake flanks" and the factory works out the texels.

Everything is Pillow + numpy, deterministic (seeded), offline, and writes each texture in its
LiverySelector slot's native size and format, each one under 1.5 MB:

| Aircraft | `airline.json` key | Output | Region map |
|---|---|---|---|
| F-16 | `7` | 2048 x 2048 WebP (q 88) | [`uv/f16_regions.png`](uv/f16_regions.png), [`uv/f16.json`](uv/f16.json) |
| Boeing 757-200 | `GXD04N_126645_238` | 1024 x 1024 PNG | [`uv/b757_regions.png`](uv/b757_regions.png), [`uv/b757.json`](uv/b757.json) |
| Rafale M | `rafale` | 4096 WebP main + 1024 WebP specular | none (whole-airframe tint) |
| Boeing 737-700 (id 4) | `4` | 4096 x 4096 JPEG | [`uv/b737_regions.png`](uv/b737_regions.png), [`uv/b737.json`](uv/b737.json) |
| Boeing 737 Max 8, SpiceJet (id 2772) | none (race.js only) | 2048 x 2048 PNG | [`uv/b737max_regions.png`](uv/b737max_regions.png), [`uv/b737max.json`](uv/b737max.json) |
| Cessna 172 (id 2) | `2` | 2048 x 2048 JPEG | [`uv/c172_regions.png`](uv/c172_regions.png), [`uv/c172.json`](uv/c172.json) |
| Retro 172 (id 2000) | none (race.js only) | 2048 x 2048 PNG | [`uv/c172retro_regions.png`](uv/c172retro_regions.png), [`uv/c172retro.json`](uv/c172retro.json) |
| Piper Cub (id 1) | `1` | 1024 x 1024 JPEG | [`uv/cub_regions.png`](uv/cub_regions.png), [`uv/cub.json`](uv/cub.json) |
| Paraglider (ids 50, 56) | `paraglider` | 1024 x 1024 JPEG | [`uv/paraglider_regions.png`](uv/paraglider_regions.png), [`uv/paraglider.json`](uv/paraglider.json) |
| Sukhoi Su-35 (id 18) | `18` | 4096 x 4096 JPEG | [`uv/su35_regions.png`](uv/su35_regions.png), [`uv/su35.json`](uv/su35.json) |
| DHC-2 Beaver (id 13) | `13` | 4096 x 4096 JPEG | [`uv/beaver_regions.png`](uv/beaver_regions.png), [`uv/beaver.json`](uv/beaver.json) |

The ladder airframes (everything below the Rafale) are keyed by GeoFS aircraft id, which
LiverySelector matches against `geofs.aircraft.instance.id` (the paraglider by its folder name,
which covers both Paraglider entries). The 737 Max 8 and the Retro 172 have no LiverySelector entry,
so LiverySelector can't apply anything to them: their paints are in `catalog.json` only, for
race.js to apply with `geofs.api.changeModelTexture(model, url, {index: N})` (`texture_index` in the
catalog). The 737 Max's livery sheet is 1572 x 982 in the model; the factory writes it square
(UVs are normalised, and every tool here works on square textures).

```text
liveries/
├── specs/        one JSON per livery (the source of truth)
├── out/          built textures + CONTACT_SHEET.png (committed; the manifests point here)
├── uv/           region maps, geometry maps, F-16 panel-line shade, 757 cabin windows
├── test/         region-ID test sheets
├── decals/       original decal art (drawn by tools/make_decals.py)
├── fonts/        bundled OFL fonts (Anton, Bungee) + their licences
├── templates/    recolorable templates + instances.json (pack 2)
├── gungame/      ladder.json: Gun Game heat palette and tier -> paint rule (pack 2)
├── kit/          paint kits for pilots' own liveries (pack 2)
├── catalog.json  every livery with category + unlock (pack 2, generated)
└── airline.preview.json   airline.json + the packs, served from the ladder-airframes branch
```

## Build

From the repo root:

```bash
python tools/livery_factory.py --all                  # every spec in liveries/specs/
python tools/livery_factory.py --only f16_rival_moo   # one (or more) by id
python tools/livery_factory.py --check                # validate specs, build nothing
python tools/livery_factory.py --contact-sheet        # liveries/out/CONTACT_SHEET.png
python tools/livery_factory.py --manifest preview     # liveries/airline.preview.json
python tools/livery_factory.py --manifest main        # append new liveries to airline.json
python tools/livery_manifest.py                       # validate both manifests
python -m pytest tests/                               # the livery tests
```

A full F-16 takes about 30 s, a 757 a few seconds. `--manifest main` only ever inserts: existing
`airline.json` entries stay byte-for-byte identical (a test checks this against the pre-pack
file's hash), and re-running it is a no-op.

The region maps are rebuilt with `python tools/uv_regions.py` (then
`python tools/region_id_sheet.py` for the test sheets). That's the only step that needs network:
it fetches the model files GeoFS itself serves (the F-16 from `/models/aircraft/premium/f16/`, the
757 from `/backend/aircraft/repository/GXD04N_126645_238/`, the ladder airframes from the paths in
`uv/<ac>.json` `source`) and, for the ladder airframes' cross-check, a few LiverySelector community
liveries into `liveries/.cache/`, which is gitignored. Nothing from GeoFS is committed.

## How the maps were made

`tools/uv_regions.py` reads the real models, rasterizes every triangle that uses the livery
texture into UV space and labels it from its part name (rudder, elevators, gear doors...), its 3D
position and its facing. For the F-16 a 26-direction z-buffer pass marks body faces nobody can see
from outside (cockpit tub, intake duct, bays) as `interior`. Each map is cross-checked against
Eric's shipped liveries: the `cross_check` block in `uv/<ac>.json` says what share of each
region's texels those liveries repainted (F-16: ~100% of wings, fin, radome, fuselage top; 0.7% of
`mechanical`).

The ladder airframes are labelled by a rule table per airframe in `tools/uv_regions.py` (part
name + position + facing, first match wins; region names match the F-16 / 757 maps), get the same
visibility pass (except the 737 Max, whose title-band overlay faces would make the skin under them
look hidden), and drop degenerate faces whose UVs smear over the sheet (a 0.4 m 737 flap fairing
mapped across 20 texture widths). Texels a left and a right part share become `<name>_both` /
`fin`. Their cross-check uses up to six LiverySelector community liveries (painted share per
region) plus the stock sheet (used share per region). No Finsonly liveries exist for them, so the
factory fills their non-paint regions (gear, interior, pilot) with flat neutrals, and for the
737-700 draws plain cabin windows where the stock sheet has them (`cabin.windows` in
`uv/b737.json`: rectangles only, found by `detect_windows`; doors aren't detected).
`liveries/test/<ac>_region_views.png` is each map's region-ID sheet projected through
`tools/livery_views.py`.

Besides the region map, `uv/<ac>_geom.png` stores each texel's airframe position (R lateral,
G height, B nose-to-tail, all 0..255). Stripes, gradients, noise and text orientation are all
computed in that airframe space, so a cheatline at "height 0.345" lines up across UV seams, and
text says which way it reads on the jet (`"baseline": "+length", "up": "+height"`) instead of how
it's rotated in the texture. Mirrored islands are handled: the factory flips the art so it reads
right on the side you name.

Things that are shared, so paint shows on both sides:

- **F-16:** the fin (both sides are one island), the wing undersides (left and right are one
  island), the leading-edge flaps, the left h-stab top plus both h-stab undersides, and some
  fuselage-side texels (`fuselage_side_both`). Text on these reads correctly on one side only.
- **757:** only the engines, winglets and pylons. The two fuselage sides and fin sides are
  separate; the right-hand band is mirrored in the texture (Eric's shipped 757s already flip their
  right-side text).
- **737-700:** the wings (top `wing_both`, undersides `wing_bottom`) and the tailplane skins.
  Fuselage sides and fin faces are separate.
- **737 Max 8:** most of the fuselage (`fuselage_both`) and the whole fin (`fin`). Only the title
  band above the windows is separate per side (`fuselage_l` / `fuselage_r`), which is where text
  goes. Much of the wing and the tailplane sample a second sheet that one texture slot can't
  reach, so those parts stay stock.
- **Cessna 172, Retro 172, Beaver:** the wing undersides. Sides, fins and wing tops are separate.
- **Cub:** the fuselage sides (`fuselage_both`), the fin and most of the upper wing: no text
  on it (it would read backwards on one side); its templates have no text params.
- **Su-35:** the wing undersides. Each fin is its own island, with separate outer and inner faces
  (`component` 0 is the outer face on both). The fuselage sides unwrap into small fragments, so
  titles run along the spine (`fuselage_top`) instead.
- **Paraglider:** everything. The texture is a front-view picture of half the canopy, mirrored:
  both halves and both skins land on the same texels. Symmetric art only, no text.

## Add a livery

1. Copy a spec from `specs/` to `specs/<id>.json`. The file name must equal `"id"` (lowercase,
   digits, underscores). Pick a new `"seed"` and `"name"` (the name shown in LiverySelector; it
   must be unique for that aircraft).
2. Set `"base"`: a colour per region (`"*"` is the default for every paintable region). Region
   names are in `uv/<ac>.json`; `python tools/region_id_sheet.py` shows where they are.
3. Add `"layers"`, painted in order. Every layer takes `"regions"` (a name, a list, `"*"` or a
   `"prefix*"`), an optional `"where"` limit in airframe space
   (`{"length": [a, b], "height": [a, b], "lat": [a, b], "side": "l"|"r"}`) and `"opacity"`.

   | type | what | key fields |
   |---|---|---|
   | `fill` | flat colour | `color` |
   | `gradient` | linear or radial ramp | `axis` (`length`, `height`, `lat`, `u`, `v`), `stops` `[[t, colour], ...]`, `range`, `reverse`, `normalize: "region"`; radial: `kind`, `axes`, `center`, `radius` |
   | `stripe` | cheatline / band | `axis` (default `height`), `center`, `width`, `slant` (axis += slant x length), `period` (repeat), `outline_color`, `outline_width` |
   | `checker` | chequers in airframe space | `cells` (along the length), `colors`, `plane` (`side` or `top`) |
   | `spots` | 3D noise blobs (cow spots, mottling) | `color`, `scale` (per metre), `threshold`, `octaves`, `salt` |
   | `flames` | hot-rod flames from the nose | `band` (height range), `reach`, `tongues`, `colors`, `outline_color` |
   | `halftone` | dot screen fading along an axis | `color`, `spacing` (texels), `axis`, `from`, `to`, `angle` |
   | `scatter` | seeded bubbles, dots, rings, stars | `shape`, `count`, `size` `[min, max]` texels, `color` |
   | `chrome` | painted-environment fake chrome | `tint`, `streaks`, `bands`, `stops` |
   | `text` | lettering | `text`, `font` (a file in `fonts/`, or `"block"` for drawn block letters), `size` (texels), `color`, `stroke`, `stroke_color`, `skew` |
   | `decal` | a PNG from `decals/` | `file`, `size` (width in texels), `tint` |

   `text` and `decal` are placed with `"anchor"` (the nearest texel to an airframe point, e.g.
   `{"length": 0.41, "height": 0.34, "lat": 0.43, "facing": "side"}`, optionally inside
   `"region"`), with `"region"` alone (the island's widest point, or `"at": [fx, fy]` inside its
   bounding box; `"component"` picks another island) or with `"pos": [x, y]` in texels. Orient
   them with `"baseline"` and `"up"` (`"+length"`, `"-lat"`, ...) or a plain `"rotate"` in degrees.
   Good anchors on the F-16: names on the intake flanks (`lat` 0.43 left, 0.57 right,
   `length` ~0.41, `height` ~0.34, `facing: side`), tail numbers at `length` 0.83 /
   `height` 0.52 on the `fin`. On the 757, titles go above the windows at `height` ~0.347 (the
   crown is squeezed to about 25 texels in this model's side projection).
4. `"finish"`: `panel_lines` (F-16 stock panel lines, markings removed), `wear` (grime, heavier
   low down), `soot` (aft end), and on the 757 `cabin` (windows and doors on/off) and
   `window_color`.
5. Build it, look at it (`--contact-sheet` renders the flat texture and two 3D views on the real
   mesh when the model cache exists), then `--manifest preview` and `--manifest main`.

Rafale specs are different: `"rafale": {"finish": "chrome", "tint": "#ffc34a", "roughness": 14}`
tints the stock main texture (its roundels, unit badge and lettering are scrubbed first) and packs
the specular map exactly the way [`tools/build_spec.py`](../tools/build_spec.py) does (G roughness,
B metalness, stock black gutters kept), with the whole airframe as the chrome mask.

**Chrome on the F-16 is painted, not real.** LiverySelector's F-16 entry exposes one texture slot
(`"labels": {"Texture": [0]}`, texture index 3 = the model's `texture.jpg`); the extra URLs of an
airline entry are dropped by `generateTextureList`. The model has its own `specular.jpg` and a
reflection map, but LiverySelector can't swap them, so the medal set uses the `chrome` layer.

Art rules: original art only. No real airline liveries, no real military markings or national
insignia, no brands, no copyrighted characters. Tail numbers are fictional (`N4xxxF`).

## Pack 2: templates, catalog, Gun Game paint, uploads

Pack 2 (branch `livery-pack-2`) adds 66 liveries and the pieces the Garage and Gun Game build on.
Everything below is offline and deterministic, like the factory.

| Piece | Files | What it's for |
|---|---|---|
| Templates | `templates/<id>.json`, `templates/instances.json`, `tools/livery_templates.py` | A spec with `{{param}}` holes + a param schema. Starters and Gun Game paints are instances; the Garage's "Recolor + text" renders the same templates with a pilot's choices |
| Catalog | `catalog.json`, `tools/livery_catalog.py` | Every livery: category (starter, classic, career, season, reward, gungame), unlock requirement, files, template params. What the server serves and race.js applies |
| Gun Game paint | `gungame/ladder.json`, `tools/gungame_ladder.py` | Heat palette (8 steps + gold), the tier -> heat rule for any ladder length, presets, test vectors for the JS port |
| Uploads | `tools/livery_upload.py`, `kit/` | Checks + re-encodes a pilot's own texture; paint kits (blank + guides) for F-16 and 757 |
| Blueprint views | `tools/livery_views.py` | Left / right / top views projected through the geometry map; no GeoFS mesh needed. Also the contact-sheet fallback |

```bash
python tools/livery_templates.py list                 # pilot templates and their params
python tools/livery_templates.py generate             # instances.json -> specs/ (then build them)
python tools/livery_templates.py check                # instances and specs agree
python tools/livery_templates.py render --template f16_speedline \
    --params '{"base": "#112233", "title": "STEVE"}' --out steve.webp
python tools/livery_factory.py --sheets               # liveries/out/sheets/<category>.png
python tools/livery_catalog.py                        # rebuild catalog.json (--check in CI)
python tools/gungame_ladder.py classic                # a preset's tiers, heat and paint ids
python tools/paint_kit.py                             # liveries/kit/*
python tools/livery_views.py f16 liveries/out/f16_cup_aloha.webp aloha_views.png
```

Template holes: a string that is exactly `"{{p}}"` becomes the param value (any type);
`"{{p|dark:0.4}}"`, `"{{p|light:0.3}}"` and `"{{p|alpha:0.5}}"` adjust a colour; text can embed
holes (`"{{tail}}-X"`). Param types: `color` (#rrggbb), `text` (uppercased, A-Z 0-9 . ! & ' -,
`max` length), `tail` (1-7 letters/digits/dashes), `int` (`min`/`max`). Templates with
`"pilot": false` (the Gun Game kits) aren't offered to pilots. The same (template, params) always
gives the same pixels: the seed is a hash of them.

Spec keys added in pack 2: `"listed": false` keeps a livery out of LiverySelector's manifests
(the Gun Game heat paints: the mode applies them, nobody picks them), and `"catalog"` carries
`category`, `requires`, `tail`, `season`, `gungame.heat`. Pack-1 liveries have no catalog block;
their unlocks come from `race/campaign/rewards.json` (matched by name, read-only).

Gun Game heat: tier `t` of an `n`-tier ladder wears heat `1 + floor((t-1) * 7 / max(n-2, 1) + 0.5)`
and the last tier wears gold, so any ladder the group builds runs cold to hot. Paint ids are
`<aircraft>_gg_heat_<1-8>` and `<aircraft>_gg_final`. Every airframe in `gungame/ladder.json` with
`"paint": "ready"` has a full set: F-16, 757, Rafale, Su-35, 737 Max 8 (the ladder's 737 tier,
id 2772), 737-700, Cessna 172, Retro 172, Cub, Beaver and the paraglider (the ladder's glider
tier). Only the toilet (a joke model) flies stock paint.

## In-sim check (the exact LiverySelector steps)

This is how LiverySelector loads a second manifest (from its `main.js`: `addAirline()` prompts for
a URL, fetches it, and keeps it in `localStorage.links`, so it survives reloads).

1. Open [geo-fs.com](https://www.geo-fs.com), wait for the plane, click the **COMBINED** bookmark
   (it loads LiverySelector; see [race/bookmarklet.txt](../race/bookmarklet.txt)).
2. Press **`l`** (or the LiverySelector button in the bottom bar) to open the livery panel.
3. Under **Virtual Airlines**, click **+ Add Airline** and paste
   `https://raw.githubusercontent.com/eburgard7-cloud/geofs/ladder-airframes/liveries/airline.preview.json`
   then OK. The airline **Finsonly Air PREVIEW (ladder-airframes)** appears with its liveries for the
   aircraft you're flying (F-16, 757, Rafale M, 737-700, Cessna 172, Cub, Su-35, Beaver or
   Paraglider; switch aircraft and reopen the panel to see the others). Click one to apply it.
   Each of those also lists **UV REGION ID (test)**: the region-ID sheet, to check the map
   in-sim. The Gun Game heat paints, the 737 Max 8 and the Retro 172 aren't listed (they're
   applied by race.js).
4. When the branch is merged, remove the preview: the **- Remove airline** button next to its
   name. The regular Finsonly Air (`.../geofs/main/airline.json`) carries the same liveries.

Notes: raw.githubusercontent caches for about 5 minutes, so a fresh push can take that long to
show. Don't use jsDelivr for this repo's files: it caches `@main` for hours. Other players only
see LiverySelector airline liveries whose URL is on LiverySelector's `whitelist.json`; Finsonly
Air isn't, so these liveries are local to you.
