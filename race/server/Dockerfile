# Build from the REPO ROOT, not race/server/, so the course list can go into the image:
#   docker build -f race/server/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t race .
# The root .dockerignore keeps the context to race/server + race/courses.
FROM python:3.12-slim
WORKDIR /app
COPY race/server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY race/server/app.py race/server/migrate_modes.py ./
# A snapshot of the shared course list, so the image can never start with an empty vote. The
# redeploy mounts the checkout's race/courses read-only over it, so `git pull` alone updates it.
COPY race/courses/ /app/courses/
# GET /version reports this. Left as "unknown" if the build omits --build-arg (matches app.py's
# own default for a local, no-build uvicorn run).
ARG GIT_SHA=unknown
ENV RACE_DB=/data/race.db RACE_COURSES_DIR=/app/courses RACE_GIT_SHA=$GIT_SHA
VOLUME /data
EXPOSE 8000
USER 99:100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
