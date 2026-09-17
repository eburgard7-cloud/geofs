# geofs repo

Repo root holds FINSONLY liveries (textures + airline.json for LiverySelector). Do not modify those unless asked.

## race/ — FINSONLY Racing
Checkpoint racing layer for GeoFS, loaded by bookmarklet (Tampermonkey is admin-blocked on the target machine; no extensions).
Read race/README.md first.

Rules:
- race/race.js must stay a single self-contained file, no build step, no external deps.
- All GeoFS/Cesium internals are touched ONLY in the `G` adapter and makeGateLayer. Keep it that way.
- Run both test suites before every commit; never commit with failures:
  - cd race/test && npm install && node run.js
  - cd race/server && pip install -r requirements.txt httpx pytest && python -m pytest ../test/test_server.py -q
- Add a test for every bug fix.
- The GeoFS-internal names in `G` are unverified against the live site; the user checks them manually on geo-fs.com and reports back.
- Leaderboard server deploys to an Unraid Docker Compose stack behind Caddy on the external `proxy` network. Never add Authelia to race.finsonly.net. Never edit the live Caddyfile or restart containers without explicit approval.
- Commit messages: short, imperative. Bump CONFIG.VERSION in race.js on user-visible changes.
