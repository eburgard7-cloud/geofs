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

```text
liveries/
├── specs/        one JSON per livery (the source of truth)
├── out/          built textures + CONTACT_SHEET.png (committed; the manifests point here)
├── uv/           region maps, geometry maps, F-16 panel-line shade, 757 cabin windows
├── test/         region-ID test sheets
├── decals/       original decal art (drawn by tools/make_decals.py)
├── fonts/        bundled OFL fonts (Anton, Bungee) + their licences
└── airline.preview.json   airline.json + this pack, served from the livery-pack-1 branch
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
757 from `/backend/aircraft/repository/GXD04N_126645_238/`) into `liveries/.cache/`, which is
gitignored. Nothing from GeoFS is committed.

## How the maps were made

`tools/uv_regions.py` reads the real models, rasterizes every triangle that uses the livery
texture into UV space and labels it from its part name (rudder, elevators, gear doors...), its 3D
position and its facing. For the F-16 a 26-direction z-buffer pass marks body faces nobody can see
from outside (cockpit tub, intake duct, bays) as `interior`. Each map is cross-checked against
Eric's shipped liveries: the `cross_check` block in `uv/<ac>.json` says what share of each
region's texels those liveries repainted (F-16: ~100% of wings, fin, radome, fuselage top; 0.7% of
`mechanical`).

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

## In-sim check (the exact LiverySelector steps)

This is how LiverySelector loads a second manifest (from its `main.js`: `addAirline()` prompts for
a URL, fetches it, and keeps it in `localStorage.links`, so it survives reloads).

1. Open [geo-fs.com](https://www.geo-fs.com), wait for the plane, click the **COMBINED** bookmark
   (it loads LiverySelector; see [race/bookmarklet.txt](../race/bookmarklet.txt)).
2. Press **`l`** (or the LiverySelector button in the bottom bar) to open the livery panel.
3. Under **Virtual Airlines**, click **+ Add Airline** and paste
   `https://raw.githubusercontent.com/eburgard7-cloud/geofs/livery-pack-1/liveries/airline.preview.json`
   then OK. The airline **Finsonly Air PREVIEW (livery-pack-1)** appears with its liveries for the
   aircraft you're flying (F-16, 757 or Rafale M; switch aircraft and reopen the panel to see the
   others). Click one to apply it.
4. When the branch is merged, remove the preview: the **- Remove airline** button next to its
   name. The regular Finsonly Air (`.../geofs/main/airline.json`) carries the same liveries.

Notes: raw.githubusercontent caches for about 5 minutes, so a fresh push can take that long to
show. Don't use jsDelivr for this repo's files: it caches `@main` for hours. Other players only
see LiverySelector airline liveries whose URL is on LiverySelector's `whitelist.json`; Finsonly
Air isn't, so these liveries are local to you.
