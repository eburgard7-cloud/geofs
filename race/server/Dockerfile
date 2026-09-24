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
# GET /version reports this. Left as "unknown" if the build omits --build-arg (matches app.py's
# own default for a local, no-build uvicorn run).
ARG GIT_SHA=unknown
ENV RACE_DB=/data/race.db RACE_COURSES_DIR=/app/courses RACE_RUNWAYS_DIR=/app/runways RACE_GIT_SHA=$GIT_SHA
VOLUME /data
EXPOSE 8000
USER 99:100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
