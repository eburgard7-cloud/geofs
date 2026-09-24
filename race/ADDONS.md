# Third-party GeoFS addons (manifest only)

`race/addons.json` pins six community GeoFS addons to exact commits, so a future "load addons"
option can fetch a known-good version instead of whatever `main` is today. **Nothing here is wired
into `race.js`** — the manifest is data, every entry is `"default": false`, and no FINSONLY
bookmarklet loads any of them.

Validate with `python race/tools/check_addons.py` (schema, that each pinned SHA exists — via the
GitHub API or, when that's blocked, `git fetch <repo> <sha>` — and hotkey collisions against the
Alt+ bindings it reads out of `race.js`). `--offline` skips the SHA check; `--strict` makes
collisions fail. Tests: `race/test/test_check_addons.py`.

Source: the six were picked from [geofs-pilot/GeoFS-All-in-one-Addon](https://github.com/geofs-pilot/GeoFS-All-in-one-Addon)
(checked at `fc7c2a7f16a68a3e291e57026ce961880d8f4d13`), but pinned to their **upstream** repos,
since the All-in-one inlines several of them as minified, modified copies in one 2400-line
`main.js`. SHAs are the upstream `HEAD` on 2026-09-24, confirmed with `git ls-remote` and a
fetch-by-SHA (the GitHub REST API was blocked from the session that pinned them). `url` is the
jsDelivr `gh/<repo>@<sha>/<file>` form — jsDelivr itself was unreachable from that session, so
the URLs are well-formed but were not fetched.

| id | What it does | Keys | Writes physics? | License |
|---|---|---|---|---|
| `flight-path-vector` | Cesium billboard showing where the aircraft is actually going (FPV), hidden on the ground | **L** toggles (no modifier check) | no | no license found |
| `sky-dolly` | Formation-flight recording/playback against your own ghost, logbook, camera animator; GUI panel only | none | no (moves its own ghost models, sets the camera during playback) | no license found |
| `camera-cycling` | Cycles camera modes (except 2–5) every 30 s in random order | **W** toggles (refuses Ctrl/Alt/Meta) | no (calls `geofs.camera.set`) | no license found |
| `information-display` | Bottom-right bar: KIAS, Mach, GS, ALT, AGL, HDG, V/S | **I** hides/shows (`userscript.js` only) | no | **conflicting**: LICENSE file is CC BY-NC-SA 4.0, script header says GPL-3.0 |
| `cockpit-volume` | Halves GeoFS volume in cockpit views on aircraft without cockpit sounds | none | no (writes `geofs.preferences.volume`) | no license found |
| `gpws-callouts` | GPWS altitude / sink-rate / terrain callouts (hotlinked audio) | none by default (`window.soundsToggleKey = "none"`) | no | no license found |

"No license found" means no LICENSE file in the repo and no `@license` in the userscript header —
all rights reserved by default, so we can **link to** a pinned URL but should not vendor or
modify the code. The All-in-one repo itself also has no license.

## Conflicts and gotchas

- **Alt+L (racing line) vs FPV's L.** FPV's handler is `event.key === 'l'` on `document` with no
  modifier check, so Alt+L would toggle the FPV too. In practice race.js wins: its handler is on
  `window` in the capture phase and calls `stopImmediatePropagation()` for every key it handles,
  so the event never reaches `document`. `check_addons.py` reports this as a *loose* collision.
  The All-in-one's minified FPV uses **Insert** instead, which doesn't collide.
- **W (camera cycling)** collides with nothing in race.js (the handler rejects Alt), but the
  All-in-one README says it was disabled there because W clashed with a flightradar addon. It
  also changes camera mode every 30 s, which fights race.js's own camera if that ever adds one.
- **GPWS callouts** will shout TERRAIN / SINK RATE all race long on the low-level courses
  (canyons, fjords) — fine for fun, bad for voice chat.
- **Cockpit volume** changes `geofs.preferences.volume`; race.js synthesizes its SFX with WebAudio
  and doesn't read that preference, so race sounds are unaffected.
- **Information display** is read-only and harmless; it overlaps race.js's HUD only if the HUD is
  moved bottom-right.
- **Sky Dolly** is the heaviest (~77 KB) and adds its own GUI and entities; its playback ghost is a
  different thing from race.js's ghost racing and the two don't share data.
- None of the six call `setLinearVelocity`, `place()`, the autopilot or `controls.setters` — so
  none conflicts with `GeoPhysics` (CLAUDE.md's allowed physics writes).
