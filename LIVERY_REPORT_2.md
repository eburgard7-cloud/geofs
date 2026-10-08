# FINSONLY Livery Pack 2: report

Branch `livery-pack-2`, 2026-10-08. **UNVERIFIED IN-SIM** until the checklist at the bottom is
flown. Built in the Claude cloud workspace from the same factory as pack 1; previews are the
mesh-free projections from `tools/livery_views.py` (no GeoFS mesh cached there).

Scope held: repo root only (liveries/, tools/, tests/, airline.json, this file). No file in
`race/` changed. Existing `airline.json` entries are byte-identical (insert-only; the pre-pack
sha256 test still passes). Every pack-1 texture is untouched.

## Numbers

- 66 new liveries: 27 Gun Game paints, 20 career, 4 season, 3 rewards, 12 free starters.
- `liveries/catalog.json`: 95 liveries in all (pack 1, pack 2 and 11 of your hand-made classics from airline.json).
- 9 recolorable templates (7 for pilots, 2 Gun Game kits), 16 new decals, F-16 + 757 paint kits.
- Every one of the 17 cups now has an F-16 livery (13 new + the 4 from pack 1).
- Tests: `python -m pytest tests/` = 184 passed here. The two pack-1 757 pixel-hash tests
  (`test_757_deterministic_and_reproduces_committed_png`) fail in the cloud workspace on untouched
  main too (its Pillow/FreeType draws text slightly differently); they should pass on your PC.

## The liveries

`listed` = in LiverySelector's Finsonly Air airline. Gun Game paints are deliberately unlisted:
the mode applies them (prompt L6/7), nobody picks them.

| Category | Aircraft | Name | Spec | Unlock | Listed | Size |
|---|---|---|---|---|---|---|
| gungame | 757-200 | FINSONLY GG - Final Tier (Gold) | `b757_gg_final` | Gun Game mode paint | no | 0.18 MB |
| gungame | 757-200 | FINSONLY GG - Heat 1 (Ice) | `b757_gg_heat_1` | Gun Game mode paint | no | 0.10 MB |
| gungame | 757-200 | FINSONLY GG - Heat 2 (Teal) | `b757_gg_heat_2` | Gun Game mode paint | no | 0.09 MB |
| gungame | 757-200 | FINSONLY GG - Heat 3 (Green) | `b757_gg_heat_3` | Gun Game mode paint | no | 0.09 MB |
| gungame | 757-200 | FINSONLY GG - Heat 4 (Lime) | `b757_gg_heat_4` | Gun Game mode paint | no | 0.10 MB |
| gungame | 757-200 | FINSONLY GG - Heat 5 (Amber) | `b757_gg_heat_5` | Gun Game mode paint | no | 0.09 MB |
| gungame | 757-200 | FINSONLY GG - Heat 6 (Orange) | `b757_gg_heat_6` | Gun Game mode paint | no | 0.09 MB |
| gungame | 757-200 | FINSONLY GG - Heat 7 (Red) | `b757_gg_heat_7` | Gun Game mode paint | no | 0.09 MB |
| gungame | 757-200 | FINSONLY GG - Heat 8 (Magenta) | `b757_gg_heat_8` | Gun Game mode paint | no | 0.10 MB |
| gungame | F-16 | FINSONLY GG - Final Tier (Gold) | `f16_gg_final` | Gun Game mode paint | no | 0.33 MB |
| gungame | F-16 | FINSONLY GG - Heat 1 (Ice) | `f16_gg_heat_1` | Gun Game mode paint | no | 0.30 MB |
| gungame | F-16 | FINSONLY GG - Heat 2 (Teal) | `f16_gg_heat_2` | Gun Game mode paint | no | 0.30 MB |
| gungame | F-16 | FINSONLY GG - Heat 3 (Green) | `f16_gg_heat_3` | Gun Game mode paint | no | 0.30 MB |
| gungame | F-16 | FINSONLY GG - Heat 4 (Lime) | `f16_gg_heat_4` | Gun Game mode paint | no | 0.29 MB |
| gungame | F-16 | FINSONLY GG - Heat 5 (Amber) | `f16_gg_heat_5` | Gun Game mode paint | no | 0.32 MB |
| gungame | F-16 | FINSONLY GG - Heat 6 (Orange) | `f16_gg_heat_6` | Gun Game mode paint | no | 0.31 MB |
| gungame | F-16 | FINSONLY GG - Heat 7 (Red) | `f16_gg_heat_7` | Gun Game mode paint | no | 0.29 MB |
| gungame | F-16 | FINSONLY GG - Heat 8 (Magenta) | `f16_gg_heat_8` | Gun Game mode paint | no | 0.29 MB |
| gungame | Rafale M | FINSONLY GG - Final Tier (Gold Mirror) | `rafale_gg_final` | Gun Game mode paint | no | 0.66 MB |
| gungame | Rafale M | FINSONLY GG - Heat 1 (Ice Chrome) | `rafale_gg_heat_1` | Gun Game mode paint | no | 0.64 MB |
| gungame | Rafale M | FINSONLY GG - Heat 2 (Teal Chrome) | `rafale_gg_heat_2` | Gun Game mode paint | no | 0.62 MB |
| gungame | Rafale M | FINSONLY GG - Heat 3 (Green Chrome) | `rafale_gg_heat_3` | Gun Game mode paint | no | 0.62 MB |
| gungame | Rafale M | FINSONLY GG - Heat 4 (Lime Chrome) | `rafale_gg_heat_4` | Gun Game mode paint | no | 0.67 MB |
| gungame | Rafale M | FINSONLY GG - Heat 5 (Amber Chrome) | `rafale_gg_heat_5` | Gun Game mode paint | no | 0.67 MB |
| gungame | Rafale M | FINSONLY GG - Heat 6 (Orange Chrome) | `rafale_gg_heat_6` | Gun Game mode paint | no | 0.60 MB |
| gungame | Rafale M | FINSONLY GG - Heat 7 (Red Chrome) | `rafale_gg_heat_7` | Gun Game mode paint | no | 0.52 MB |
| gungame | Rafale M | FINSONLY GG - Heat 8 (Magenta Chrome) | `rafale_gg_heat_8` | Gun Game mode paint | no | 0.55 MB |
| career | 757-200 | Aloha Cup Charter | `b757_charter_aloha` | Aloha Cup: silver on every course | yes | 0.11 MB |
| career | 757-200 | Badger Cup Charter | `b757_charter_badger` | Badger Cup: silver on every course | yes | 0.10 MB |
| career | 757-200 | KHABO Cup Charter | `b757_charter_khabo` | KHABO Cup: silver on every course | yes | 0.11 MB |
| career | 757-200 | Oregon Cup Charter | `b757_charter_oregon` | Oregon Cup: silver on every course | yes | 0.10 MB |
| career | F-16 | FINSONLY - Alaska Cup | `f16_cup_alaska` | Alaska Cup: gold on every course | yes | 0.27 MB |
| career | F-16 | FINSONLY - Aloha Cup | `f16_cup_aloha` | Aloha Cup: gold on every course | yes | 0.29 MB |
| career | F-16 | FINSONLY - Alpine Cup | `f16_cup_alpine` | Alpine Cup: gold on every course | yes | 0.30 MB |
| career | F-16 | FINSONLY - Bush Cup | `f16_cup_bush` | Bush Cup: gold on every course | yes | 0.30 MB |
| career | F-16 | FINSONLY - Canyon Cup | `f16_cup_canyon` | Canyon Cup: gold on every course | yes | 0.33 MB |
| career | F-16 | FINSONLY - Cascade Cup | `f16_cup_cascade` | Cascade Cup: gold on every course | yes | 0.25 MB |
| career | F-16 | FINSONLY - China Cup | `f16_cup_china` | China Cup: gold on every course | yes | 0.27 MB |
| career | F-16 | FINSONLY - Aviation History Cup | `f16_cup_history` | Aviation History Cup: gold on every course | yes | 0.32 MB |
| career | F-16 | FINSONLY - Japan Cup | `f16_cup_japan` | Japan Cup: gold on every course | yes | 0.28 MB |
| career | F-16 | FINSONLY - Legends Cup | `f16_cup_legends` | Legends Cup: gold on every course | yes | 0.25 MB |
| career | F-16 | FINSONLY - Pacific Cup | `f16_cup_pacific` | Pacific Cup: gold on every course | yes | 0.38 MB |
| career | F-16 | FINSONLY - Pylon Cup | `f16_cup_pylon` | Pylon Cup: gold on every course | yes | 0.28 MB |
| career | F-16 | FINSONLY - Wonders Cup | `f16_cup_wonders` | Wonders Cup: gold on every course | yes | 0.30 MB |
| career | F-16 | FINSONLY - Test Pilot | `f16_tier_test_pilot` | pass the test pilot checkride | yes | 0.28 MB |
| career | Rafale M | FINSONLY - Alpine Ice Chrome | `rafale_cup_alpine` | Alpine Cup: dawg on every course | yes | 0.62 MB |
| career | Rafale M | FINSONLY - Canyon Copper Chrome | `rafale_cup_canyon` | Canyon Cup: dawg on every course | yes | 0.56 MB |
| season | F-16 | FINSONLY - Season: Fall 2026 | `f16_season_2026_fall` | top 3 in season 2026-fall | yes | 0.25 MB |
| season | F-16 | FINSONLY - Season: Winter 2026-27 | `f16_season_2026_winter` | top 3 in season 2026-winter | yes | 0.27 MB |
| season | F-16 | FINSONLY - Season: Spring 2027 | `f16_season_2027_spring` | top 3 in season 2027-spring | yes | 0.26 MB |
| season | F-16 | FINSONLY - Season: Summer 2027 | `f16_season_2027_summer` | top 3 in season 2027-summer | yes | 0.27 MB |
| reward | 757-200 | Gun Game Champion Charter | `b757_gg_champion` | win 5 Gun Games | yes | 0.11 MB |
| reward | F-16 | FINSONLY - Gun Game Champion | `f16_gg_champion` | win 1 Gun Game | yes | 0.25 MB |
| reward | Rafale M | FINSONLY - Gun Game Champion (Ember Chrome) | `rafale_gg_champion` | win 10 Gun Games | yes | 0.61 MB |
| starter | 757-200 | Starter: Cream Classic | `b757_starter_cream` | free | yes | 0.10 MB |
| starter | 757-200 | Starter: Teal Charter | `b757_starter_teal` | free | yes | 0.09 MB |
| starter | F-16 | FINSONLY - Starter: Arctic Split | `f16_starter_arctic` | free | yes | 0.29 MB |
| starter | F-16 | FINSONLY - Starter: Bubblegum Fade | `f16_starter_bubblegum` | free | yes | 0.30 MB |
| starter | F-16 | FINSONLY - Starter: Cardinal Split | `f16_starter_cardinal` | free | yes | 0.27 MB |
| starter | F-16 | FINSONLY - Starter: Goop Flames | `f16_starter_goop` | free | yes | 0.23 MB |
| starter | F-16 | FINSONLY - Starter: Midnight Checker | `f16_starter_midnight` | free | yes | 0.20 MB |
| starter | F-16 | FINSONLY - Starter: Primer | `f16_starter_primer` | free | yes | 0.22 MB |
| starter | F-16 | FINSONLY - Starter: Steve Orange | `f16_starter_steve` | free | yes | 0.29 MB |
| starter | F-16 | FINSONLY - Starter: Sunset Speedline | `f16_starter_sunset` | free | yes | 0.23 MB |
| starter | Rafale M | FINSONLY - Starter: Midnight Chrome | `rafale_starter_midnight` | free | yes | 0.39 MB |
| starter | Rafale M | FINSONLY - Starter: Rose Gold Chrome | `rafale_starter_rose` | free | yes | 0.61 MB |

Sheets: `liveries/out/sheets/{gungame,career,season,reward,starter}.png`.

Tail numbers (all fictional): cups N4624F-N4636F, starters N4801F-N4811F, charters N4704F-N4707F,
Test Pilot N4900F, seasons N4950F-N4953F, champions N4998F-N4999F.

## Design notes

- **Gun Game heat.** One kit per airframe in 8 heat colours, cold to hot (Ice, Teal, Green, Lime,
  Amber, Orange, Red, Magenta), plus Gold for the final tier. The belly, nose, fin and wingtips
  carry the heat colour so a pilot's tier reads from below, the side and above. The fin mark is a
  symmetric reticle because both fin sides share one texture island (text would read backwards on
  one side). `gungame/ladder.json` maps any ladder length onto the 8 steps.
- **Two-tone designs** keep the lower colour off the `fuselage_top` region: the F-16's wing roots
  sit below the cheatline height, and painting "everything below 0.3" there left patches on top.
- Art rules held: original art only (decals drawn from primitives in `tools/make_decals.py`), no
  national insignia (no flag discs or stars on Japan/China cups; the fall leaf is a generic
  five-point leaf), no brands, OFL fonts only.

## In-sim checklist

LiverySelector: Virtual Airlines -> + Add Airline ->
`https://raw.githubusercontent.com/eburgard7-cloud/geofs/livery-pack-2/liveries/airline.preview.json`

- [ ] F-16: Japan Cup (blossoms on both wing tops, indigo belly, no red on top)
- [ ] F-16: Alaska Cup (aurora on the top surfaces, stars)
- [ ] F-16: Pylon Cup (checkered tail and nose band, 88 under the wing)
- [ ] F-16: Aviation History Cup (painted chrome, olive anti-glare)
- [ ] F-16: Test Pilot (orange panels, calibration targets)
- [ ] F-16: Starter Midnight Checker and Starter Goop Flames
- [ ] F-16: Gun Game Champion (gold laurel on the fin)
- [ ] 757: KHABO Cup Charter, Starter Cream Classic (titles readable on both sides)
- [ ] Rafale: Alpine Ice Chrome, Starter Rose Gold Chrome
- [ ] Gun Game heat paint (not in LiverySelector): probe round 4 (prompt L2) applies
      `f16_gg_heat_7` to a friend's jet on your screen
