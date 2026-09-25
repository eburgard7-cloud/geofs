# Build from the REPO ROOT, not race/server/, so the course list can go into the image:
#   docker build -f race/server/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t race .
# The root .dockerignore keeps the context to race/server + race/courses + race/runways.
FROM python:3.12-slim
WORKDIR /app
COPY race/server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY race/server/app.py race/server/migrate_modes.py ./
# The public site (race.finsonly.net "/"): plain static files, no build step.
COPY race/server/static/ /app/static/
# The install panel's real bookmarklet is built from this at server start (see
# app.py's load_bookmarklet()) -- never hardcoded into the page.
COPY race/bookmarklet.txt /app/bookmarklet.txt
# A snapshot of the shared course list, so the image can never start with an empty vote. The
# redeploy mounts the checkout's race/courses read-only over it, so `git pull` alone updates it.
COPY race/courses/ /app/courses/
# Same for the landing-mode runways (race/runways/*.json): baked in, mounted over read-only at
# deploy. app.py falls back to its embedded three if this directory is ever missing or empty.
COPY race/runways/ /app/runways/
# Same again for the joke-plane ghost models (race/models/*.glb + index.json/assignments.json):
# baked in, mounted over read-only at deploy. Serving these from this server's own origin (GET
# /models/*, see app.py) is what lets the site's CSP stay connect-src 'self' -- they used to be
# fetched straight from raw.githubusercontent.com, which that CSP refused.
COPY race/models/ /app/models/
# GET /version reports this. Left as "unknown" if the build omits --build-arg (matches app.py's
# own default for a local, no-build uvicorn run).
ARG GIT_SHA=unknown
ENV RACE_DB=/data/race.db RACE_COURSES_DIR=/app/courses RACE_RUNWAYS_DIR=/app/runways RACE_MODELS_DIR=/app/models RACE_GIT_SHA=$GIT_SHA
# Tile proxy disk cache (race/server/app.py "Tile proxy + disk cache"): no RACE_TILE_CACHE_DIR
# here on purpose. app.py's _default_tile_cache_dir() follows RACE_DB's directory by default, so
# it lands wherever the deploy actually bind-mounts its data dir -- /data for the compose.snippet.yml
# layout below, /app/data for redeploy.sh's layout (RACE_DB=/app/data/race.db).
#
# No VOLUME /data either, deliberately: redeploy.sh's layout never mounts anything at /data (only
# at /app/data), so a bare VOLUME /data here was creating an anonymous, root-owned volume on every
# container start -- unwritable as the 99:100 user below, which is exactly what turned every
# /tiles/* route into a 500 (found 2026-09-24: the hardcoded RACE_TILE_CACHE_DIR=/data/tiles above
# resolved onto that volume). Nothing in compose.snippet.yml, redeploy.sh, autodeploy.sh or the
# RUNBOOK's manual rollback command relies on the VOLUME declaration itself -- compose.snippet.yml
# bind-mounts a real host directory at /data explicitly, which needs no VOLUME line to work.
# mkdir+chown /data anyway, so a deploy that runs this image with no volume/mount at /data at all
# (rare, but the scp/manual path in RUNBOOK's "First-time or manual deploy" is exactly that until
# its own explicit -v is added) still gets a writable default instead of a root-owned directory.
RUN mkdir -p /data && chown 99:100 /data
EXPOSE 8000
USER 99:100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
