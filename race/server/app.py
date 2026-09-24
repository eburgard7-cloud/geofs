"""FINSONLY Racing leaderboard — FastAPI + SQLite.

No accounts: the client is public JS, so any shared secret would be public too.
Protection is plausibility checks, per-IP rate limiting, and Caddy's geoblock/CrowdSec.
"""
import asyncio
import datetime as _dt
import hashlib
import hmac
import html
import io
import json
import logging
import math
import os
import random
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException, Path, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from migrate_modes import migrate_modes, race_payload

DB_PATH = os.environ.get("RACE_DB", "/data/race.db")
ORIGINS = [o.strip() for o in os.environ.get(
    "RACE_ORIGINS", "https://www.geo-fs.com,https://geo-fs.com").split(",") if o.strip()]
MAX_SPEED_MS = float(os.environ.get("RACE_MAX_SPEED_MS", "700"))
MIN_INTERVAL_S = float(os.environ.get("RACE_MIN_INTERVAL_S", "5"))
SERVER_VERSION = "1.6.0"          # bump alongside CHANGELOG.md's server-visible entries
# Baked in at image build time (Dockerfile ARG GIT_SHA -> ENV RACE_GIT_SHA); "unknown" for a local
# `uvicorn app:app` run with no build step behind it.
GIT_SHA = os.environ.get("RACE_GIT_SHA", "unknown")
# Bearer token for the admin-only write routes (today: POST /ghosts/house, the robot test pilot's
# House ghost upload). Unset or empty = those routes answer 503, so a deploy that never sets it
# has no admin surface at all.
ADMIN_TOKEN = os.environ.get("RACE_ADMIN_TOKEN", "")
STARTED_AT = None                 # set once, in lifespan() below, so /version reports real uptime


def _default_courses_dir() -> str:
    """RACE_COURSES_DIR, else the image's /app/courses snapshot, else the checkout's race/courses
    (a local uvicorn run from race/server)."""
    env = os.environ.get("RACE_COURSES_DIR")
    if env:
        return env
    if os.path.isdir("/app/courses"):
        return "/app/courses"
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "courses"))


COURSES_DIR = _default_courses_dir()


def _default_tile_cache_dir() -> str:
    """RACE_TILE_CACHE_DIR, else /data/tiles when /data exists (the container's one persistent
    volume, same posture as RACE_DB's /data/race.db), else a checkout-local cache dir for a local
    uvicorn run. Same env-override pattern as _default_courses_dir()."""
    env = os.environ.get("RACE_TILE_CACHE_DIR")
    if env:
        return env
    if os.path.isdir("/data"):
        return "/data/tiles"
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".tile_cache"))


TILE_CACHE_DIR = _default_tile_cache_dir()
# Feature series 0.7-1.0: every new server route gets an env-overridable default. RACE_TILE_PROXY
# is the killswitch (404s the routes when off, e.g. to fall back to config.js pointing straight at
# the third-party hosts again); everything else defaults ON.
RACE_TILE_PROXY = os.environ.get("RACE_TILE_PROXY", "1").strip().lower() not in ("0", "false", "off", "")
RACE_IMAGERY = os.environ.get("RACE_IMAGERY", "esri").strip().lower()
TILE_CACHE_MB = float(os.environ.get("RACE_TILE_CACHE_MB", "2048"))
TILE_RATE_PER_S = float(os.environ.get("RACE_TILE_RATE_PER_S", "20"))
TILE_CACHE_MAX_AGE_S = 30 * 24 * 3600   # 30 days, per the task's Cache-Control requirement
TERRAIN_MAX_ZOOM = 14           # matches config.js TILE_SOURCES.terrain.maxZoom
LABELS_MAX_ZOOM = 18            # matches config.js TILE_SOURCES.labels.maxZoom
TERRAIN_CREDIT = "Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED, NED, ETOPO1 and others)"
LABELS_CREDIT = "Labels: Esri"
# Esri is the default; RACE_IMAGERY=eox switches every /tiles/imagery/* request to EOX Sentinel-2
# cloudless instead. Both URL shapes and credits are copied verbatim from config.js's old
# (pre-proxy) TILE_SOURCES.imagery list so attribution never regresses.
IMAGERY_SOURCES = {
    "esri": {
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "max_zoom": 18, "ext": "png",
        "credit": "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
    "eox": {
        "url": "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
        "max_zoom": 15, "ext": "jpg",
        "credit": "Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus "
                  "Sentinel data 2020), CC BY-NC-SA 4.0",
    },
}
LABELS_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"


def _default_runways_dir() -> str:
    """RACE_RUNWAYS_DIR, else the image's /app/runways snapshot, else the checkout's race/runways
    (a local uvicorn run from race/server) — the same posture as _default_courses_dir()."""
    env = os.environ.get("RACE_RUNWAYS_DIR")
    if env:
        return env
    if os.path.isdir("/app/runways"):
        return "/app/runways"
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runways"))


RUNWAYS_DIR = _default_runways_dir()
DEFAULT_GATE_RADIUS_M = 150.0     # race.js CONFIG.DEFAULT_RADIUS_M, for a gate file that omits it

# The public site: race/server/static/{index.html,site.css,site.js}. Always a sibling of this
# file, in the checkout and in the image alike (the Dockerfile COPYs it to /app/static), so unlike
# COURSES_DIR there is no separate image-path fallback to reason about.
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def _default_bookmarklet_path() -> str:
    """Same posture as _default_courses_dir(): an env override, else the image's baked-in copy,
    else the checkout's race/bookmarklet.txt (a local uvicorn run from race/server)."""
    env = os.environ.get("RACE_BOOKMARKLET_PATH")
    if env:
        return env
    if os.path.isfile("/app/bookmarklet.txt"):
        return "/app/bookmarklet.txt"
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bookmarklet.txt"))


def load_bookmarklet(path: str) -> Optional[dict]:
    """The PRIMARY line out of bookmarklet.txt, read once at server start — never hardcoded here,
    so a bookmarklet.txt edit (a new loader pattern, a fixed typo) ships on the next deploy with no
    other change. Returns None if the file is missing or the PRIMARY block can't be found; the
    landing page shows an error state for the install panel rather than a broken bookmark."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        logging.getLogger("uvicorn.error").warning("bookmarklet unreadable at %s: %s", path, e)
        return None
    m = re.search(r"^PRIMARY[^\n]*\n(javascript:\S+)", text, re.MULTILINE)
    if not m:
        logging.getLogger("uvicorn.error").warning("no PRIMARY bookmarklet line found in %s", path)
        return None
    return {"label": "FINSONLY Racing", "href": m.group(1).strip()}


BOOKMARKLET = load_bookmarklet(_default_bookmarklet_path())

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  course_hash TEXT NOT NULL,
  course_name TEXT NOT NULL,
  callsign TEXT NOT NULL,
  aircraft_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  time_ms INTEGER NOT NULL,
  splits TEXT NOT NULL,
  gates INTEGER NOT NULL,
  length_m REAL NOT NULL,
  client_version TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_board ON runs(course_hash, callsign, time_ms);
-- Ghost traces (0.9.0). One row per (course, callsign) holding only that pilot's BEST run on
-- that course; a faster run replaces it. Separate from `runs` on purpose: runs is an append-only
-- log of every attempt and must stay cheap to scan, while a trace is a ~100 KB blob nobody wants
-- loaded to compute a leaderboard. CREATE TABLE IF NOT EXISTS makes this migration a no-op on an
-- existing database, and nothing here alters or reads `runs` rows.
CREATE TABLE IF NOT EXISTS traces (
  course_hash TEXT NOT NULL,
  callsign TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  trace_blob TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (course_hash, callsign)
);
CREATE INDEX IF NOT EXISTS traces_board ON traces(course_hash, time_ms);
-- Lobby race results and cups (0.11.0, proto 4). Written exactly once per finished lobby race, by
-- persist_race() in a worker thread; nothing else in the relay touches SQLite. `races.id` is a
-- database id and has nothing to do with the room's in-memory race_id counter. All of it is
-- CREATE ... IF NOT EXISTS, so re-running this script on a live database (every container start)
-- adds what is missing and leaves every existing row alone.
CREATE TABLE IF NOT EXISTS cups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  name TEXT NOT NULL,
  race_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS cups_room ON cups(room, closed_at);
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  course_hash TEXT NOT NULL,
  course_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  cup_id INTEGER
);
CREATE INDEX IF NOT EXISTS races_cup ON races(cup_id);
CREATE TABLE IF NOT EXISTS race_results (
  race_id INTEGER NOT NULL,
  callsign TEXT NOT NULL,
  pos INTEGER NOT NULL,
  go_time_ms INTEGER,
  status TEXT NOT NULL,
  points INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (race_id, callsign)
);
-- Pilot identity (1.2.0, proto 5). A callsign was a free-text string anyone could type; a
-- pilot_id is a uuid4 the SERVER issues and owns, and a callsign is a display name owned by one
-- pilot_id. The client keeps {pilot_id, pilot_token} in localStorage and presents the token on
-- later connects; the server stores only the token's sha256, so the table is not a list of
-- working credentials. Ownership is keyed on `callsign_key` (casefolded), while `callsign` keeps
-- the display form exactly as typed — every existing read endpoint still keys on callsign and is
-- unchanged by this table. `token_hash IS NULL` marks a row minted by the backfill in migrate():
-- nobody has proved they own it yet, so the first pilot to present that callsign ADOPTS it and
-- inherits its history. After that it is locked, and freeing it is a manual admin UPDATE (see
-- DEPLOY_CHECKLIST.md). The ramp_* columns are the ping-the-ramp cap: they live here rather than
-- in memory so a redeploy cannot refill everyone's daily allowance.
-- Full-race replays (0.7-1.0 series, proto 9). One row per finisher/DNF of a lobby race that
-- submitted a trace on its `finish`/`dnf` frame (see FinishMsg/DnfMsg's optional `trace` field
-- and PROTOCOL.md "Proto 9"). Separate from `traces` on purpose: `traces` is one row per
-- (course_hash, callsign) holding only that pilot's single BEST solo/leaderboard run, while a
-- race_traces row belongs to one specific lobby race_id and there can be many per pilot over
-- time. `time_ms`/`go_elapsed_ms` are the same lobby-clock value (a finisher's go_time_ms, or
-- NULL for a DNF); both columns exist because the task spec that introduced this table named
-- them separately, and keeping both avoids readers guessing which one a client should use.
CREATE TABLE IF NOT EXISTS race_traces (
  race_id INTEGER NOT NULL,
  pilot_id TEXT,
  callsign TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  time_ms INTEGER,
  go_elapsed_ms INTEGER,
  trace_blob TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (race_id, callsign)
);
CREATE INDEX IF NOT EXISTS race_traces_created ON race_traces(created_at);
-- Record history (0.7-1.0 series). One row every time a POST /runs submission beats the current
-- course record (strictly faster than the fastest existing time on that course_hash, across every
-- pilot). Written from post_run(); see record_events_for_run(). prev_holder/prev_time_ms are NULL
-- for a course's first-ever record (nobody held it before).
CREATE TABLE IF NOT EXISTS record_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_hash TEXT NOT NULL,
  pilot_id TEXT,
  callsign TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  prev_holder TEXT,
  prev_time_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS record_events_course ON record_events(course_hash, created_at DESC);
CREATE TABLE IF NOT EXISTS pilots (
  pilot_id     TEXT PRIMARY KEY,
  callsign     TEXT NOT NULL,
  callsign_key TEXT NOT NULL UNIQUE,
  token_hash   TEXT UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL DEFAULT 0,
  ramp_day     TEXT NOT NULL DEFAULT '',
  ramp_count   INTEGER NOT NULL DEFAULT 0,
  last_ramp_ms INTEGER NOT NULL DEFAULT 0
);
"""

_lock = threading.Lock()
_last_post: dict[str, float] = {}


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


# ------------------------------------------------------------------ pilot identity (proto 5)
# Everything the hub does keys on a pilot_id, so this block comes before anything that uses one.
# The pure half (callsign_key/hash_token/ramp_day) is tested with plain values; the conn-taking
# half is tested against the test database with no socket in sight. Nothing here is reached from
# the event loop directly — the hub calls it through asyncio.to_thread, like persist_race().

PILOT_ID_TABLES = ("runs", "traces", "race_results")


def callsign_key(callsign: str) -> str:
    """Pure: the form callsign ownership is keyed on. Casefolded so 'Eric' and 'eric' are one
    pilot rather than two people fighting over the same name on the leaderboard."""
    return (callsign or "").strip().casefold()


# The robot test pilot's ghosts (POST /ghosts/house) are stored under this callsign and pilot_id.
# The name is reserved on every write path -- runs, landings, mode runs, the hub's callsign claim,
# relay join and rename -- so no player can pose as the house, and a house row can never be
# mistaken for a player's. House rows live only in `traces`, which is why no board, record,
# news item, pilot profile or cup ever sees one (they all read runs/race_results/pilots).
HOUSE_CALLSIGN = "HOUSE"
HOUSE_PILOT_ID = "house"
RESERVED_CALLSIGN_KEYS = frozenset({"house"})


def is_reserved_callsign(callsign: str) -> bool:
    """Pure: True for a callsign only the server itself may use (see HOUSE_CALLSIGN)."""
    return callsign_key(callsign) in RESERVED_CALLSIGN_KEYS


def reserved_callsign_error(callsign: str) -> str:
    return f"callsign '{(callsign or '').strip()}' is reserved for the house ghost -- pick another"


def hash_token(token: str) -> str:
    """Pure: what actually goes in the database. The token itself is only ever in flight and in
    the client's localStorage, so a copy of race.db is not a set of working credentials."""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def ramp_day(now_s: float, offset_h: int = -7) -> str:
    """Pure: the local calendar day a ramp ping counts against, as YYYY-MM-DD.

    The cap resets at local midnight UTC-7 rather than UTC, because the point of the cap is that
    you get three pings per *evening* — a UTC reset would land mid-session on the west coast.
    Fixed offset, deliberately: no tz database, and no DST seam to argue with twice a year.
    """
    return _dt.datetime.fromtimestamp(now_s + offset_h * 3600, _dt.timezone.utc).strftime("%Y-%m-%d")


def _table_has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r["name"] == column for r in conn.execute(f"PRAGMA table_info({table})"))


def migrate(conn: sqlite3.Connection) -> None:
    """Additive, idempotent, and run on every container start right after SCHEMA.

    SCHEMA is all CREATE ... IF NOT EXISTS, which cannot add a column to a table that already
    exists — hence this. ALTER TABLE ADD COLUMN is the one migration SQLite does in place and in
    O(1): no row is rewritten, no existing value is touched, and an old app.py reading the same
    file simply never selects the new column. Runs twice in a row with no effect the second time.
    """
    for table in PILOT_ID_TABLES:
        if not _table_has_column(conn, table, "pilot_id"):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN pilot_id TEXT")
    # Backfill: one pilot per distinct casefolded callsign across every table that carries one.
    # token_hash stays NULL — these are unclaimed rows, adoptable by whoever proves the name
    # first (see claim_callsign). INSERT OR IGNORE against the callsign_key UNIQUE index is what
    # makes a re-run a no-op, so this is safe on every restart rather than once ever.
    now = int(time.time())
    union = " UNION ".join(f"SELECT callsign FROM {t}" for t in PILOT_ID_TABLES)
    seen = {r["callsign_key"] for r in conn.execute("SELECT callsign_key FROM pilots")}
    for row in conn.execute(f"SELECT DISTINCT callsign FROM ({union})"):
        key = callsign_key(row["callsign"])
        # A reserved name (the house ghost's traces rows) never becomes an adoptable pilot.
        if not key or key in seen or key in RESERVED_CALLSIGN_KEYS:
            continue
        seen.add(key)
        conn.execute(
            "INSERT OR IGNORE INTO pilots (pilot_id, callsign, callsign_key, token_hash, created_at)"
            " VALUES (?, ?, ?, NULL, ?)",
            (uuid.uuid4().hex, row["callsign"].strip(), key, now))
    for table in PILOT_ID_TABLES:
        conn.execute(
            f"""UPDATE {table} SET pilot_id = (
                    SELECT pilot_id FROM pilots WHERE pilots.callsign_key = lower(trim({table}.callsign)))
                WHERE pilot_id IS NULL""")


def issue_pilot(conn: sqlite3.Connection, callsign: str, now: Optional[int] = None) -> tuple[str, str]:
    """Mint a brand-new pilot and its token. The token is returned exactly once, here — the
    database keeps only its hash, so a lost token cannot be recovered, only replaced."""
    now = int(time.time()) if now is None else now
    pilot_id, token = uuid.uuid4().hex, secrets.token_urlsafe(24)
    conn.execute(
        "INSERT INTO pilots (pilot_id, callsign, callsign_key, token_hash, created_at, last_seen)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (pilot_id, callsign.strip(), callsign_key(callsign), hash_token(token), now, now))
    return pilot_id, token


def resolve_pilot(conn: sqlite3.Connection, token: Optional[str]):
    """Token -> pilot row, or None. A missing or unknown token is NOT an error anywhere in this
    protocol: it just means we have not met this pilot yet, and the caller mints a new one."""
    if not token:
        return None
    return conn.execute("SELECT * FROM pilots WHERE token_hash = ?", (hash_token(token),)).fetchone()


def _pilot_by_callsign(conn: sqlite3.Connection, key: str):
    return conn.execute("SELECT * FROM pilots WHERE callsign_key = ?", (key,)).fetchone()


def _merge_pilot(conn: sqlite3.Connection, src_id: str, dst_id: str) -> None:
    """Fold `src` into `dst` and drop it. Only ever used when a pilot who already has an identity
    adopts an unclaimed backfilled callsign: their history under the new name predates them, so
    the OLD row is the one that goes, and anything already written under the new one is moved
    across rather than orphaned."""
    if src_id == dst_id:
        return
    for table in PILOT_ID_TABLES:
        conn.execute(f"UPDATE {table} SET pilot_id = ? WHERE pilot_id = ?", (dst_id, src_id))
    conn.execute("DELETE FROM pilots WHERE pilot_id = ?", (src_id,))


def claim_callsign(conn: sqlite3.Connection, token: Optional[str], callsign: str,
                   now: Optional[int] = None) -> tuple[Optional[sqlite3.Row], Optional[str], Optional[str]]:
    """The whole of `hello`'s identity step: (pilot row, token to hand back or None, error or None).

    Exactly one of (row, error) is set. The token is returned only when a NEW one was minted, so
    a client that already holds a working token is never told to overwrite it.

    The cases, in the order they are decided:
      * no/unknown token + free callsign      -> mint a new pilot (a missing token is never an error)
      * no/unknown token + UNCLAIMED callsign -> adopt it: bind a fresh token to the existing row,
                                                which is how a pilot whose runs predate 1.2.0 keeps them
      * known token + free callsign           -> rename; the old name is released
      * known token + UNCLAIMED callsign      -> adopt and merge the caller's row into it
      * callsign held by another CLAIMED pilot -> refused, named, and nothing changes
    """
    now = int(time.time()) if now is None else now
    key = callsign_key(callsign)
    if not key:
        return None, None, "callsign cannot be blank"
    if key in RESERVED_CALLSIGN_KEYS:
        return None, None, reserved_callsign_error(callsign)
    me = resolve_pilot(conn, token)
    holder = _pilot_by_callsign(conn, key)
    display = callsign.strip()

    if holder is not None and holder["token_hash"] is not None and (me is None or holder["pilot_id"] != me["pilot_id"]):
        return None, None, f"callsign '{holder['callsign']}' belongs to another pilot — pick another"

    if me is None:
        if holder is None:
            pilot_id, new_token = issue_pilot(conn, display, now)
            return conn.execute("SELECT * FROM pilots WHERE pilot_id = ?", (pilot_id,)).fetchone(), new_token, None
        # Unclaimed backfilled row: whoever proves the name first takes it, history and all.
        new_token = secrets.token_urlsafe(24)
        conn.execute("UPDATE pilots SET token_hash = ?, callsign = ?, last_seen = ? WHERE pilot_id = ?",
                     (hash_token(new_token), display, now, holder["pilot_id"]))
        return conn.execute("SELECT * FROM pilots WHERE pilot_id = ?", (holder["pilot_id"],)).fetchone(), new_token, None

    if holder is not None and holder["pilot_id"] != me["pilot_id"]:
        _merge_pilot(conn, me["pilot_id"], holder["pilot_id"])
        conn.execute("UPDATE pilots SET token_hash = ?, callsign = ?, last_seen = ? WHERE pilot_id = ?",
                     (me["token_hash"], display, now, holder["pilot_id"]))
        return conn.execute("SELECT * FROM pilots WHERE pilot_id = ?", (holder["pilot_id"],)).fetchone(), None, None

    conn.execute("UPDATE pilots SET callsign = ?, callsign_key = ?, last_seen = ? WHERE pilot_id = ?",
                 (display, key, now, me["pilot_id"]))
    return conn.execute("SELECT * FROM pilots WHERE pilot_id = ?", (me["pilot_id"],)).fetchone(), None, None


def ramp_reset_in_s(now_s: float, offset_h: int = -7) -> int:
    """Pure: seconds from `now_s` until the next local-midnight (UTC-7) rollover — what the
    ping-the-ramp cap's refusal names, so "you're out of pings" also says when that stops."""
    shifted = now_s + offset_h * 3600
    next_local_midnight = (int(shifted // 86400) + 1) * 86400
    return int(next_local_midnight - shifted)


def _hm(seconds: int) -> str:
    """Pure: seconds -> 'Xh Ym', dropping the hours once there are none."""
    h, m = divmod(max(0, int(seconds)) // 60, 60)
    return f"{h}h {m}m" if h else f"{m}m"


def sanitize_chat(text: Optional[str], limit: int = 240) -> Optional[str]:
    """Pure: a client's free-text chat line -> what the relay is willing to repeat, or None if
    there is nothing left worth repeating.

    Strips C0/C1 control characters (including newlines and the terminal escapes that make a
    status line lie), collapses whitespace runs, then truncates. Over-length is TRUNCATED rather
    than refused — losing the tail of a long line is friendlier than silently dropping it.

    This deliberately does NOT escape HTML: the relay carries text, and escaping belongs to
    whatever renders it (race.js escapes on render). Escaping here would double-escape there.
    """
    if text is None:
        return None
    # Whitespace controls (newline, tab, CR) become separators — "two\nlines" is two words, not
    # one. Everything else unprintable is simply dropped, so an escape sequence loses its ESC and
    # lands as inert text.
    cleaned = "".join(" " if ch.isspace() else ch for ch in text if ch.isspace() or ch.isprintable())
    return " ".join(cleaned.split())[:limit] or None


def try_ramp_ping(conn: sqlite3.Connection, pilot_id: str, now_s: Optional[float] = None) -> tuple[bool, Optional[str]]:
    """Ping-the-ramp's whole budget, checked and (on success) spent in one call: the 60 s cooldown
    first, then the daily cap, stored ON the pilot row rather than in memory so a redeploy cannot
    hand everyone their three pings back — see PROTOCOL.md and this file's proto-5 constants.
    Returns (ok, error); ok implies the row has already been updated to reflect the spend.
    """
    now_s = time.time() if now_s is None else now_s
    row = conn.execute("SELECT ramp_day, ramp_count, last_ramp_ms FROM pilots WHERE pilot_id = ?",
                       (pilot_id,)).fetchone()
    if row is None:
        return False, "unknown pilot"
    now_ms = int(now_s * 1000)
    if row["last_ramp_ms"] and now_ms - row["last_ramp_ms"] < RAMP_COOLDOWN_S * 1000:
        wait_s = max(1, int((RAMP_COOLDOWN_S * 1000 - (now_ms - row["last_ramp_ms"])) / 1000 + 0.999))
        return False, f"you can ping again in {wait_s}s"
    today = ramp_day(now_s)
    count = row["ramp_count"] if row["ramp_day"] == today else 0
    if count >= RAMP_PING_PER_DAY:
        return False, (f"you're out of ramp pings for today — {RAMP_PING_PER_DAY} more "
                       f"in {_hm(ramp_reset_in_s(now_s))}")
    conn.execute("UPDATE pilots SET ramp_day = ?, ramp_count = ?, last_ramp_ms = ? WHERE pilot_id = ?",
                 (today, count + 1, now_ms, pilot_id))
    return True, None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global STARTED_AT
    STARTED_AT = _dt.datetime.now(_dt.timezone.utc).isoformat()
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        # SCHEMA creates what is missing; migrate() alters what already exists. Both run on every
        # start and both are no-ops the second time — see migrate()'s docstring.
        migrate(conn)
        # Proto 6: mode_runs and its backfill from `runs`. DEPLOY_CHECKLIST.md also runs this by
        # hand before a rebuild; doing it here too means a skipped step cannot break the app.
        migrate_modes(conn)
    # The course catalog the vote draws from and resolves against. An empty one is a broken
    # deploy (the 2026-09-23 "vote offers only surprise-me" night), so it fails startup loudly —
    # uvicorn exits nonzero and redeploy.sh's health poll fails — instead of serving a dead vote.
    n = refresh_courses()
    print(f"courses loaded: {n} from {COURSES_DIR}", flush=True)
    print(f"runways loaded: {len(RUNWAYS)} from {RUNWAYS_DIR}", flush=True)
    if n == 0:
        raise RuntimeError(f"no courses loaded from {COURSES_DIR} (set RACE_COURSES_DIR)")
    yield


app = FastAPI(title="FINSONLY Racing", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS,
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type", "Authorization"])
# Traces are long runs of small numbers in columnar JSON — they compress by roughly 10x, which is
# the difference between a ghost download being unnoticeable and being a visible stall on a
# home connection. Everything else this API returns is tiny and falls under the 1 KB threshold.
app.add_middleware(GZipMiddleware, minimum_size=1024)


class RunIn(BaseModel):
    course_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")
    course_hash: str = Field(pattern=r"^[0-9a-f]{8}$")
    course_name: str = Field(min_length=1, max_length=48)
    callsign: str = Field(min_length=1, max_length=32)
    aircraft_id: str = Field(default="", max_length=32)
    model: str = Field(default="", max_length=32)
    time_ms: int = Field(gt=0, le=6 * 3600 * 1000)
    splits: list[int] = Field(min_length=1, max_length=200)
    gates: int = Field(ge=2, le=201)
    length_m: float = Field(gt=0, le=5_000_000)
    client_version: str = Field(default="", max_length=16)
    # The recorded run, in race.js's columnar encoding. Typed loosely on purpose: a malformed
    # trace must NOT 422 the whole submission (that would lose a real race result over a
    # cosmetic payload), so it is validated separately by validate_trace() and dropped with a
    # reason. See post_run() and the traces section below.
    trace: Optional[dict] = None

    @model_validator(mode="after")
    def plausible(self):
        self.callsign = self.callsign.strip()
        if not self.callsign:
            raise ValueError("callsign is blank")
        if is_reserved_callsign(self.callsign):
            raise ValueError(reserved_callsign_error(self.callsign))
        if len(self.splits) != self.gates - 1:
            raise ValueError("splits must have one entry per gate after the start")
        if any(b < a for a, b in zip(self.splits, self.splits[1:])) or self.splits[0] < 0:
            raise ValueError("splits must be non-negative and increasing")
        if self.splits[-1] != self.time_ms:
            raise ValueError("last split must equal time_ms")
        # 0.8 slack: gates are entered at their edge, not their centre
        if self.time_ms / 1000 < 0.8 * self.length_m / MAX_SPEED_MS:
            raise ValueError("time is faster than the aircraft speed limit allows")
        return self


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else ""))[:64]


def board_rows(conn: sqlite3.Connection, course_hash: str, limit: int) -> list[dict]:
    # SQLite returns the bare columns from the MIN() row.
    rows = conn.execute(
        """SELECT callsign, MIN(time_ms) AS time_ms, model, aircraft_id, created_at, COUNT(*) AS attempts
           FROM runs WHERE course_hash = ? GROUP BY callsign ORDER BY time_ms, created_at LIMIT ?""",
        (course_hash, limit)).fetchall()
    # has_ghost drives the client's "Ghost" picker: one entry per pilot who actually has a trace
    # on this course. One cheap query for the whole page rather than a per-row EXISTS.
    with_ghosts = {r[0] for r in conn.execute(
        "SELECT callsign FROM traces WHERE course_hash = ?", (course_hash,)).fetchall()}
    out = []
    for r in rows:
        d = dict(r)
        d["has_ghost"] = d["callsign"] in with_ghosts
        out.append(d)
    return out


# ---------------------------------------------------------------- traces (ghosts)
# A trace is one recorded run in race.js's columnar wire format (see its "trace recorder (pure)"
# section): {v, n, t, lat, lon, alt, hdg, pitch, roll}, t delta-encoded. It rides along on
# POST /runs and comes back out of GET /ghost so a pilot can race someone else's line.
#
# A trace is a nicety, never a gate on the run itself: anything wrong with it drops the trace and
# still records the time, with a reason in the response. That is deliberate — the alternative is
# a 422 that loses a real race result over a cosmetic payload.
MAX_TRACE_SAMPLES = 6000
MAX_TRACE_BYTES = 400 * 1024
TRACE_TIME_TOLERANCE_MS = 500   # the last sample must land this close to the finish
TRACE_ENC_V = 1
TRACE_COLS = ("t", "lat", "lon", "alt", "hdg", "pitch", "roll")


def decode_trace(enc) -> list[tuple]:
    """Columnar encoded trace -> [(t, lat, lon, alt, hdg, pitch, roll), ...].

    Pure, and strict: raises ValueError with a human reason on anything malformed. This is the
    only path an untrusted trace takes into the server, so it validates shape, ranges, and the
    strictly-increasing clock rather than trusting the client that produced it.
    """
    if not isinstance(enc, dict):
        raise ValueError("trace is not an object")
    if enc.get("v") != TRACE_ENC_V:
        raise ValueError(f"unknown trace version {enc.get('v')!r}")
    cols = []
    for name in TRACE_COLS:
        col = enc.get(name)
        if not isinstance(col, list):
            raise ValueError(f"trace column {name} is missing or not a list")
        cols.append(col)
    n = len(cols[0])
    if any(len(c) != n for c in cols):
        raise ValueError("trace columns have different lengths")
    if "n" in enc and enc["n"] != n:
        raise ValueError("trace n does not match its columns")
    if n < 2:
        raise ValueError("trace has fewer than 2 samples")
    if n > MAX_TRACE_SAMPLES:
        raise ValueError(f"trace has {n} samples (max {MAX_TRACE_SAMPLES})")
    rows, t = [], 0.0
    for i in range(n):
        vals = []
        for c in cols:
            v = c[i]
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise ValueError(f"trace sample {i} has a non-finite value")
            vals.append(float(v))
        t = vals[0] if i == 0 else t + vals[0]
        lat, lon, alt = vals[1], vals[2], vals[3]
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            raise ValueError(f"trace sample {i} is outside the world")
        if not (-1000 <= alt <= 100000):
            raise ValueError(f"trace sample {i} has an implausible altitude")
        if t < 0:
            raise ValueError("trace time goes negative")
        if rows and t <= rows[-1][0]:
            raise ValueError("trace time is not strictly increasing")
        rows.append((t, lat, lon, alt, vals[4], vals[5], vals[6]))
    return rows


def validate_trace(enc, time_ms: int) -> tuple[Optional[str], Optional[str]]:
    """(blob, None) if this trace may be stored, else (None, reason).

    Beyond decode_trace's structural checks: the trace has to belong to the run it arrived with
    (its last sample lands within TRACE_TIME_TOLERANCE_MS of the finish), it has to describe a
    flight rather than a series of teleports (implied speed under MAX_SPEED_MS), and it has to
    fit in a row (MAX_TRACE_BYTES).
    """
    try:
        rows = decode_trace(enc)
    except ValueError as e:
        return None, str(e)
    if abs(rows[-1][0] - time_ms) > TRACE_TIME_TOLERANCE_MS:
        return None, (f"trace ends at {int(rows[-1][0])} ms but the run took {time_ms} ms "
                      f"(tolerance {TRACE_TIME_TOLERANCE_MS} ms)")
    for i in range(1, len(rows)):
        a, b = rows[i - 1], rows[i]
        dt = (b[0] - a[0]) / 1000.0
        horiz = _meters_between(a[1], a[2], b[1], b[2])
        dist = math.hypot(horiz, b[3] - a[3])
        if dist / dt > MAX_SPEED_MS:
            return None, f"trace sample {i} implies {int(dist / dt)} m/s, over the speed limit"
    blob = json.dumps(enc, separators=(",", ":"))
    if len(blob.encode("utf-8")) > MAX_TRACE_BYTES:
        return None, f"encoded trace is over {MAX_TRACE_BYTES // 1024} KB"
    return blob, None


def validate_lobby_trace(enc, expected_time_ms: Optional[int]) -> Optional[str]:
    """A `finish`/`dnf` frame's optional trace (proto 9) -> a storable blob, or None if it's
    missing or invalid. Reuses decode_trace()'s structural/range/monotonic-clock checks and the
    same speed-limit and byte-size checks validate_trace() applies to a POST /runs trace. Unlike
    that path, a lobby trace never blocks anything (the finish/dnf itself is already decided by
    the time this runs) and, for a DNF, there is no finish time to check the trace's end against
    (`expected_time_ms` is None in that case — a DNF trace just has to be well-formed).
    """
    if enc is None:
        return None
    try:
        rows = decode_trace(enc)
    except ValueError:
        return None
    if expected_time_ms is not None and abs(rows[-1][0] - expected_time_ms) > TRACE_TIME_TOLERANCE_MS:
        return None
    for i in range(1, len(rows)):
        a, b = rows[i - 1], rows[i]
        dt = (b[0] - a[0]) / 1000.0
        horiz = _meters_between(a[1], a[2], b[1], b[2])
        dist = math.hypot(horiz, b[3] - a[3])
        if dt <= 0 or dist / dt > MAX_SPEED_MS:
            return None
    blob = json.dumps(enc, separators=(",", ":"))
    if len(blob.encode("utf-8")) > MAX_TRACE_BYTES:
        return None
    return blob


def store_trace(conn: sqlite3.Connection, run: "RunIn", blob: str, now: int) -> bool:
    """Keep only each callsign's best trace per course. Returns whether this one was kept."""
    prev = conn.execute(
        "SELECT time_ms FROM traces WHERE course_hash = ? AND callsign = ?",
        (run.course_hash, run.callsign)).fetchone()
    if prev is not None and prev[0] <= run.time_ms:
        return False
    conn.execute(
        """INSERT INTO traces (course_hash, callsign, time_ms, model, trace_blob, created_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(course_hash, callsign) DO UPDATE SET
             time_ms = excluded.time_ms, model = excluded.model,
             trace_blob = excluded.trace_blob, created_at = excluded.created_at""",
        (run.course_hash, run.callsign, run.time_ms, run.model, blob, now))
    return True


@app.get("/health")
def health():
    return {"ok": True, "courses": len(COURSES)}


@app.get("/version")
def version():
    """Public, unauthenticated — checked from any browser after a deploy (DEPLOY_CHECKLIST.md).
    `sha` is baked in at image build time and is "unknown" for a local run with no build behind it."""
    return {"sha": GIT_SHA, "version": SERVER_VERSION, "proto": PROTO, "courses": len(COURSES),
            "started_at": STARTED_AT}


def _post_rate_limit(ip: str, now: float) -> None:
    """One submission per MIN_INTERVAL_S per IP, shared by POST /runs and every mode's POST."""
    with _lock:
        if now - _last_post.get(ip, 0) < MIN_INTERVAL_S:
            raise HTTPException(429, "Too many submissions; wait a few seconds.")
        _last_post[ip] = now
        if len(_last_post) > 5000:
            _last_post.clear()


# ---------------------------------------------------------------- landing-page reads (/stats,
# /rooms/live). Both are polled every few seconds by every open tab of the public site, so they
# get a shared in-memory TTL cache (a handful of seconds is invisible on a homepage tile but
# collapses N pollers into one real computation) and a much more generous per-IP rate gate than
# POST /runs -- several friends behind the same home IP polling in parallel must not 429 each
# other.
_get_cache: dict[str, tuple[float, object]] = {}
_last_get: dict[str, float] = {}
GET_CACHE_TTL_S = 8.0
GET_MIN_INTERVAL_S = float(os.environ.get("RACE_GET_MIN_INTERVAL_S", "1.0"))


def _cached(key: str, ttl: float, build) -> object:
    with _lock:
        hit = _get_cache.get(key)
        now = time.monotonic()
        if hit is not None and now - hit[0] < ttl:
            return hit[1]
    value = build()
    with _lock:
        _get_cache[key] = (time.monotonic(), value)
    return value


def _get_rate_limit(ip: str, now: float) -> None:
    with _lock:
        if now - _last_get.get(ip, 0) < GET_MIN_INTERVAL_S:
            raise HTTPException(429, "Too many requests; slow down.")
        _last_get[ip] = now
        if len(_last_get) > 5000:
            _last_get.clear()


def _course_record_holder(conn: sqlite3.Connection, course_hash: str) -> Optional[sqlite3.Row]:
    """The current fastest callsign on a course, or None if nobody has a time yet. Same
    definition board_rows() uses for rank 1: fastest time, ties broken by earliest created_at."""
    return conn.execute(
        """SELECT callsign, MIN(time_ms) AS time_ms FROM runs WHERE course_hash = ?
           GROUP BY callsign ORDER BY time_ms, created_at LIMIT 1""", (course_hash,)).fetchone()


def record_events_for_run(conn: sqlite3.Connection, run: "RunIn", now: int) -> None:
    """Insert a record_events row if `run` is a new course record — strictly faster than the
    fastest existing time on run.course_hash, across every pilot. Must be called BEFORE `run` is
    inserted into `runs`, so `_course_record_holder` reflects the field this run is racing
    against, not itself. A tie does not beat the record and writes nothing.
    """
    prev = _course_record_holder(conn, run.course_hash)
    if prev is not None and run.time_ms >= prev["time_ms"]:
        return
    pid = conn.execute("SELECT pilot_id FROM pilots WHERE callsign_key = ?",
                       (callsign_key(run.callsign),)).fetchone()
    conn.execute(
        """INSERT INTO record_events (course_hash, pilot_id, callsign, time_ms, prev_holder,
               prev_time_ms, created_at) VALUES (?,?,?,?,?,?,?)""",
        (run.course_hash, pid[0] if pid else None, run.callsign, run.time_ms,
         prev["callsign"] if prev is not None else None,
         prev["time_ms"] if prev is not None else None, now))


@app.post("/runs")
def post_run(run: RunIn, request: Request):
    ip = client_ip(request)
    now = time.time()
    _post_rate_limit(ip, now)
    trace_saved, trace_reason = False, None
    with connect() as conn:
        prev_best = conn.execute(
            "SELECT MIN(time_ms) FROM runs WHERE course_hash = ? AND callsign = ?",
            (run.course_hash, run.callsign)).fetchone()[0]
        # Must run before the INSERT below: it reads the record this run is racing against.
        record_events_for_run(conn, run, int(now))
        cur = conn.execute(
            """INSERT INTO runs (course_id, course_hash, course_name, callsign, aircraft_id, model,
               time_ms, splits, gates, length_m, client_version, ip, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (run.course_id, run.course_hash, run.course_name, run.callsign, run.aircraft_id, run.model,
             run.time_ms, json.dumps(run.splits), run.gates, run.length_m, run.client_version, ip, int(now)))
        # Proto 6: the same run as a 'race' row in mode_runs, in the same transaction, tagged with
        # its legacy id so the migrate_modes() backfill can never copy it a second time.
        insert_mode_run(conn, "race", run.callsign, run.course_id, run.course_hash, run.time_ms,
                        race_payload(run.splits, run.gates, run.length_m, run.model, run.aircraft_id),
                        int(now), legacy_run_id=cur.lastrowid)
        # The trace is entirely optional and never blocks the run: a bad one is dropped with a
        # reason the client can show, and the time is recorded either way.
        if run.trace is not None:
            blob, trace_reason = validate_trace(run.trace, run.time_ms)
            if blob is not None:
                trace_saved = store_trace(conn, run, blob, int(now))
                if not trace_saved:
                    trace_reason = "an existing trace for this pilot on this course is faster"
        best = min(run.time_ms, prev_best) if prev_best is not None else run.time_ms
        faster = conn.execute(
            """SELECT COUNT(*) FROM (SELECT MIN(time_ms) AS m FROM runs
               WHERE course_hash = ? GROUP BY callsign) WHERE m < ?""",
            (run.course_hash, best)).fetchone()[0]
    return {"id": cur.lastrowid, "rank": faster + 1, "personal_best": best,
            "improved": prev_best is None or run.time_ms < prev_best,
            "trace_saved": trace_saved, "trace_reason": trace_reason}


@app.get("/leaderboard")
def leaderboard(course_hash: str = Query(pattern=r"^[0-9a-f]{8}$"), limit: int = Query(10, ge=1, le=100)):
    with connect() as conn:
        return board_rows(conn, course_hash, limit)


@app.get("/records/history")
def records_history(course_hash: str = Query(pattern=r"^[0-9a-f]{8}$"),
                    limit: int = Query(20, ge=1, le=200)):
    """Every time this course's record changed hands, newest first. An unknown/never-raced
    course_hash is simply an empty list, matching /leaderboard's posture for the same case."""
    with connect() as conn:
        rows = conn.execute(
            """SELECT course_hash, callsign, time_ms, prev_holder, prev_time_ms, created_at
               FROM record_events WHERE course_hash = ? ORDER BY created_at DESC, id DESC LIMIT ?""",
            (course_hash, limit)).fetchall()
    return [dict(r) for r in rows]


# ------------------------------------------------------------------ modes (proto 6)
# A mode is anything with one number to rank on. It declares that number's name, which way is
# better, and the shape of the payload that rides along with it. `race` is the original time
# trial: its runs still arrive on POST /runs and are still ranked by GET /leaderboard from the
# legacy `runs` table, both unchanged; POST /runs now ALSO writes a mode_runs row so the generic
# board below agrees with the old one. Every other mode posts to /modes/{id}/runs and only ever
# lands in mode_runs, so nothing that reads `runs` can see it.
#
# Direction is never assumed. Every mode_runs ranking query takes its aggregate, its ORDER BY and
# its "strictly better" comparison from direction_sql(), which maps the two legal directions onto
# fixed SQL keywords — nothing a client sends is ever interpolated into SQL.

class RacePayload(BaseModel):
    """What a 'race' row keeps beyond its time (see migrate_modes.race_payload)."""
    splits: list[int]
    gates: int
    length_m: float
    model: str = ""
    aircraft_id: str = ""


class TouchdownEventIn(BaseModel):
    """race/touchdown.js's `touchdown` event, exactly as the detector emits it — that module owns
    this shape. Ranges are generous plausibility bounds; score_touchdown() is what judges it.
    centerline_offset_m/distance_from_threshold_m are accepted but never read: the server
    recomputes both from lat/lon against its own runway def."""
    type: Literal["touchdown"] = "touchdown"
    t_ms: float = Field(ge=0)
    vs_at_contact: float = Field(ge=-50, le=50)     # m/s, negative on descent
    ias: Optional[float] = Field(default=None, ge=0, le=500)
    bank: float = Field(ge=-180, le=180)
    pitch: Optional[float] = Field(default=None, ge=-90, le=90)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    heading_deg: float = Field(ge=-360, le=360)
    centerline_offset_m: Optional[float] = None
    distance_from_threshold_m: Optional[float] = None


class LandingPayload(BaseModel):
    """What a 'landing' row keeps: the raw detector output it was scored from, and the server's
    breakdown of that score. Written only by POST /landings, never taken from a client."""
    model_config = ConfigDict(extra="forbid")
    runway_id: str
    runway_version: int
    touchdown: TouchdownEventIn
    bounce_count: int = Field(ge=0, le=20)
    total_rollout_m: float = Field(ge=0, le=20000)
    breakdown: dict
    model: str = ""
    aircraft_id: str = ""


@dataclass(frozen=True)
class ModeSpec:
    id: str
    metric_name: str
    direction: Literal["asc", "desc"]       # asc = lower is better, desc = higher is better
    payload_model: type
    metric_min: float
    metric_max: float


MODES: dict[str, ModeSpec] = {
    "race": ModeSpec("race", "elapsed_ms", "asc", RacePayload, 1, 6 * 3600 * 1000),
    "landing": ModeSpec("landing", "score", "desc", LandingPayload, 0, 1000),
}
DEFAULT_MODE = "race"
# Modes whose runs arrive on their own endpoint, never on POST /modes/{id}/runs.
_OWN_WRITE_PATH = {"race": "POST /runs", "landing": "POST /landings"}

_DIRECTION_SQL = {"asc": ("MIN", "ASC", "<"), "desc": ("MAX", "DESC", ">")}


def direction_sql(direction: str) -> tuple[str, str, str]:
    """Pure: (best-of aggregate, ORDER BY keyword, strictly-better operator) for a direction."""
    if direction not in _DIRECTION_SQL:
        raise ValueError(f"unknown direction {direction!r}")
    return _DIRECTION_SQL[direction]


def is_better(direction: str, a: float, b: Optional[float]) -> bool:
    """Pure: is `a` strictly better than `b` (None = no previous value) under `direction`?"""
    if b is None:
        return True
    return a < b if direction_sql(direction)[2] == "<" else a > b


def insert_mode_run(conn: sqlite3.Connection, mode_id: str, callsign: str, course_id: str,
                    course_hash: str, metric_value: float, payload_json: str, created_at: int,
                    legacy_run_id: Optional[int] = None) -> int:
    mode = MODES[mode_id]
    # pilot_id is resolved from the callsign's owner if it has one, exactly as migrate() does for
    # legacy rows; an unclaimed callsign stays NULL here and is filled by no one, same as `runs`.
    pid = conn.execute("SELECT pilot_id FROM pilots WHERE callsign_key = ?",
                       (callsign_key(callsign),)).fetchone()
    cur = conn.execute(
        """INSERT INTO mode_runs (pilot_id, callsign, course_id, course_hash, mode_id, metric_value,
               direction, payload_json, created_at, legacy_run_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (pid[0] if pid else None, callsign, course_id, course_hash, mode_id, metric_value,
         mode.direction, payload_json, created_at, legacy_run_id))
    return cur.lastrowid


def mode_personal_best(conn: sqlite3.Connection, mode_id: str, course_hash: str,
                       callsign: str) -> Optional[float]:
    agg, _, _ = direction_sql(MODES[mode_id].direction)
    return conn.execute(
        f"SELECT {agg}(metric_value) FROM mode_runs WHERE mode_id = ? AND course_hash = ? AND callsign = ?",
        (mode_id, course_hash, callsign)).fetchone()[0]


def mode_rank(conn: sqlite3.Connection, mode_id: str, course_hash: str, best: float) -> int:
    """1 + the number of pilots whose best on this course is strictly better than `best`."""
    agg, _, better = direction_sql(MODES[mode_id].direction)
    ahead = conn.execute(
        f"""SELECT COUNT(*) FROM (SELECT {agg}(metric_value) AS m FROM mode_runs
            WHERE mode_id = ? AND course_hash = ? GROUP BY callsign) WHERE m {better} ?""",
        (mode_id, course_hash, best)).fetchone()[0]
    return ahead + 1


def mode_board_rows(conn: sqlite3.Connection, mode_id: str, course_hash: str, limit: int) -> list[dict]:
    """Each pilot's best on this course in this mode, best first; ties go to whoever got there
    first. Grouped by callsign like the legacy board, so the two agree on a race course. No
    pilot_id: no public endpoint has ever returned one, and a board is not the place to start."""
    mode = MODES[mode_id]
    agg, order, _ = direction_sql(mode.direction)
    # SQLite returns the bare columns from the row the MIN()/MAX() picked.
    rows = conn.execute(
        f"""SELECT callsign, {agg}(metric_value) AS metric_value, created_at,
                   COUNT(*) AS attempts
            FROM mode_runs WHERE mode_id = ? AND course_hash = ?
            GROUP BY callsign ORDER BY metric_value {order}, created_at ASC LIMIT ?""",
        (mode_id, course_hash, limit)).fetchall()
    return [{"rank": i + 1, **dict(r)} for i, r in enumerate(rows)]


class ModeRunIn(BaseModel):
    course_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")
    course_hash: str = Field(pattern=r"^[0-9a-f]{8}$")
    callsign: str = Field(min_length=1, max_length=32)
    metric_value: float
    payload: dict
    client_version: str = Field(default="", max_length=16)

    @model_validator(mode="after")
    def plausible(self):
        self.callsign = self.callsign.strip()
        if not self.callsign:
            raise ValueError("callsign is blank")
        if is_reserved_callsign(self.callsign):
            raise ValueError(reserved_callsign_error(self.callsign))
        if not math.isfinite(self.metric_value):
            raise ValueError("metric_value must be finite")
        return self


def _mode_or_404(mode_id: str) -> ModeSpec:
    mode = MODES.get(mode_id)
    if mode is None:
        raise HTTPException(404, f"unknown mode {mode_id!r}")
    return mode


@app.get("/modes")
def list_modes():
    return [{"id": m.id, "metric_name": m.metric_name, "direction": m.direction,
             "metric_min": m.metric_min, "metric_max": m.metric_max,
             "payload_schema": m.payload_model.model_json_schema()} for m in MODES.values()]


@app.post("/modes/{mode_id}/runs")
def post_mode_run(mode_id: str, body: ModeRunIn, request: Request):
    mode = _mode_or_404(mode_id)
    if mode.id in _OWN_WRITE_PATH:
        # One write path for race runs, so the legacy table and mode_runs cannot drift apart; one
        # for landings, because their score is computed server-side and never taken from a client.
        raise HTTPException(400, f"{mode.id} runs are submitted to {_OWN_WRITE_PATH[mode.id]}")
    if not mode.metric_min <= body.metric_value <= mode.metric_max:
        raise HTTPException(422, f"{mode.metric_name} must be between {mode.metric_min:g} and {mode.metric_max:g}")
    try:
        payload = mode.payload_model.model_validate(body.payload)
    except ValidationError as e:
        raise HTTPException(422, f"payload: {e.errors(include_url=False, include_context=False)}"[:500])
    now = time.time()
    _post_rate_limit(client_ip(request), now)
    with connect() as conn:
        prev = mode_personal_best(conn, mode.id, body.course_hash, body.callsign)
        run_id = insert_mode_run(conn, mode.id, body.callsign, body.course_id, body.course_hash,
                                 body.metric_value, payload.model_dump_json(), int(now))
        improved = is_better(mode.direction, body.metric_value, prev)
        best = body.metric_value if improved else prev
        rank = mode_rank(conn, mode.id, body.course_hash, best)
    return {"id": run_id, "mode": mode.id, "metric_name": mode.metric_name, "rank": rank,
            "personal_best": best, "improved": improved}


@app.get("/modes/{mode_id}/leaderboard")
def mode_leaderboard(mode_id: str, course_hash: str = Query(pattern=r"^[0-9a-f]{8}$"),
                     limit: int = Query(10, ge=1, le=100)):
    mode = _mode_or_404(mode_id)
    with connect() as conn:
        rows = mode_board_rows(conn, mode.id, course_hash, limit)
    return {"mode": mode.id, "metric_name": mode.metric_name, "direction": mode.direction,
            "course_hash": course_hash, "rows": rows}


@app.get("/ghost")
def ghost(course_hash: str = Query(pattern=r"^[0-9a-f]{8}$"),
          callsign: Optional[str] = Query(default=None, max_length=32)):
    """One pilot's best trace on a course, or the course record holder's when callsign is omitted.

    "Course record holder" here means the fastest pilot who actually has a trace, not the fastest
    time on the board — someone can hold the record from before traces existed, or with traces
    turned off, and 404ing in that case would be less useful than handing back the best ghost
    that does exist.
    """
    with connect() as conn:
        if callsign:
            row = conn.execute(
                """SELECT callsign, time_ms, model, trace_blob, created_at, pilot_id FROM traces
                   WHERE course_hash = ? AND callsign = ?""", (course_hash, callsign.strip())).fetchone()
        else:
            # A player's ghost always wins "record holder"; the house ghost (POST /ghosts/house)
            # is the fallback for a course nobody has a trace on yet, never the record.
            row = conn.execute(
                """SELECT callsign, time_ms, model, trace_blob, created_at, pilot_id FROM traces
                   WHERE course_hash = ? ORDER BY (pilot_id IS ?), time_ms, created_at LIMIT 1""",
                (course_hash, HOUSE_PILOT_ID)).fetchone()
    if row is None:
        raise HTTPException(404, "No ghost recorded for that course yet.")
    return {"course_hash": course_hash, "callsign": row["callsign"], "time_ms": row["time_ms"],
            "model": row["model"], "created_at": row["created_at"],
            "is_house": row["pilot_id"] == HOUSE_PILOT_ID, "trace": json.loads(row["trace_blob"])}


@app.get("/ghosts")
def ghosts_list(course_hash: str = Query(pattern=r"^[0-9a-f]{8}$")):
    """Every ghost recorded on a course, fastest first — the picker behind "race a friend's ghost"
    (0.12.0). Reuses the same `traces` table /ghost already reads; this is just the index over it,
    not a new kind of row. `is_course_record` marks the fastest entry, same definition /ghost uses
    for "course record holder": the fastest pilot who actually has a trace, not the fastest time on
    the board.

    The house ghost (POST /ghosts/house) is listed with `is_house: true` wherever its time puts
    it, and is never `is_course_record`: that goes to the fastest PLAYER ghost.
    """
    with connect() as conn:
        rows = conn.execute(
            """SELECT callsign, time_ms, model, created_at, pilot_id FROM traces
               WHERE course_hash = ? ORDER BY time_ms, created_at""", (course_hash,)).fetchall()
    record = next((i for i, r in enumerate(rows) if r["pilot_id"] != HOUSE_PILOT_ID), None)
    return [{"callsign": r["callsign"], "time_ms": r["time_ms"], "model": r["model"],
             "recorded_at": r["created_at"], "is_course_record": i == record,
             "is_house": r["pilot_id"] == HOUSE_PILOT_ID} for i, r in enumerate(rows)]


# ------------------------------------------------------------------ house ghost (admin)
# The robot test pilot (race/tools/robot_pilot.js) flies a course on the autopilot and, on a
# PASS, can upload its trace as the course's House ghost: a reference line anyone can race, that
# is on no board. Stored in `traces` under HOUSE_CALLSIGN / HOUSE_PILOT_ID, so /ghosts and
# /ghost?callsign=HOUSE serve it and the site's replay picks it up, while every board, record,
# medal, news item, pilot page and cup (all of which read runs/race_results/pilots) never sees it.

def require_admin(request: Request) -> None:
    """401 unless the request carries `Authorization: Bearer <RACE_ADMIN_TOKEN>`; 503 when the
    server has no token configured at all. Constant-time compare."""
    if not ADMIN_TOKEN:
        raise HTTPException(503, "Admin routes are off: RACE_ADMIN_TOKEN is not set on this server.")
    auth = request.headers.get("authorization", "")
    tok = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
    if not tok or not hmac.compare_digest(tok.encode("utf-8"), ADMIN_TOKEN.encode("utf-8")):
        raise HTTPException(401, "A valid admin token is required.")


class HouseGhostIn(BaseModel):
    course_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")
    course_hash: str = Field(pattern=r"^[0-9a-f]{8}$")
    time_ms: int = Field(gt=0, le=6 * 3600 * 1000)
    model: str = Field(default="", max_length=32)
    trace: dict
    force: bool = False   # replace the stored house ghost even when this one is slower


@app.post("/ghosts/house")
def post_house_ghost(body: HouseGhostIn, request: Request):
    """Admin: store a robot-flown trace as a course's House ghost, which is on no board."""
    require_admin(request)
    course = next((c for c in COURSES if c["course_id"] == body.course_id), None)
    if course is None:
        raise HTTPException(404, f"Unknown course {body.course_id!r}")
    if course["course_hash"] != body.course_hash:
        raise HTTPException(409, f"course_hash {body.course_hash} is not the current version of "
                                 f"{body.course_id} ({course['course_hash']})")
    if body.time_ms / 1000 < 0.8 * course["length_km"] * 1000 / MAX_SPEED_MS:
        raise HTTPException(422, "time is faster than the aircraft speed limit allows")
    blob, reason = validate_trace(body.trace, body.time_ms)
    if blob is None:
        raise HTTPException(422, f"trace rejected: {reason}")
    now = int(time.time())
    with connect() as conn:
        clash = conn.execute(
            """SELECT callsign FROM traces WHERE course_hash = ? AND lower(trim(callsign)) = ?
               AND (pilot_id IS NULL OR pilot_id != ?)""",
            (body.course_hash, callsign_key(HOUSE_CALLSIGN), HOUSE_PILOT_ID)).fetchone()
        if clash is not None:
            raise HTTPException(409, f"a player's ghost is already stored as {clash['callsign']!r} on this course")
        prev = conn.execute("SELECT time_ms FROM traces WHERE course_hash = ? AND callsign = ?",
                            (body.course_hash, HOUSE_CALLSIGN)).fetchone()
        if prev is not None and prev["time_ms"] <= body.time_ms and not body.force:
            return {"saved": False, "course_hash": body.course_hash, "time_ms": prev["time_ms"],
                    "reason": "the stored house ghost is as fast or faster (send force: true to replace it)"}
        conn.execute(
            """INSERT INTO traces (course_hash, callsign, time_ms, model, trace_blob, created_at, pilot_id)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(course_hash, callsign) DO UPDATE SET
                 time_ms = excluded.time_ms, model = excluded.model, trace_blob = excluded.trace_blob,
                 created_at = excluded.created_at, pilot_id = excluded.pilot_id""",
            (body.course_hash, HOUSE_CALLSIGN, body.time_ms, body.model, blob, now, HOUSE_PILOT_ID))
    return {"saved": True, "course_hash": body.course_hash, "time_ms": body.time_ms,
            "replaced": prev["time_ms"] if prev is not None else None}


@app.get("/news")
def news(callsign: str = Query(min_length=1, max_length=32),
         since: int = Query(0, ge=0)):
    """Courses where `callsign`'s personal best has been beaten by someone else's run posted after
    `since` (a unix-seconds timestamp, matching `runs.created_at`). Replaces a Teams webhook with an
    in-game check: the client polls this on load with its own last-seen timestamp (race/README.md
    "Race a friend's ghost"). Read-only — the only write to `runs` is POST /runs.

    "Beat" is evaluated against `callsign`'s CURRENT best on the board, not a running history: for
    each course they have a time on, this looks for the fastest run by anyone else that is faster
    than that current best and was posted after `since`. Only that one (fastest, i.e. most relevant)
    beat is reported per course, newest first.
    """
    callsign = callsign.strip()
    with connect() as conn:
        mine = conn.execute(
            """SELECT course_hash, course_id, course_name, MIN(time_ms) AS my_time_ms
               FROM runs WHERE callsign = ? GROUP BY course_hash""", (callsign,)).fetchall()
        out = []
        for m in mine:
            beat = conn.execute(
                """SELECT callsign, time_ms, created_at FROM runs
                   WHERE course_hash = ? AND callsign != ? AND created_at > ? AND time_ms < ?
                   ORDER BY time_ms ASC LIMIT 1""",
                (m["course_hash"], callsign, since, m["my_time_ms"])).fetchone()
            if beat is not None:
                out.append({
                    "course_hash": m["course_hash"], "course_id": m["course_id"], "course_name": m["course_name"],
                    "beaten_by": beat["callsign"], "their_time_ms": beat["time_ms"],
                    "your_time_ms": m["my_time_ms"], "margin_ms": m["my_time_ms"] - beat["time_ms"],
                    "at": beat["created_at"],
                })
    out.sort(key=lambda r: -r["at"])
    return out


@app.get("/courses")
def courses():
    """Courses that have at least one time, newest activity first — so the landing page's hero
    replay can take element 0 as "the course with the most recent record" with no extra query.

    `cup`/`difficulty`/`length_km`/`gates` are joined in from the shared catalog (COURSES) by
    course_id when that course is still in it; a course_id no longer in the catalog (renamed,
    removed) just gets nulls/an empty gate list rather than a missing row — the DB row is the
    source of truth for what has been raced, the catalog only decorates it.
    """
    by_id = {c["course_id"]: c for c in COURSES}
    with connect() as conn:
        rows = conn.execute(
            """SELECT course_hash, course_id, course_name, COUNT(DISTINCT callsign) AS racers,
                      MIN(time_ms) AS record_ms, MAX(created_at) AS last_run
               FROM runs GROUP BY course_hash ORDER BY last_run DESC LIMIT 100""").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            meta = by_id.get(d["course_id"], {})
            d["cup"] = meta.get("cup")
            d["difficulty"] = meta.get("difficulty")
            d["length_km"] = meta.get("length_km")
            d["gate_coords"] = meta.get("gate_coords", [])
            out.append(d)
        return out


@app.get("/courses/catalog")
def courses_catalog():
    """The full shared course list — raced or not — for the landing page's per-cup course-record
    tabs (which need a card, map and difficulty chip even for a course with zero runs so far).
    `/courses` stays "courses that have at least one time"; this is everything in COURSES."""
    with connect() as conn:
        return course_catalog(conn)


# ===================================================================================
# Landing mode scoring — server-side, headless-testable. score_touchdown() turns race/touchdown.js's
# raw `touchdown` event (plus the bounce count and settled rollout from that module's `bounce` and
# `settled` events) and a runway def into a score; it is exercised in test_server.py with plain
# dicts, no sim, no socket, no DB. The client posts raw detector output only — LandingAttemptIn
# has no `score` field, so a client that sends one anyway has it silently dropped by pydantic, and
# post_landing() always calls score_touchdown() itself. Likewise the event's own
# centerline_offset_m/distance_from_threshold_m are ignored: offsets are recomputed here from
# lat/lon. A client can lie about its own trajectory (nothing here has GeoFS's terrain to check it
# against, same limitation `runs` has for course_hash/length_m), but it can never hand the server
# a number and have that number win.
#
# Results are proto 6 mode_runs rows (mode_id='landing', course_id=runway id, course_hash =
# runway_hash()), so they rank through the same direction_sql() machinery as every other mode.
#
# Runways are loaded from race/runways/*.json (RUNWAYS_DIR: RACE_RUNWAYS_DIR, else the image's
# /app/runways snapshot, else the checkout) by load_runways(), exactly like courses: index.json
# names the files, a broken entry is skipped with a warning, and the image bakes a snapshot that
# the deploy mounts the checkout's race/runways over read-only. EMBEDDED_RUNWAYS below is only the
# fallback for a missing/empty directory (an old deploy that never mounted it), so the three
# launch runways keep scoring either way. Both use race/touchdown.js's runway field names
# (thr_lat, thr_lon, heading_deg, length_m, width_m) plus the scoring extras (id, name, version,
# thr_alt_m, zone). runway_hash() is id+version only, so moving a runway from the embedded dict
# to a file (or back) never resets its board. test_server.py's drift test keeps the embedded
# three byte-identical to their files.
LANDING_MAX_SCORE = 1000
LANDING_MIN_SCORE = 0

# Vertical speed at contact — the dominant term: nothing else below is weighted anywhere close
# to LANDING_VS_WEIGHT. vs_mps is negative on descent; anything softer than the ideal band is a
# free "greaser" and costs nothing at all.
LANDING_VS_IDEAL_ABS_MPS = 0.5
LANDING_VS_WEIGHT = 60.0
LANDING_VS_EXPONENT = 1.6            # superlinear: a hard landing costs disproportionately more

# Centerline offset — symmetric, left and right cost exactly the same.
LANDING_CENTERLINE_WEIGHT_PER_M = 1.2
LANDING_CENTERLINE_MAX_PENALTY = 220.0

# Distance from the runway's touchdown zone (runway["zone"]) — penalizes short AND long,
# symmetric around the zone rather than around the threshold itself.
LANDING_ZONE_WEIGHT_PER_M = 0.6
LANDING_ZONE_MAX_PENALTY = 260.0

# Bank and crab (heading vs runway heading) at contact.
LANDING_BANK_WEIGHT_PER_DEG = 4.0
LANDING_CRAB_WEIGHT_PER_DEG = 3.0
LANDING_BANK_CRAB_MAX_PENALTY = 200.0

# Bounces — flat and deliberately uncapped: LANDING_BOUNCE_PENALTY per bounce means every
# additional bounce always costs more, never absorbed by a per-component ceiling.
LANDING_BOUNCE_PENALTY = 70.0

# Rollout — free up to LANDING_ROLLOUT_SAFE_FRACTION of the runway remaining past the touchdown
# point; beyond that it costs, which is what makes touching down deep into a SHORT runway (little
# left to use) the expensive mistake, rather than penalizing a long rollout on a long runway.
LANDING_ROLLOUT_SAFE_FRACTION = 0.6
LANDING_ROLLOUT_WEIGHT = 500.0
LANDING_ROLLOUT_MAX_PENALTY = 260.0
LANDING_ROLLOUT_MIN_REMAINING_M = 30.0   # floor on the remaining-runway denominator, avoids /~0

# Seed runways (task: "one wide/forgiving, one short, one with terrain on approach"). `zone` is
# the touchdown aim zone LANDING_ZONE_* scores against; `notes` is documentation only, never read
# by score_touchdown(). Coordinates/geometry are real-airport-plausible, not surveyed — same
# posture the hand-placed course gates take (see race/README.md's course status notes).
EMBEDDED_RUNWAYS = {
    "sea-tac-16c": {
        "id": "sea-tac-16c",
        "name": "Sea-Tac 16C (wide, forgiving)",
        "version": 1,
        "thr_lat": 47.4318,
        "thr_lon": -122.3082,
        "thr_alt_m": 130.0,
        "heading_deg": 162.0,
        "length_m": 3627.0,
        "width_m": 45.0,
        "zone": {"min_m": 150.0, "max_m": 450.0},
        "notes": "Long, wide, flat approach — the forgiving one.",
    },
    "friday-harbor-16": {
        "id": "friday-harbor-16",
        "name": "Friday Harbor 16 (short)",
        "version": 1,
        "thr_lat": 48.5223,
        "thr_lon": -123.0247,
        "thr_alt_m": 37.0,
        "heading_deg": 160.0,
        "length_m": 1036.0,
        "width_m": 23.0,
        "zone": {"min_m": 60.0, "max_m": 200.0},
        "notes": "Short island strip — a long touchdown eats the rollout margin fast.",
    },
    "sisters-eagle-air-34": {
        "id": "sisters-eagle-air-34",
        "name": "Sisters Eagle Air 34 (terrain on approach)",
        "version": 1,
        "thr_lat": 44.3389,
        "thr_lon": -121.5537,
        "thr_alt_m": 987.0,
        "heading_deg": 340.0,
        "length_m": 792.0,
        "width_m": 18.0,
        "zone": {"min_m": 50.0, "max_m": 160.0},
        "notes": "Grass strip under the Three Sisters — terrain crowds the approach.",
    },
}


RUNWAY_ID_RE = re.compile(r"^[a-z0-9-]{1,64}$")


def validate_runway(raw) -> dict:
    """Pure: a race/runways/*.json object -> the same dict, or ValueError naming what's wrong.
    Only what score_touchdown()/runway_hash() read is required; `notes` and anything else pass
    through untouched."""
    if not isinstance(raw, dict):
        raise ValueError("not an object")
    rid = raw.get("id")
    if not isinstance(rid, str) or not RUNWAY_ID_RE.match(rid):
        raise ValueError(f"bad id {rid!r}")
    if not isinstance(raw.get("name"), str) or not raw["name"].strip():
        raise ValueError("name must be a non-empty string")
    if not isinstance(raw.get("version"), int) or isinstance(raw.get("version"), bool) or raw["version"] < 1:
        raise ValueError("version must be an integer >= 1")
    for key, lo, hi in (("thr_lat", -90, 90), ("thr_lon", -180, 180), ("thr_alt_m", -500, 9000),
                        ("heading_deg", 0, 360), ("length_m", 50, 10000), ("width_m", 5, 200)):
        v = raw.get(key)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi:
            raise ValueError(f"{key} must be a number in [{lo}, {hi}]")
    zone = raw.get("zone")
    if not isinstance(zone, dict):
        raise ValueError("zone must be an object")
    zmin, zmax = zone.get("min_m"), zone.get("max_m")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (zmin, zmax)) \
            or not 0 <= zmin < zmax <= raw["length_m"]:
        raise ValueError("zone needs 0 <= min_m < max_m <= length_m")
    return raw


def load_runways(path: str) -> dict:
    """race/runways/index.json plus each file it names -> {id: runway}. A broken entry is skipped
    with a warning (never takes the others down); an entry whose file id disagrees with the index
    is skipped too. A missing directory, unreadable index or zero valid runways falls back to a
    copy of EMBEDDED_RUNWAYS, so an old deploy without the mount still scores the launch three."""
    try:
        with open(os.path.join(path, "index.json"), encoding="utf-8") as f:
            index = json.load(f)
    except (OSError, ValueError) as e:
        logging.getLogger("uvicorn.error").warning("runway index unreadable at %s (%s); using the embedded runways", path, e)
        return {k: dict(v) for k, v in EMBEDDED_RUNWAYS.items()}
    out = {}
    for entry in index if isinstance(index, list) else []:
        try:
            with open(os.path.join(path, os.path.basename(entry["file"])), encoding="utf-8") as f:
                raw = validate_runway(json.load(f))
            if raw["id"] != entry["id"]:
                raise ValueError(f"file id {raw['id']!r} != index id {entry['id']!r}")
            if raw["id"] in out:
                raise ValueError("duplicate id")
            out[raw["id"]] = raw
        except (OSError, ValueError, KeyError, TypeError) as e:
            logging.getLogger("uvicorn.error").warning("runway %r skipped: %s", entry, e)
    if not out:
        logging.getLogger("uvicorn.error").warning("no runways loaded from %s; using the embedded runways", path)
        return {k: dict(v) for k, v in EMBEDDED_RUNWAYS.items()}
    return out


RUNWAYS = load_runways(RUNWAYS_DIR)


def runway_hash(runway: dict) -> str:
    """Pure: the 8-hex course_hash a runway's landing board is keyed on in mode_runs. Derived from
    id and version, so bumping `version` after re-tuning a runway's geometry starts a fresh board
    (the same thing a changed course_hash does for a race course)."""
    return hashlib.sha256(f"runway:{runway['id']}:{runway['version']}".encode("utf-8")).hexdigest()[:8]


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Pure: initial great-circle bearing from point 1 to point 2, 0-360 clockwise from north —
    the inverse of offset_point() paired with _meters_between()."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    x = math.sin(dlon) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def _angle_diff_deg(a: float, b: float) -> float:
    """Pure: a - b, wrapped to (-180, 180]."""
    return ((a - b + 180.0) % 360.0) - 180.0


def runway_offsets_m(runway: dict, lat: float, lon: float) -> tuple[float, float]:
    """Pure: (along_m, cross_m) of a point relative to a runway's threshold and heading.
    along_m runs positive down the centerline from the threshold; cross_m is signed, positive to
    the right of the landing heading — the same convention as touchdown.js's runwayOffsets().
    Flat-earth, same precision posture as _meters_between."""
    dist = _meters_between(runway["thr_lat"], runway["thr_lon"], lat, lon)
    if dist < 1e-9:
        return 0.0, 0.0
    bearing = _bearing_deg(runway["thr_lat"], runway["thr_lon"], lat, lon)
    rel = math.radians(bearing - runway["heading_deg"])
    return dist * math.cos(rel), dist * math.sin(rel)


def score_touchdown(touchdown: dict, runway: dict, bounce_count: int = 0,
                    total_rollout_m: float = 0.0) -> dict:
    """Pure: a touchdown -> {"score": 0-1000 (higher better), "breakdown": {...}}.

    touchdown: race/touchdown.js's `touchdown` event (vs_at_contact, bank, lat, lon, heading_deg
      are read; its own centerline_offset_m/distance_from_threshold_m never are).
    runway: a RUNWAYS entry (or the equivalent race/runways/*.json shape).
    bounce_count: how many `bounce` events followed it; total_rollout_m: its `settled` event's.

    Starts at LANDING_MAX_SCORE and subtracts every component's penalty (see the CONFIG block
    above this function for every constant used here); the total is only clamped to
    [LANDING_MIN_SCORE, LANDING_MAX_SCORE] at the very end, so it is each penalty's own cap that
    actually keeps one bad component from single-handedly zeroing the score.
    """
    along_m, cross_m = runway_offsets_m(runway, touchdown["lat"], touchdown["lon"])
    crab_deg = _angle_diff_deg(touchdown["heading_deg"], runway["heading_deg"])

    vs_over = max(0.0, abs(touchdown["vs_at_contact"]) - LANDING_VS_IDEAL_ABS_MPS)
    vs_penalty = LANDING_VS_WEIGHT * (vs_over ** LANDING_VS_EXPONENT)

    centerline_penalty = min(LANDING_CENTERLINE_MAX_PENALTY,
                              LANDING_CENTERLINE_WEIGHT_PER_M * abs(cross_m))

    zone = runway["zone"]
    zone_miss_m = max(0.0, zone["min_m"] - along_m) + max(0.0, along_m - zone["max_m"])
    zone_penalty = min(LANDING_ZONE_MAX_PENALTY, LANDING_ZONE_WEIGHT_PER_M * zone_miss_m)

    bank_crab_penalty = min(
        LANDING_BANK_CRAB_MAX_PENALTY,
        LANDING_BANK_WEIGHT_PER_DEG * abs(touchdown["bank"]) +
        LANDING_CRAB_WEIGHT_PER_DEG * abs(crab_deg))

    bounce_penalty = LANDING_BOUNCE_PENALTY * max(0, int(bounce_count))

    remaining_m = max(LANDING_ROLLOUT_MIN_REMAINING_M, runway["length_m"] - along_m)
    rollout_over = max(0.0, total_rollout_m / remaining_m - LANDING_ROLLOUT_SAFE_FRACTION)
    rollout_penalty = min(LANDING_ROLLOUT_MAX_PENALTY, LANDING_ROLLOUT_WEIGHT * rollout_over)

    breakdown = {
        "vs_penalty": round(vs_penalty, 2),
        "centerline_penalty": round(centerline_penalty, 2),
        "zone_penalty": round(zone_penalty, 2),
        "bank_crab_penalty": round(bank_crab_penalty, 2),
        "bounce_penalty": round(bounce_penalty, 2),
        "rollout_penalty": round(rollout_penalty, 2),
        "along_m": round(along_m, 2),
        "cross_m": round(cross_m, 2),
        "crab_deg": round(crab_deg, 2),
    }
    penalty_total = sum(v for k, v in breakdown.items() if k.endswith("_penalty"))
    score = max(LANDING_MIN_SCORE, min(LANDING_MAX_SCORE, round(LANDING_MAX_SCORE - penalty_total)))
    return {"score": score, "breakdown": breakdown}


class LandingAttemptIn(BaseModel):
    runway_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")
    callsign: str = Field(min_length=1, max_length=32)
    aircraft_id: str = Field(default="", max_length=32)
    model: str = Field(default="", max_length=32)
    client_version: str = Field(default="", max_length=16)
    touchdown: TouchdownEventIn                        # touchdown.js's `touchdown` event, verbatim
    bounce_count: int = Field(default=0, ge=0, le=20)  # count of its `bounce` events
    total_rollout_m: float = Field(ge=0, le=20000)     # its `settled` event's total_rollout_m
    # Deliberately no `score` field. A client that sends one anyway is sent through pydantic's
    # default "ignore unknown fields" behavior — see post_landing(), which never reads it either.

    @model_validator(mode="after")
    def plausible(self):
        self.callsign = self.callsign.strip()
        if not self.callsign:
            raise ValueError("callsign is blank")
        if is_reserved_callsign(self.callsign):
            raise ValueError(reserved_callsign_error(self.callsign))
        return self


def _runway_or_404(runway_id: str) -> dict:
    runway = RUNWAYS.get(runway_id)
    if runway is None:
        raise HTTPException(404, f"Unknown runway {runway_id!r}")
    return runway


@app.post("/landings")
def post_landing(attempt: LandingAttemptIn, request: Request):
    runway = _runway_or_404(attempt.runway_id)
    now = time.time()
    _post_rate_limit(client_ip(request), now)
    result = score_touchdown(attempt.touchdown.model_dump(), runway,
                             attempt.bounce_count, attempt.total_rollout_m)
    payload = LandingPayload(runway_id=runway["id"], runway_version=runway["version"],
                             touchdown=attempt.touchdown, bounce_count=attempt.bounce_count,
                             total_rollout_m=attempt.total_rollout_m, breakdown=result["breakdown"],
                             model=attempt.model, aircraft_id=attempt.aircraft_id)
    chash = runway_hash(runway)
    with connect() as conn:
        prev = mode_personal_best(conn, "landing", chash, attempt.callsign)
        run_id = insert_mode_run(conn, "landing", attempt.callsign, runway["id"], chash,
                                 result["score"], payload.model_dump_json(), int(now))
        improved = is_better("desc", result["score"], prev)
        best = result["score"] if improved else prev
        rank = mode_rank(conn, "landing", chash, best)
    return {"id": run_id, "mode": "landing", "course_hash": chash, "rank": rank,
            "personal_best": best, "improved": improved,
            "score": result["score"], "breakdown": result["breakdown"]}


@app.get("/landing-leaderboard")
def landing_leaderboard(runway_id: str = Query(pattern=r"^[a-z0-9-]+$"), limit: int = Query(10, ge=1, le=100)):
    """A runway's board by id — the same rows GET /modes/landing/leaderboard?course_hash= returns."""
    runway = _runway_or_404(runway_id)
    chash = runway_hash(runway)
    with connect() as conn:
        rows = mode_board_rows(conn, "landing", chash, limit)
    return {"mode": "landing", "runway_id": runway_id, "course_hash": chash, "rows": rows}


RUNWAY_PUBLIC_FIELDS = ("id", "name", "thr_lat", "thr_lon", "thr_alt_m", "heading_deg", "length_m", "width_m")


@app.get("/runways")
def runways_list():
    """Every loaded landing runway's geometry, by id — what race.js's Practice approach spawns from."""
    return [{k: r.get(k) for k in RUNWAY_PUBLIC_FIELDS} for _, r in sorted(RUNWAYS.items())]


# ===================================================================================
# Powerups relay (Phase 2 of race.js's Powerups feature — see race/README.md once its
# "Powerups" section is written). Ephemeral, in-memory, no DB: a room is one race session,
# gone on server restart or when its last player disconnects. This is deliberately NOT the
# leaderboard's trust model in reverse — the relay is authoritative for the box roll (which
# item, weighted by live race position) and for targeting offensive items; a client can only
# ever report its own position/progress, that it crossed the box, and that it fired whatever
# it was actually granted. See race.js's Powerups module for the client half.
#
# Trust-model choice this file makes (documented per the design note asking to pick one):
# Shield WAS purely the victim's own client's business — the relay had no reason to track a
# self-only defensive timer just to gate a message it would send to that same client anyway.
# Proto 3 changed that, and only because the hit stopped being instant: a missile now lands
# flight_ms after it is fired, so "was the shield up?" is a question about a moment the relay
# is the only one that can pin down, and it is the whole point of the flight time that popping
# a shield mid-flight works. So the relay now keeps a shield WINDOW, opened by the victim's own
# `fx` frame and capped at SHIELD_MS. It still never invents one, and the victim's client still
# honors its own shield on receipt as well — which is what keeps a pre-proto-3 client correct.
#
# Proto 2 adds the lobby (see race/PROTOCOL.md): the room, not a Teams message and five local
# clocks, decides when a race starts. The relay stays the only authority for anything a client
# could lie about — who is host, who is ready, what the course is, and the one server clock
# every countdown is measured against. It still keeps none of it: a lobby is in-memory like the
# rest of the room, and a restart drops it.
#
# Proto 3 adds the ITEMS layer: every offensive item becomes something you can see coming. A
# missile is no longer an instant server-side hit — it is a `fired` frame everyone renders as a
# projectile and a hit that resolves flight_ms later, which is what gives the victim a window to
# pop a shield. A banana is a real object in the world with a list, a TTL and an arming delay,
# tripped by whichever client actually flew into it (2 Hz `pos` pings tunnel straight through a
# 75 m sphere at race speed), validated here against that client's last known position. Boost and
# Shield get a cosmetic `fx` frame so everyone can see them. The trust model is unchanged in
# substance: the relay still picks the item and the target, and the only thing it now takes a
# client's word for is that client's own shield and its own "I flew into that banana".
ROOM_PATTERN = re.compile(r"^[a-z0-9-]{1,32}$")
PROTO = 9                       # the integer `joined` advertises; clients gate features on it
LOBBY_PROTO = 2                 # the proto the lobby (above) arrived in — kept for documentation
ITEMS_PROTO = 3                 # …and the one the items layer below needs
RESULTS_PROTO = 4               # …and results + cups (the "results" section further down)
HUB_PROTO = 5                   # …and the hub, identity, chat, spectating and the course vote
MODES_PROTO = 6                 # …and a room's mode (join.mode / joined.mode; see "modes" above)
RENAME_PROTO = 7                # …and the in-room `rename` frame (see the ws_race handler)
FORMATION_PROTO = 8             # …and the FORMATION rolling-start phase (see "Rolling start" below)
# Fixed enum, not free text: quick-chat is for racing with your hands on the stick, and a closed
# set means the relay can never be used to relay arbitrary strings between clients.
CHAT_CODES = ("ready_soon", "need_2_min", "gg", "rematch", "brb", "boss_incoming")
MIN_LEAD_S, MAX_LEAD_S = 5, 60
MAX_WS_MSG_BYTES = 2048
WS_RATE_LIMIT_PER_S = int(os.environ.get("RACE_WS_RATE_PER_S", "20"))
WS_MAX_VIOLATIONS = 20          # repeated flooding beyond the rate limit closes the socket
BANANA_RADIUS_M = 75.0          # roughly one gate-radius; matches this project's casual precision

# ---- items layer (proto 3)
MAX_BOXES = 24                  # per course; mirrors race.js's Course.normalizeItemBoxes()
BOX_RESPAWN_S = 6.0             # a taken box is dark this long, for everyone — boxes are contested
MAX_BANANAS = 8                 # per room; the oldest is evicted (and `cleared`) past this
BANANA_TTL_S = 120.0            # a banana nobody hits expires rather than littering the course
BANANA_ARM_MS = 1500            # …and cannot hit anyone until this long after the drop
BANANA_DROP_BACK_M = 150.0      # dropped this far BEHIND the shooter, along the reverse heading
TRIP_SLACK_M = 400.0            # a client's `tripped` claim must be within radius + this
SHIELD_MS = 6000                # CONFIG.POWERUP_SHIELD_MS in race.js; the cap on an fx shield claim
FX_MIN_INTERVAL_MS = 2000       # one cosmetic fx frame per player per this window
WORLD_MIN_INTERVAL_S = 0.5      # `world` is coalesced to at most 2/s per room, not sent per `pos`
PROJECTILE_SPEED_MS = 250.0     # what a missile/goop "flies" at, for the telegraphed flight time
FLIGHT_CLAMP_MS = {"missile": (1500, 4000), "goop": (1000, 3000)}

# ---- results and cups (proto 4)
RESULTS_TIMEOUT_S = 120         # after the FIRST finisher, this long for everyone else; then DNF
FINISH_TOLERANCE_MS = 3000      # a finish's go_time_ms must be this close to what the relay's clock says
JUMP_START_PENALTY_MS = 5000    # CONFIG.JUMP_START_PENALTY_MS in race.js; already inside a jump-starter's go_time_ms
POINTS_TABLE = (15, 12, 10, 8, 6, 4, 2, 1)   # by finishing position; a DNF, or 9th and below, scores 0
CUP_NAME_MAX = 32
CUP_MAX_RACES = 12
OFFENSIVE_ITEMS = ("banana", "goop", "missile")
MAX_SPLITS = 200                # mirrors RunIn.splits

# ------------------------------------------------------------------ hub and friends (proto 5)
# The matchmaking hub is a SECOND socket (/ws/hub). Race rooms are unchanged by it: a pilot can
# still type a code and fly without ever opening the hub, which is what keeps every 1.1.0 client
# working. All hub state is in-memory — the only thing proto 5 puts on disk is pilot identity.
ROOM_MAX_PILOTS = int(os.environ.get("RACE_ROOM_MAX_PILOTS", "12"))
HUB_HEARTBEAT_S = 5.0           # the client's ~0.2 Hz heartbeat period
HUB_MISS_LIMIT = 2              # dropped off the presence list after this many are missed…
HUB_DROP_S = HUB_HEARTBEAT_S * (HUB_MISS_LIMIT + 1)   # …i.e. this long without one, with a grace beat
HUB_PUSH_MIN_S = 1.0            # presence/rooms are coalesced to at most one push per second per client
HUB_TICK_S = 1.0                # the single hub loop: flushes coalesced pushes and reaps stale clients
REGISTRY_TTL_S = 600            # a room's code and host survive this long after its last pilot leaves
RAMP_PING_PER_DAY = int(os.environ.get("RACE_RAMP_PING_PER_DAY", "3"))
RAMP_COOLDOWN_S = 60            # …and no more than one per minute regardless of the daily budget
RAMP_DAY_OFFSET_H = -7          # the cap resets at local midnight UTC-7, not UTC (see ramp_day)
CHAT_MAX_CHARS = 240            # free-text lobby chat, truncated rather than refused
CHAT_RATE_PER_S = float(os.environ.get("RACE_CHAT_RATE_PER_S", "2"))
# ---- rolling start / FORMATION (proto 8). The pace lap's speed and how long before green the
# leader leaves the holding oval — see race/PROTOCOL.md "Proto 8" and formationBuildTrack in
# race.js. Both overridable per deploy without a client update.
RACE_FORMATION_PACE_KT = int(os.environ.get("RACE_FORMATION_PACE_KT", "180"))
RACE_FORMATION_PACE_S = int(os.environ.get("RACE_FORMATION_PACE_S", "60"))   # kept for the docs' "default 60 s pace"; the client derives its own exit/gap timing from PACE_KT
RACE_FORMATION_LATE_CUTOFF_S = 10   # a ready during formation this close to green is refused, not queued
CHAT_BURST = 4                  # a short burst is fine; a sustained stream is not
HUB_ACTIVITIES = ("idle", "gate", "racing", "solo")
VOTE_CANDIDATES = 3             # plus the surprise-me wildcard
SURPRISE_ME = "surprise-me"     # the wildcard course_id; resolved to a real course at launch


def flight_ms_for(item: str, distance_m: float) -> int:
    """Pure: how long a fired projectile is in the air. Distance over PROJECTILE_SPEED_MS,
    clamped per item so a point-blank shot still telegraphs and a long one still lands."""
    lo, hi = FLIGHT_CLAMP_MS.get(item, FLIGHT_CLAMP_MS["missile"])
    d = distance_m if isinstance(distance_m, (int, float)) and distance_m == distance_m else 0.0
    return int(max(lo, min(hi, max(0.0, d) / PROJECTILE_SPEED_MS * 1000.0)))


def offset_point(lat: float, lon: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    """Pure: flat-earth offset, the inverse of _meters_between() and good to the same precision.
    Used for exactly one thing — putting a banana BANANA_DROP_BACK_M behind its dropper."""
    r = 6371000.0
    br = math.radians(bearing_deg)
    dlat = (dist_m * math.cos(br)) / r
    mlat = math.radians(lat + math.degrees(dlat) / 2)
    dlon = (dist_m * math.sin(br)) / (r * max(1e-6, math.cos(mlat)))
    return (max(-90.0, min(90.0, lat + math.degrees(dlat))),
            ((lon + math.degrees(dlon) + 540.0) % 360.0) - 180.0)

ITEMS = ["nothing", "banana", "goop", "boost", "missile"]

# Position-weighted catch-up table (README "Powerups" explains this to players). Anchors are
# hand-picked, each summing to 100; weights_for_rank() interpolates between them by normalized
# rank so there's no hard cliff between e.g. "midfield" and "last".
#
# Retuned in 0.10.0, because the shape of the game changed under it: a course now has a row of
# boxes roughly every third gate instead of one box per lap, so every number here is drawn four
# or five times a race rather than once. At the old weights that made the leader's 45% "nothing"
# into being starved out of the item game entirely, and last place's 50% missile into a hose.
# The catch-up gradient is still the point — the expected value of a roll still rises strictly
# from leader to last, which is what test_roll_item_weighting_favors_the_back_of_the_pack pins —
# it is just measured over several rolls now instead of one.
_LEADER = {"nothing": 30, "banana": 45, "goop": 15, "boost": 10, "missile": 0}
_MIDFIELD = {"nothing": 5, "banana": 20, "goop": 25, "boost": 30, "missile": 20}
_LAST = {"nothing": 0, "banana": 10, "goop": 15, "boost": 35, "missile": 40}


def weights_for_rank(rank: int, n_players: int) -> dict[str, float]:
    """Pure: 0-indexed rank (0 = leader) among n_players -> item weights. Never socket-dependent."""
    n = max(1, n_players)
    frac = 0.0 if n <= 1 else max(0.0, min(1.0, rank / (n - 1)))
    if frac <= 0.5:
        t, a, b = frac / 0.5, _LEADER, _MIDFIELD
    else:
        t, a, b = (frac - 0.5) / 0.5, _MIDFIELD, _LAST
    return {k: a[k] + (b[k] - a[k]) * t for k in ITEMS}


def roll_item(rank: int, n_players: int, rng=None) -> str:
    """Pure given a supplied rng (defaults to the `random` module): weighted sample of ITEMS."""
    rng = rng or random
    weights = weights_for_rank(rank, n_players)
    total = sum(weights.values())
    x = rng.uniform(0, total)
    upto = 0.0
    for item in ITEMS:
        upto += weights[item]
        if x <= upto:
            return item
    return ITEMS[-1]


def _meters_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Flat-earth approximation — plenty at gate-radius scale, matching this project's
    friend-group precision posture (race.js's own ecef() is the precise WGS84 version used
    client-side for actual gate detection)."""
    r = 6371000.0
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    mlat = math.radians((lat1 + lat2) / 2)
    return r * math.hypot(dlon * math.cos(mlat), dlat)


class JoinMsg(BaseModel):
    type: Literal["join"]
    callsign: str = Field(min_length=1, max_length=32)
    room: Optional[str] = Field(default=None, max_length=32)
    # Proto 5, additive and soft: present it and future work can attribute this player's own
    # progress to a pilot_id; omit it (any client before 1.2.0 always does) and this join works
    # exactly as it always has, unowned. Not resolved against the database here — nothing in this
    # session reads a pilot_id off a race-room Player yet, so there is nothing to look up for.
    # Its PRESENCE is also read as this connection's proof of speaking proto 5 (Player.proto5,
    # the same role `alt` plays for proto3) — see ChatMsg below, which is the one place that
    # currently matters for.
    pilot_token: Optional[str] = Field(default=None, max_length=128)
    # Proto 5: "I am here to watch, not to race." An OPT-IN spectator is excluded from the
    # ranking, the grid, the results and the room's pilot cap, and is refused pos/box/fire.
    # Distinct from the role a MID-RACE joiner already gets automatically (proto 2), whose
    # behavior is deliberately left exactly as it was — see the join handler.
    spectate: bool = False
    # Proto 6: which mode this room plays (a key of MODES). Omitted — which every client before
    # proto 6 does — means 'race', so an old client's join is exactly what it always was.
    mode: Optional[str] = Field(default=None, max_length=16)
    # Lobby reliability pass, additive: the proto the CLIENT speaks. A value >= 5 marks the
    # connection proto 5 on the spot, so free-text chat reaches a pilot whose join raced ahead of
    # the hub (no pilot_token yet) — before this, that pilot never received a typed line. Omitted
    # by every older client, which keeps the conservative pilot_token rule below.
    client_proto: Optional[int] = Field(default=None, ge=0, le=1000)

    @model_validator(mode="after")
    def not_reserved(self):
        if is_reserved_callsign(self.callsign):
            raise ValueError(reserved_callsign_error(self.callsign))
        return self


class PosMsg(BaseModel):
    type: Literal["pos"]
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    gate: int = Field(ge=0, le=201)
    elapsed_ms: int = Field(ge=0, le=6 * 3600 * 1000)
    # Proto 3, additive and optional: an old client omits it and every altitude-aware effect just
    # places itself at the ground. Its presence is also how the relay recognizes a proto-3 client
    # (see _check_banana) — a client that sends `alt` does its own banana detection.
    alt: Optional[float] = Field(default=None, ge=-500, le=100000)


class BoxMsg(BaseModel):
    type: Literal["box"]
    # Proto 3: which of the course's itemBoxes. An old client omits it and means box 0, which is
    # exactly what the legacy single `itemBox` normalizes to.
    id: int = Field(default=0, ge=0, le=MAX_BOXES - 1)


class FireMsg(BaseModel):
    type: Literal["fire"]
    item: Literal["banana", "goop", "missile"]  # offensive, box-only items — never "boost"/"nothing"
    # Proto 3, additive: the shooter's heading, so the server can put a banana behind them rather
    # than under them. Omitted by an old client, which drops the banana exactly where it is.
    heading: Optional[float] = Field(default=None, ge=0, le=360)


class FxMsg(BaseModel):
    """Proto 3: 'my Boost/Shield just lit up'. Cosmetic authority only — the one exception is
    that a shield fx opens the window _resolve_projectile() checks, and a shield the relay never
    saw light up can therefore never block anything."""
    type: Literal["fx"]
    item: Literal["boost", "shield"]
    ms: int = Field(ge=0, le=30000)


class TrippedMsg(BaseModel):
    """Proto 3: 'I flew into banana <id>'. Detection moved client-side because 2 Hz `pos` pings
    tunnel straight through a 75 m sphere at race speed; the relay still validates the claim
    against that client's own last known position before honoring it."""
    type: Literal["tripped"]
    id: int = Field(ge=0)


class PingMsg(BaseModel):
    type: Literal["ping"]
    t0: float  # echoed back untouched; the client's own clock, never interpreted here


class HelloMsg(BaseModel):
    type: Literal["hello"]
    model: str = Field(default="", max_length=32)


class ReadyMsg(BaseModel):
    type: Literal["ready"]
    ready: bool


class CourseMsg(BaseModel):
    type: Literal["course"]
    course_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")
    course_hash: str = Field(pattern=r"^[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=48)
    start_type: Literal["ground", "air"]
    # Proto 5, additive: the course's gate count, for the registry's "gate N of M" status line.
    # Optional — a 1.1.0 host omits it and the line just reads "gate N" with no total.
    gates: Optional[int] = Field(default=None, ge=1, le=201)


class RulesMsg(BaseModel):
    type: Literal["rules"]
    powerups: bool
    teleport: bool
    # Proto 8, additive: a rolling start (FORMATION phase, below) instead of the static grid,
    # for an air-start course. Defaults True so an old client's rules{} (which never sends
    # this key) still gets it — the phase is only ever offered when every racer's OWN
    # connection also proved FORMATION_PROTO, so an old client can never actually receive a
    # `formation` frame it wouldn't understand; this flag is the host's opt-out, not a
    # compatibility gate.
    rolling: bool = True


class StartMsg(BaseModel):
    type: Literal["start"]
    lead_s: int = Field(ge=MIN_LEAD_S, le=MAX_LEAD_S)
    force: bool = False


class AbortMsg(BaseModel):
    type: Literal["abort"]


class FormationDropMsg(BaseModel):
    """Proto 8: this pilot's autopilot disengaged during the pace lap without a `formation_drop`
    sender ever having crossed the start line — see the FORMATION phase below. The server moves
    them to the back of the order and rebroadcasts `formation`. No DQ; they can rejoin the
    formation at the back at any point before green."""
    type: Literal["formation_drop"]


class ChatMsg(BaseModel):
    type: Literal["chat"]
    # Two shapes on one frame name, on purpose: proto 2 already shipped `chat{code}` (a fixed
    # enum) broadcast as `chat{callsign, code}`, and that path is completely unchanged below.
    # Proto 5 adds `chat{text}` (free text, sanitized, truncated) broadcast as `chat{from, text}`
    # — a different shape so an old client, which only ever looks for `callsign`/`code`, can
    # never mistake one for the other. Exactly one of the two must be present.
    code: Optional[Literal[CHAT_CODES]] = None  # type: ignore[valid-type]
    text: Optional[str] = Field(default=None, max_length=CHAT_MAX_CHARS * 4)  # generous pre-sanitize cap

    @model_validator(mode="after")
    def exactly_one(self):
        if (self.code is None) == (self.text is None):
            raise ValueError("chat needs exactly one of code or text")
        return self


class VoteMsg(BaseModel):
    type: Literal["vote"]
    # One of the room's drawn candidates, or SURPRISE_ME. Anything else is refused by the handler
    # (not by validation) so the error can say what the candidates actually are.
    course_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")


class BackToLobbyMsg(BaseModel):
    type: Literal["back_to_lobby"]


_MS = Annotated[int, Field(ge=0, le=6 * 3600 * 1000)]


class FinishMsg(BaseModel):
    """Proto 4: 'I crossed the last gate'. `go_time_ms` is on the lobby-race clock (measured from
    the synced GO, jump-start penalty included), NOT the leaderboard's gate-1 clock; the relay
    checks it against its own clock before believing it — see finish_time_ok()."""
    type: Literal["finish"]
    race_id: int = Field(ge=0)
    go_time_ms: int = Field(gt=0, le=6 * 3600 * 1000)
    splits: list[_MS] = Field(default_factory=list, max_length=MAX_SPLITS)
    best_sector_ms: Optional[_MS] = None
    jump_start: bool = False
    # Proto 9 (race/PROTOCOL.md "Proto 9: full-race replays"), optional and additive: the same
    # columnar trace encoding POST /runs already carries (race.js's trace recorder), covering this
    # racer's flight in the lobby race. An old client omits it and gets exactly 1.5.0's behavior;
    # a trace that fails decode_trace() is dropped with no effect on the finish itself.
    trace: Optional[dict] = None

    @model_validator(mode="after")
    def plausible(self):
        if any(b < a for a, b in zip(self.splits, self.splits[1:])):
            raise ValueError("splits must be non-decreasing")
        return self


class DnfMsg(BaseModel):
    """Proto 4: 'I am out' — the client sends it on a DQ or a mid-race reset."""
    type: Literal["dnf"]
    race_id: int = Field(ge=0)
    gate: int = Field(ge=0, le=201)
    trace: Optional[dict] = None    # proto 9, optional and additive — see FinishMsg.trace above


class CupMsg(BaseModel):
    type: Literal["cup"]
    name: str = Field(min_length=1, max_length=CUP_NAME_MAX)
    race_count: int = Field(ge=1, le=CUP_MAX_RACES)

    @model_validator(mode="after")
    def named(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("cup name is blank")
        return self


class RematchMsg(BaseModel):
    type: Literal["rematch"]


class RenameMsg(BaseModel):
    """Proto 7: change this connection's display callsign without reconnecting. Same shape and
    validation as JoinMsg.callsign — identity stays pilot_id/pilot_token (see JoinMsg), only the
    room-visible name changes. Allowed any time, including mid-race: a racer in flight just keeps
    their gate/elapsed_ms/items under the new key (see the handler)."""
    type: Literal["rename"]
    callsign: str = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def stripped(self):
        self.callsign = self.callsign.strip()
        if not self.callsign:
            raise ValueError("callsign is blank")
        if is_reserved_callsign(self.callsign):
            raise ValueError(reserved_callsign_error(self.callsign))
        return self


# ------------------------------------------------------------------ hub frames (proto 5)
# A SEPARATE vocabulary from the race socket's, passed to parse_message explicitly. `hello` means
# different things on the two sockets (identity here, "this is my aircraft" there) and the hub has
# no business accepting a `fire`, so one shared table could not express either rule.

class HubHelloMsg(BaseModel):
    type: Literal["hello"]
    # Optional on purpose: a pilot we have never met has no token, and that is not an error.
    pilot_token: Optional[str] = Field(default=None, max_length=128)
    callsign: str = Field(min_length=1, max_length=32)
    model: str = Field(default="", max_length=32)


class HeartbeatMsg(BaseModel):
    type: Literal["heartbeat"]


class WhereMsg(BaseModel):
    type: Literal["where"]
    room: Optional[str] = Field(default=None, max_length=32)
    activity: Literal["idle", "gate", "racing", "solo"] = "idle"


class ListMsg(BaseModel):
    type: Literal["list"]


class RampPingMsg(BaseModel):
    type: Literal["ping_ramp"]


_HUB_MSG_MODELS = {"hello": HubHelloMsg, "heartbeat": HeartbeatMsg, "where": WhereMsg,
                   "list": ListMsg, "ping_ramp": RampPingMsg}


_MSG_MODELS = {"join": JoinMsg, "pos": PosMsg, "box": BoxMsg, "fire": FireMsg,
               "ping": PingMsg, "hello": HelloMsg, "ready": ReadyMsg, "course": CourseMsg,
               "rules": RulesMsg, "start": StartMsg, "abort": AbortMsg, "chat": ChatMsg,
               "back_to_lobby": BackToLobbyMsg, "fx": FxMsg, "tripped": TrippedMsg, "vote": VoteMsg,
               "finish": FinishMsg, "dnf": DnfMsg, "cup": CupMsg, "rematch": RematchMsg,
               "rename": RenameMsg, "formation_drop": FormationDropMsg}


def parse_message(raw: dict, models: Optional[dict] = None):
    """Pure: dict -> validated message model, or raises ValueError/ValidationError. No sockets.

    `models` picks the vocabulary. The two sockets do not share one: the hub has no business
    accepting a `fire`, and `hello` legitimately means different shapes on each (a race `hello`
    sets your model, a hub `hello` is the identity handshake), so one global table could not hold
    both. Defaults to the race table, which is what every existing caller and test expects.
    """
    if not isinstance(raw, dict):
        raise ValueError("message must be a JSON object")
    model = (_MSG_MODELS if models is None else models).get(raw.get("type"))
    if not model:
        raise ValueError(f"unknown message type: {raw.get('type')!r}")
    return model(**raw)


class RateGate:
    """A rolling-window allowance, lifted out of ws_race so three callers share one implementation:
    the race socket, the hub socket, and the separate per-player chat budget.

    `allow(now)` records the attempt and says whether it is within budget; `violations` counts the
    refusals, which is what the sustained-flood close is based on. `burst` lets a short burst
    through while still holding the average to `per_s` — chat wants that (you type three lines at
    once, then nothing for a minute), the socket-level limiter does not and leaves it equal.
    Pure apart from the clock its caller passes in, so the tests drive it with plain numbers.
    """

    __slots__ = ("per_s", "burst", "times", "violations")

    def __init__(self, per_s: float, burst: Optional[int] = None):
        self.per_s = per_s
        self.burst = max(1, int(per_s if burst is None else burst))
        self.times: list[float] = []
        self.violations = 0

    def allow(self, now: float) -> bool:
        self.times = [t for t in self.times if now - t < 1.0]
        if len(self.times) >= self.burst:
            self.violations += 1
            return False
        self.times.append(now)
        return True


def server_ms() -> int:
    """The one clock every lobby countdown is measured against. Clients never compare their own
    wall clocks to each other — they measure an offset to this via ping/pong (race.js's
    clockOffset()) and convert start_at_server_ms into their local frame."""
    return int(time.time() * 1000)


# ------------------------------------------------------------------ results (proto 4)
# A lobby race ends on a shared results screen, with points that carry across a cup. Everything in
# this block down to the `Room` class is pure or plain data — no sockets, and no clock read unless
# a caller hands `now_ms` in — so the scoring is tested with plain numbers. The relay-facing half
# (finish/dnf handling, the end-of-race broadcast, the DB write) is with the other handlers below.
#
# Trust model, same as everywhere else in this file: a client reports only about ITSELF. A finish
# is believed only if its go_time_ms agrees with the relay's own clock to within
# FINISH_TOLERANCE_MS, and everything else on a results row (items used, hits taken, rank history)
# is tallied from frames the relay was already handling — the client is never asked for it.

def points_for(pos: int, status: str) -> int:
    """Pure: 1-based finishing position -> cup points. A DNF scores nothing, and so does a finish
    outside the table (9th and below)."""
    if status != "finished" or not isinstance(pos, int) or pos < 1 or pos > len(POINTS_TABLE):
        return 0
    return POINTS_TABLE[pos - 1]


def finish_time_ok(go_time_ms: int, now_ms: int, start_at_ms: int, jump_start: bool = False,
                   tolerance_ms: Optional[int] = None) -> bool:
    """Pure: is a claimed finish time believable? It must be within FINISH_TOLERANCE_MS of the
    relay's own elapsed time since GO. A jump-starter's clock carries JUMP_START_PENALTY_MS on top
    (race.js adds it to the lobby clock), so that is added to what the relay expects, not
    forgiven — claiming a jump start only ever moves the window later, never earlier."""
    tol = FINISH_TOLERANCE_MS if tolerance_ms is None else tolerance_ms
    expected = now_ms - start_at_ms + (JUMP_START_PENALTY_MS if jump_start else 0)
    return abs(go_time_ms - expected) <= tol


def best_sector_from(splits: list[int], claimed: Optional[int] = None) -> Optional[int]:
    """Pure: the shortest gate-to-gate leg. `splits` are cumulative from the gate-1 crossing, so the
    first leg is splits[0] itself. Derived from the splits when there are any — a client's own
    `best_sector_ms` is only the fallback for a frame that left them out (a very long course's
    splits do not fit a 2 KB frame)."""
    legs, prev = [], 0
    for s in splits:
        legs.append(s - prev)
        prev = s
    legs = [x for x in legs if x > 0]
    if legs:
        return min(legs)
    return claimed if isinstance(claimed, int) and claimed > 0 else None


class Racer:
    """One racer's record for one race. Outlives the socket on purpose: a pilot who disconnects
    keeps their row (as a DNF, or their finish if they had one)."""
    __slots__ = ("callsign", "model", "status", "go_time_ms", "gate", "elapsed_ms", "jump_start",
                 "best_sector_ms", "items_used", "hits_taken", "hits_blocked", "hits_landed",
                 "hits_landed_by_item", "worst_rank", "seq", "reported", "trace_blob")

    def __init__(self, callsign: str, model: str = ""):
        self.callsign = callsign
        self.model = model
        self.status: Optional[str] = None      # None while racing, then 'finished' | 'dnf'
        self.go_time_ms: Optional[int] = None
        # Proto 9: this racer's validated trace blob for race_traces, or None if they never sent
        # one on `finish`/`dnf`, or the one they sent failed decode_trace().
        self.trace_blob: Optional[str] = None
        self.gate = 0                          # last gate this racer reported; a DNF is "at" this
        self.elapsed_ms = 0
        self.jump_start = False
        self.best_sector_ms: Optional[int] = None
        self.items_used: dict[str, int] = {}
        self.hits_taken = 0
        self.hits_blocked = 0
        self.hits_landed = 0                   # this racer's offensive items that actually landed
        self.hits_landed_by_item: dict[str, int] = {}  # same total, broken out by item -- /stats
        self.worst_rank: Optional[int] = None  # 1-based; None until they have reported a position
        self.seq = 0                           # order finishes were accepted, to break an exact tie
        self.reported = False


class RaceRecord:
    """The relay's memory of one lobby race, from `start` to `results`. In-memory like everything
    else here; only the finished result is ever persisted (persist_race)."""

    def __init__(self, race_id: int, course: dict, start_at_ms: int, racers: list):
        self.race_id = race_id
        self.course = dict(course)
        self.start_at_ms = start_at_ms
        self.racers: dict[str, Racer] = {p.callsign: Racer(p.callsign, p.model) for p in racers}
        self.finish_seq = 0
        self.first_finish_ms: Optional[int] = None   # server_ms() of the first accepted finish
        self.timer: Optional[asyncio.Task] = None    # the RESULTS_TIMEOUT_S deadline, once armed
        self.ended = False

    @property
    def started_at(self) -> int:
        """Unix seconds of GO — what `races.started_at` stores."""
        return self.start_at_ms // 1000


def rank_racers(racers: list) -> list:
    """Pure: finishers by time (an exact tie goes to whoever's finish was accepted first), then
    everyone still racing by progress, then DNFs by how far they got. Python's sort is stable, so
    a remaining tie falls to the order racers were given, which is join order."""
    def key(r: Racer):
        if r.status == "finished":
            return (0, r.go_time_ms, r.seq)
        return (2 if r.status == "dnf" else 1, -r.gate, r.elapsed_ms)
    return sorted(racers, key=key)


def build_rows(racers: list) -> list[dict]:
    """Pure: Racer records -> result rows, best first. A row carries the public fields of the
    `results` frame plus a few the awards need (worst_rank, hits_landed, hits_blocked,
    best_sector_ms); public_row() strips those before anything is sent."""
    ordered = rank_racers(racers)
    winner_ms = next((r.go_time_ms for r in ordered if r.status == "finished"), None)
    rows = []
    for i, r in enumerate(ordered):
        finished = r.status == "finished"
        status = "finished" if finished else "dnf"
        rows.append({
            "pos": i + 1, "callsign": r.callsign, "model": r.model,
            "go_time_ms": r.go_time_ms if finished else None,
            "gap_ms": r.go_time_ms - winner_ms if finished else None,
            "status": status, "points": points_for(i + 1, status),
            "items_used": dict(r.items_used), "hits_taken": r.hits_taken, "jump_start": r.jump_start,
            "gate": None if finished else r.gate,
            "hits_blocked": r.hits_blocked, "hits_landed": r.hits_landed,
            "hits_landed_by_item": dict(r.hits_landed_by_item),
            "worst_rank": r.worst_rank, "best_sector_ms": r.best_sector_ms,
        })
    return rows


PUBLIC_ROW_KEYS = ("pos", "callsign", "model", "go_time_ms", "gap_ms", "status", "points",
                   "items_used", "hits_taken", "jump_start", "gate")


def public_row(row: dict) -> dict:
    return {k: row[k] for k in PUBLIC_ROW_KEYS}


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _count(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def compute_awards(rows: list[dict]) -> list[dict]:
    """Pure: result rows (best first, as build_rows returns them) -> [{key, callsign, detail}].

    An award with no qualifying data is skipped rather than handed to nobody in particular. Where
    one pilot has to be picked out (most hits, sharpshooter, comeback, sector) an exact tie goes to
    the better-placed pilot, because the rows arrive best first and max()/min() keep the first
    extreme they meet. clean_race and jump_starter are the two that can honestly go to several
    pilots at once, so each recipient gets their own entry.
    """
    out: list[dict] = []
    if not rows:
        return out

    top = max(rows, key=lambda r: r["hits_taken"])
    if top["hits_taken"] >= 1:
        out.append({"key": "most_hits_taken", "callsign": top["callsign"],
                    "detail": _count(top["hits_taken"], "hit")})

    top = max(rows, key=lambda r: r["hits_landed"])
    if top["hits_landed"] >= 1:
        out.append({"key": "sharpshooter", "callsign": top["callsign"],
                    "detail": _count(top["hits_landed"], "hit") + " landed"})

    climbers = [r for r in rows if r["status"] == "finished" and r["worst_rank"]]
    if climbers:
        top = max(climbers, key=lambda r: r["worst_rank"] - r["pos"])
        if top["worst_rank"] - top["pos"] >= 2:
            out.append({"key": "biggest_comeback", "callsign": top["callsign"],
                        "detail": f"{_ordinal(top['worst_rank'])} to {_ordinal(top['pos'])}"})

    sectored = [r for r in rows if r["best_sector_ms"]]
    if sectored:
        top = min(sectored, key=lambda r: r["best_sector_ms"])
        out.append({"key": "fastest_sector", "callsign": top["callsign"],
                    "detail": f"{top['best_sector_ms'] / 1000:.3f} s"})

    # "Clean" only means something when somebody was hit: in a race with the items off, or one
    # nobody landed a shot in, every finisher would collect it and it would say nothing.
    if any(r["hits_taken"] for r in rows):
        for r in rows:
            if r["status"] == "finished" and r["hits_taken"] == 0:
                out.append({"key": "clean_race", "callsign": r["callsign"], "detail": "no hits taken"})

    for r in rows:
        if r["jump_start"]:
            out.append({"key": "jump_starter", "callsign": r["callsign"],
                        "detail": f"+{JUMP_START_PENALTY_MS / 1000:g} s"})
    return out


# ------------------------------------------------------------------ course vote (proto 5)
# Server-authoritative: the relay draws the candidates and counts the votes, so a client can
# neither nominate a course nor decide the winner. The candidate pool is the shared course list
# (COURSES, loaded from RACE_COURSES_DIR — see refresh_courses()), weighted by `runs`.

def vote_weights(course_stats: list[dict], seen: dict[str, int]) -> list[tuple[dict, float]]:
    """Pure: (course, weight) pairs, weighted TOWARD what this room's pilots have raced least.

    `seen` is {course_id: how many runs the present pilots have on it}. Weight is 1/(1+n), so a
    course nobody present has flown is 1.0 and one they have ground out twenty times is 0.05 —
    still possible, just not what comes up on a Friday night.
    """
    return [(c, 1.0 / (1.0 + max(0, seen.get(c["course_id"], 0)))) for c in course_stats]


def vote_candidates(course_stats: list[dict], seen: dict[str, int], n: int = 3,
                    rng=None) -> list[dict]:
    """Pure (given its rng): `n` distinct weighted draws, plus the surprise-me wildcard last.

    Takes its rng so the tests can pin the draw. The wildcard is always present and always last —
    it is not one of the `n`, and it resolves to a real course only at launch (vote_winner).
    """
    rng = random if rng is None else rng
    pool = vote_weights(course_stats, seen)
    picks: list[dict] = []
    while pool and len(picks) < n:
        total = sum(w for _, w in pool)
        if total <= 0:
            break
        roll, acc = rng.random() * total, 0.0
        for i, (course, w) in enumerate(pool):
            acc += w
            if roll <= acc:
                picks.append(course)
                pool.pop(i)
                break
        else:                       # float drift past the last bucket: take it
            picks.append(pool.pop()[0])
    picks.append({"course_id": SURPRISE_ME, "course_hash": None, "course_name": "Surprise me"})
    return picks


def vote_winner(votes: dict, candidates: list[dict], seen: dict[str, int], rng=None) -> Optional[dict]:
    """Pure (given its rng): the winning candidate, or None if nobody voted.

    Most votes wins. A tie goes to whichever tied candidate this room's pilots have raced LEAST
    (the same bias the draw has), and a tie on that too is broken by the rng — never by dict
    order, which would quietly favour whoever the draw happened to list first.
    """
    if not votes:
        return None
    rng = random if rng is None else rng
    by_id = {c["course_id"]: c for c in candidates}
    tally: dict[str, int] = {}
    for course_id in votes.values():
        if course_id in by_id:
            tally[course_id] = tally.get(course_id, 0) + 1
    if not tally:
        return None
    best = max(tally.values())
    tied = sorted(cid for cid, n in tally.items() if n == best)
    if len(tied) > 1:
        fewest = min(seen.get(cid, 0) for cid in tied)
        tied = [cid for cid in tied if seen.get(cid, 0) == fewest]
    return by_id[tied[0] if len(tied) == 1 else tied[rng.randrange(len(tied))]]


def vote_frame(room: "Room") -> dict:
    """The `vote` broadcast: the candidates and the live tally. Additive — an old client has no
    handler for the type and ignores it, per PROTOCOL.md's versioning rule."""
    return {"type": "vote", "candidates": [
                {"course_id": c["course_id"], "name": c.get("course_name") or c["course_id"]}
                for c in room.vote_candidates],
            "votes": dict(room.votes)}


def cup_standings(points: dict) -> list[dict]:
    """Pure: {callsign: points} -> standings, most points first, alphabetical on a tie so the
    order is stable from one frame to the next."""
    return [{"callsign": cs, "points": pts}
            for cs, pts in sorted(points.items(), key=lambda kv: (-kv[1], kv[0]))]


_persist_tasks: set = set()   # strong refs: a fire-and-forget task nobody holds can be collected mid-write


def persist_race(room: str, course: dict, started_at: int, rows: list[dict],
                 cup: Optional[dict], traces: Optional[dict[str, dict]] = None) -> dict:
    """Write one finished race — and its cup, if any — to SQLite, in one transaction. Synchronous:
    the caller runs it in a worker thread so the event loop never waits on the disk. Nothing else
    in the relay touches the database.

    `cup` is None for a one-off, else {id, name, race_count, race_no}. A cup gets its row here, on
    the first race that finishes (`id` None until then), and is closed the moment its last race
    does. Any OTHER still-open cup for the same room is closed too: a host who started a new cup
    without finishing the old one abandoned it, and an abandoned cup must not sit in the open list
    forever.

    `traces` (proto 9) is `{callsign: {"blob": str, "model": str, "time_ms": int|None}}` for every
    racer who submitted a valid trace on their `finish`/`dnf` frame — see validate_lobby_trace().
    A racer absent from `traces` (no trace sent, or one that failed validation) simply gets no
    race_traces row; a full-race replay then has whichever traces are actually available.
    """
    now = int(time.time())
    with connect() as conn:
        cup_id = None
        if cup is not None:
            cup_id = cup.get("id")
            if cup_id is None:
                cup_id = conn.execute(
                    "INSERT INTO cups (room, name, race_count, created_at, closed_at) VALUES (?,?,?,?,NULL)",
                    (room, cup["name"], cup["race_count"], now)).lastrowid
            conn.execute("UPDATE cups SET closed_at = ? WHERE room = ? AND closed_at IS NULL AND id != ?",
                         (now, room, cup_id))
            if cup["race_no"] >= cup["race_count"]:
                conn.execute("UPDATE cups SET closed_at = ? WHERE id = ? AND closed_at IS NULL", (now, cup_id))
        race_id = conn.execute(
            "INSERT INTO races (room, course_hash, course_name, started_at, cup_id) VALUES (?,?,?,?,?)",
            (room, course["course_hash"], course["name"], started_at, cup_id)).lastrowid
        conn.executemany(
            """INSERT INTO race_results (race_id, callsign, pos, go_time_ms, status, points, model, stats_json)
               VALUES (?,?,?,?,?,?,?,?)""",
            [(race_id, r["callsign"], r["pos"], r["go_time_ms"], r["status"], r["points"], r["model"],
              json.dumps({"items_used": r["items_used"], "hits_taken": r["hits_taken"],
                          "hits_blocked": r["hits_blocked"], "hits_landed": r["hits_landed"],
                          "hits_landed_by_item": r["hits_landed_by_item"],
                          "worst_rank": r["worst_rank"], "final_rank": r["pos"],
                          "best_sector_ms": r["best_sector_ms"], "jump_start": r["jump_start"],
                          "gate": r["gate"]}, separators=(",", ":")))
             for r in rows])
        # pilot_id lookups are per-callsign, one row a piece -- this table is written at most once
        # per finished race per racer, never in a hot loop, so a per-row SELECT is fine here.
        for r in rows:
            t = (traces or {}).get(r["callsign"])
            if t is None:
                continue
            pid = conn.execute("SELECT pilot_id FROM pilots WHERE callsign_key = ?",
                               (callsign_key(r["callsign"]),)).fetchone()
            conn.execute(
                """INSERT INTO race_traces (race_id, pilot_id, callsign, model, time_ms,
                       go_elapsed_ms, trace_blob, created_at) VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(race_id, callsign) DO UPDATE SET trace_blob = excluded.trace_blob""",
                (race_id, pid[0] if pid else None, r["callsign"], t.get("model", ""),
                 t.get("time_ms"), t.get("time_ms"), t["blob"], now))
    return {"race_id": race_id, "cup_id": cup_id}


class Player:
    __slots__ = ("ws", "callsign", "gate", "elapsed_ms", "lat", "lon", "alt", "carrying",
                 "ready", "model", "role", "shield_until", "last_fx_ms", "proto3",
                 "proto5", "chat_gate", "spectate", "client_proto")

    def __init__(self, ws: WebSocket, callsign: str):
        self.ws = ws
        self.callsign = callsign
        self.gate = 0
        self.elapsed_ms = 0
        self.lat: Optional[float] = None
        self.lon: Optional[float] = None
        self.alt: Optional[float] = None
        self.carrying: Optional[str] = None  # the item most recently granted, awaiting a fire
        self.ready = False
        self.model = ""
        self.role = "racer"
        # ---- items (proto 3)
        self.shield_until = 0      # server_ms() the last claimed shield runs out at; 0 = never claimed
        self.last_fx_ms = 0        # rate limit for the cosmetic fx frame
        self.proto3 = False        # set by the first frame only a proto-3 client can send
        # ---- chat and spectating (proto 5)
        self.proto5 = False        # …and the same for proto 5. Gates free-text chat DELIVERY.
        # OPT-IN spectator (join.spectate). Not the same as role == "spectator", which a mid-race
        # joiner also gets: only this flag excludes a player from ranking and refuses their
        # pos/box/fire, because only this flag means the CLIENT asked for it and expects it.
        self.spectate = False
        # Free-text chat gets its own budget ON TOP of the connection's 20 msg/s: a burst of a
        # few lines is normal typing, a sustained stream is not, and neither should be able to
        # spend the whole socket allowance that `pos` frames also need.
        self.chat_gate = RateGate(CHAT_RATE_PER_S, CHAT_BURST)
        # join.client_proto verbatim (proto 8): whether THIS connection can be offered the
        # FORMATION phase. A room only ever gets `formation` when every current racer's own
        # client_proto >= FORMATION_PROTO — see start_wants_formation() — so this is never used
        # to guess at what an individual connection understands.
        self.client_proto = 0


class Room:
    def __init__(self, name: str = ""):
        self.name = name                    # only the results write needs it (races.room)
        self.players: dict[str, Player] = {}
        # ---- items (proto 3). All of it is in-memory like the rest of the room: a restart or an
        # empty room drops every live banana, dark box and in-flight projectile, on purpose.
        self.bananas: list[dict] = []       # [{id, lat, lon, alt, from, armed_at}], newest last
        self.boxes_dark: dict[int, int] = {}   # box id -> server_ms() it lights back up at
        self.next_id = 1                    # ids for projectiles and bananas, unique per room
        self.world_last = 0.0               # time.monotonic() of the last `world` broadcast
        self.tasks: set = set()             # in-flight projectile resolutions, cancelled on teardown
        # ---- lobby (proto 2). `players` is insertion-ordered, so join order — and therefore
        # "longest-connected player" for host migration — is just its key order.
        self.host: Optional[str] = None
        self.phase = "lobby"              # lobby | countdown | formation | racing | results
        self.course: Optional[dict] = None
        self.rules = {"powerups": True, "teleport": True, "rolling": True}
        self.race_id = 0
        self.start_task: Optional[asyncio.Task] = None
        # Proto 5: the registry's "starts in Ns" status line needs the countdown's absolute end
        # time, which nothing before this kept once the countdown task was handed its `lead_s`.
        self.countdown_start_at_ms: Optional[int] = None
        # ---- rolling start / FORMATION (proto 8, race/PROTOCOL.md "Proto 8"). In-memory, like
        # everything else here: `formation_order` is the callsigns in slot order (ready order at
        # the moment `start` armed it; formation_drop or a late ready both move a callsign to the
        # end and rebroadcast). None outside the formation phase.
        self.formation_order: Optional[list[str]] = None
        self.formation_green_at_ms: Optional[int] = None
        self.formation_pace_kt: int = RACE_FORMATION_PACE_KT
        self.ready_seq: dict[str, int] = {}   # callsign -> the order they last readied up in
        self._ready_seq_next = 0
        # ---- course vote (proto 5). Drawn once, on the room's first join; in-memory like
        # everything else here. `host_set_course` is what keeps the vote ADVISORY when the host
        # picked a course by hand — see the start handler.
        self.vote_candidates: list[dict] = []
        self.votes: dict[str, str] = {}      # callsign -> course_id, one active vote each
        self.vote_seen: dict[str, int] = {}  # course_id -> runs the present pilots have on it
        self.host_set_course = False
        # ---- results and cups (proto 4). In-memory like the rest of the room; the finished race
        # (and its cup) is written to SQLite once, by persist_race(), and read back only by REST.
        self.race: Optional[RaceRecord] = None   # the race in flight, or the one whose results are up
        self.last_results: Optional[dict] = None  # the `results` frame, replayed to a joiner
        # None = every race is a one-off. Else {id, name, race_count, race_no, points}; `id` stays
        # None until the first race of the cup has been written.
        self.cup: Optional[dict] = None
        self.persist_lock = asyncio.Lock()       # one race's write at a time, so a cup id exists for the next
        # Proto 6: fixed by the first successful join and never changed; a room is deleted when it
        # empties, so there is no "reset". None only before that first join.
        self.mode: Optional[str] = None

    def ranking(self) -> list[str]:
        """Leader first: most gates passed, then whoever reached their current gate sooner.

        Opt-in spectators (join.spectate, proto 5) are not in it — they are not racing, so they
        have no rank, take no part in the item-box position weighting, and never appear in
        `standings.order`. A MID-RACE joiner, who proto 2 already made role == "spectator"
        without being asked, is still ranked exactly as before: excluding them here would change
        1.1.0 behavior for a client that never opted into anything.

        This is NOT the recipient list for standings — see _broadcast_standings, which sends to
        everyone connected. A spectator watches the race; they just aren't in it.
        """
        return [cs for cs, p in sorted(self.players.items(), key=lambda kv: (-kv[1].gate, kv[1].elapsed_ms))
                if not p.spectate]

    def cup_public(self) -> Optional[dict]:
        c = self.cup
        return None if c is None else {"name": c["name"], "race_no": c["race_no"], "race_count": c["race_count"]}

    def lobby_frame(self) -> dict:
        return {"type": "lobby", "phase": self.phase, "host": self.host, "course": self.course,
                "rules": dict(self.rules), "race_id": self.race_id, "cup": self.cup_public(),
                "players": [{"callsign": p.callsign, "model": p.model, "ready": p.ready, "role": p.role}
                            for p in self.players.values()]}

    def discard_race(self):
        """Forget the race in flight (or the finished one whose results were up) without scoring
        it: an abort, a back-to-lobby, a rematch, a fresh start, or an empty room. Marking it ended
        is what makes any coroutine still holding the record stand down."""
        rec, self.race, self.last_results = self.race, None, None
        if rec is not None:
            rec.ended = True
            if rec.timer is not None:
                rec.timer.cancel()
                rec.timer = None

    def clear_ready(self):
        for p in self.players.values():
            p.ready = False
        # The next race's slot order is the next round of readying up, from scratch.
        self.ready_seq.clear()
        self._ready_seq_next = 0

    def cancel_countdown(self):
        if self.start_task is not None:
            self.start_task.cancel()
            self.start_task = None

    def cancel_tasks(self):
        """Teardown for the items layer: an in-flight projectile whose room is gone has nobody
        left to hit, and a pending resolution holding a reference to a dead Room is a leak."""
        for t in list(self.tasks):
            t.cancel()
        self.tasks.clear()

    def new_id(self) -> int:
        self.next_id += 1
        return self.next_id

    def track(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task


rooms: dict[str, Room] = {}


async def _safe_send(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        return False


async def _broadcast_standings(room: Room):
    """Broadcast the ranking, and the positions the relay already holds.

    `positions` is additive (race/PROTOCOL.md "Versioning"): it carries only what each client
    already reported about ITSELF in its own `pos` frames, which the relay is the sole collector
    of, so it changes nothing about the trust model — no client can assert another's position.
    A client that does not know the field ignores it, and a client talking to an older relay
    that omits it just draws no other racers on its minimap.
    """
    order = room.ranking()
    positions = {cs: [p.lat, p.lon] for cs, p in room.players.items()
                 if p.lat is not None and p.lon is not None}
    frame = {"type": "standings", "order": order, "positions": positions}
    # Every connection in the room, NOT `order`: proto 5's opt-in spectators are absent from the
    # ranking and would otherwise be the one kind of pilot that never receives the standings they
    # joined specifically to watch. This used to iterate `order`, which was the same set.
    await _broadcast(room, frame)


async def _broadcast(room: Room, payload: dict):
    for player in list(room.players.values()):
        await _safe_send(player.ws, payload)


async def _broadcast_lobby(room: Room):
    await _broadcast(room, room.lobby_frame())


async def _run_countdown(room: Room, race_id: int, delay_s: float):
    """Flip the room to 'racing' at start_at. Cancelled by abort/back_to_lobby, and re-checks
    race_id so a stale task from a cancelled countdown can never flip a later one."""
    try:
        await asyncio.sleep(delay_s)
    except asyncio.CancelledError:
        return
    if room.race_id != race_id or room.phase != "countdown":
        return
    room.phase = "racing"
    room.start_task = None
    await _broadcast_lobby(room)


def formation_frame(room: Room, formation_start_ms: Optional[int] = None, vote: Optional[dict] = None,
                    course: Optional[dict] = None) -> dict:
    """The proto-8 `formation` frame (race/PROTOCOL.md "Proto 8"). Sent once when `start` arms a
    rolling start, and again — same race_id, same green_at_ms — whenever the slot order changes
    (a formation_drop or a late ready). `slots` is the whole order, leader first, so a client
    never has to merge deltas. `vote`/`course` ride only the first one, same as `start`."""
    frame = {"type": "formation", "race_id": room.race_id,
             "green_at_ms": room.formation_green_at_ms, "pace_kt": room.formation_pace_kt,
             "pace_s": RACE_FORMATION_PACE_S,
             "slots": [{"callsign": cs, "index": i} for i, cs in enumerate(room.formation_order or [])]}
    if formation_start_ms is not None:
        frame["formation_start_ms"] = formation_start_ms
    if course is not None:
        frame["course"] = course
        frame["vote"] = vote
    return frame


async def _run_formation(room: Room, race_id: int, delay_s: float):
    """Flip a FORMATION room to 'racing' at green. Same guard shape as _run_countdown: cancelled
    by abort/back_to_lobby, and re-checks race_id and phase so a stale task never flips a later
    race."""
    try:
        await asyncio.sleep(delay_s)
    except asyncio.CancelledError:
        return
    if room.race_id != race_id or room.phase != "formation":
        return
    room.phase = "racing"
    room.start_task = None
    room.formation_order = None
    await _broadcast_lobby(room)


async def _broadcast_boxed(room: Room, shooter: Player, item: str):
    for cs, other in list(room.players.items()):
        if cs != shooter.callsign:
            await _safe_send(other.ws, {"type": "boxed", "callsign": shooter.callsign, "item": item})


async def _broadcast_world(room: Room, force: bool = False):
    """Where everyone is, coalesced to at most 2/s per room (WORLD_MIN_INTERVAL_S).

    This is the frame that lets a client place a missile splat on somebody else's aircraft. It
    is the same data `standings.positions` already carries plus altitude, so it adds nothing to
    the trust model — every entry is that player's own `pos`, and no client can assert another's.
    Deliberately throttled inline rather than on a timer task: a race sends `pos` at 2 Hz per
    player, so a world frame per incoming `pos` would be N times that for no extra information.
    """
    now = time.monotonic()
    if not force and now - room.world_last < WORLD_MIN_INTERVAL_S:
        return
    room.world_last = now
    players = [{"callsign": p.callsign, "lat": p.lat, "lon": p.lon,
                "alt": p.alt if p.alt is not None else 0.0, "gate": p.gate}
               for p in room.players.values() if p.lat is not None and p.lon is not None]
    await _broadcast(room, {"type": "world", "players": players})


def _prune_bananas(room: Room) -> list[dict]:
    """Drop expired bananas, returning the ones that went. The TTL is enforced here AND
    client-side (race.js gives every item entity its own TTL), so a `cleared` frame that never
    arrives still cannot leave a banana sitting on the course forever."""
    now = server_ms()
    live, dead = [], []
    for b in room.bananas:
        (dead if now - b["dropped_at"] > BANANA_TTL_S * 1000 else live).append(b)
    room.bananas = live
    return dead


async def _clear_banana(room: Room, banana: dict, by, reason: str):
    room.bananas = [b for b in room.bananas if b["id"] != banana["id"]]
    await _broadcast(room, {"type": "cleared", "id": banana["id"], "by": by, "reason": reason})


async def _drop_banana(room: Room, shooter: Player, heading):
    """A banana lands BANANA_DROP_BACK_M behind its dropper and arms BANANA_ARM_MS later, so
    nobody can drop one straight into the nose of the wingman on their tail. With no heading
    (an old client) it lands where the shooter is, which is exactly the 0.9.0 behavior."""
    if shooter.lat is None or shooter.lon is None:
        return  # a banana with no known drop position is simply lost, never a crash
    lat, lon = shooter.lat, shooter.lon
    if heading is not None:
        lat, lon = offset_point(lat, lon, (heading + 180.0) % 360.0, BANANA_DROP_BACK_M)
    now = server_ms()
    banana = {"id": room.new_id(), "lat": lat, "lon": lon,
              "alt": shooter.alt if shooter.alt is not None else 0.0,
              "from": shooter.callsign, "dropped_at": now, "armed_at": now + BANANA_ARM_MS}
    room.bananas.append(banana)
    # Oldest first out, so a room can never be carpeted: the cap is what keeps the client's
    # entity budget (race.js's makeItemLayer) from being the thing that decides what is visible.
    while len(room.bananas) > MAX_BANANAS:
        await _clear_banana(room, room.bananas[0], None, "expired")
    await _broadcast(room, {"type": "dropped", "id": banana["id"], "lat": lat, "lon": lon,
                            "alt": banana["alt"], "from": shooter.callsign,
                            "armed_at_server_ms": banana["armed_at"]})


async def _check_banana(room: Room, player: Player):
    """The server-side 2D fallback, for clients that predate proto 3 only.

    A proto-3 client does this itself, per frame and in 3D (`tripped`), because a 2 Hz ping
    tunnels clean through a 75 m sphere at 200 m/s. Running both paths for the same player would
    double-resolve the same banana, so this is skipped for anyone whose `pos` carries `alt`.
    """
    for dead in _prune_bananas(room):
        await _broadcast(room, {"type": "cleared", "id": dead["id"], "by": None, "reason": "expired"})
    if player.proto3 or player.lat is None:
        return
    now = server_ms()
    for b in list(room.bananas):
        if player.callsign == b["from"] or now < b["armed_at"]:
            continue
        if _meters_between(player.lat, player.lon, b["lat"], b["lon"]) <= BANANA_RADIUS_M:
            await _resolve_banana(room, player, b)
            return


async def _resolve_banana(room: Room, victim: Player, banana: dict):
    """Shared by both detection paths. Shield up clears the banana with no penalty — the same
    "it ate something" outcome a blocked missile gets, and for the same reason."""
    if victim.shield_until > server_ms():
        _tally(room, victim.callsign, "hits_blocked")
        await _clear_banana(room, banana, victim.callsign, "blocked")
        return
    _tally(room, victim.callsign, "hits_taken")
    _tally(room, banana["from"], "hits_landed")
    _tally_item_landed(room, banana["from"], "banana")
    await _clear_banana(room, banana, victim.callsign, "hit")
    await _safe_send(victim.ws, {"type": "hit", "item": "banana", "from": banana["from"],
                                 "id": banana["id"]})


async def _resolve_projectile(room: Room, pid: int, item: str, shooter_cs: str, target_cs: str,
                              flight_ms: int):
    """The deferred half of a fired missile/goop: sleep out the telegraphed flight, then decide.

    The shield is checked AT RESOLUTION, not at launch — that is the whole point of the flight
    time. A victim who pops a shield while the projectile is in the air blocks it; one who pops
    it a frame too late does not.
    """
    try:
        await asyncio.sleep(flight_ms / 1000.0)
    except asyncio.CancelledError:
        return
    target = room.players.get(target_cs)
    if target is None:
        # The target left mid-flight. Tell the room anyway so every client can drop its
        # projectile entity now instead of waiting out that entity's own TTL.
        await _broadcast(room, {"type": "resolved", "id": pid, "item": item, "from": shooter_cs,
                                "target": target_cs, "blocked": False, "lost": True})
        return
    blocked = target.shield_until > server_ms()
    if blocked:
        _tally(room, target_cs, "hits_blocked")
    else:
        _tally(room, target_cs, "hits_taken")
        _tally(room, shooter_cs, "hits_landed")
        _tally_item_landed(room, shooter_cs, item)
    await _broadcast(room, {"type": "resolved", "id": pid, "item": item, "from": shooter_cs,
                            "target": target_cs, "blocked": blocked, "lost": False})
    if not blocked:
        await _safe_send(target.ws, {"type": "hit", "item": item, "from": shooter_cs, "id": pid})


async def _resolve_fire(room: Room, shooter: Player, item: str, heading=None):
    if item == "banana":
        await _drop_banana(room, shooter, heading)
        return
    # missile / goop: nearest player ahead by rank. Already in the lead -> nothing to hit, and
    # the item comes BACK rather than being silently burned (which is what 0.9.0 did).
    ranking = room.ranking()
    idx = ranking.index(shooter.callsign)
    target = room.players.get(ranking[idx - 1]) if idx > 0 else None
    if target is None:
        shooter.carrying = item
        _tally_item(room, shooter.callsign, item, -1)   # it comes back, so it was not used
        await _safe_send(shooter.ws, {"type": "refund", "item": item, "reason": "no_target"})
        return
    dist = 0.0
    if None not in (shooter.lat, shooter.lon, target.lat, target.lon):
        dist = _meters_between(shooter.lat, shooter.lon, target.lat, target.lon)
    flight_ms = flight_ms_for(item, dist)
    pid = room.new_id()
    await _broadcast(room, {"type": "fired", "id": pid, "item": item, "from": shooter.callsign,
                            "target": target.callsign, "flight_ms": flight_ms})
    room.track(_resolve_projectile(room, pid, item, shooter.callsign, target.callsign, flight_ms))


# ---- results handlers (proto 4). The pure half is up by `Racer`/`RaceRecord`.

def _live_racer(room: Room, callsign: str) -> Optional[Racer]:
    """The Racer for `callsign`, but only while a race is actually under way and they are still in
    it. Everything tallied for the results goes through this, so an item thrown in the lobby or
    after somebody has finished can never leak onto a results row."""
    rec = room.race
    if rec is None or rec.ended or room.phase != "racing":
        return None
    racer = rec.racers.get(callsign)
    return racer if racer is not None and racer.status is None else None


def _tally(room: Room, callsign: str, field: str) -> None:
    racer = _live_racer(room, callsign)
    if racer is not None:
        setattr(racer, field, getattr(racer, field) + 1)


def _tally_item(room: Room, callsign: str, item: str, by: int = 1) -> None:
    racer = _live_racer(room, callsign)
    if racer is None:
        return
    n = max(0, racer.items_used.get(item, 0) + by)
    if n:
        racer.items_used[item] = n
    else:
        racer.items_used.pop(item, None)


def _tally_item_landed(room: Room, callsign: str, item: str) -> None:
    """Same event as _tally(room, callsign, "hits_landed"), broken out by item -- only /stats
    (missiles_hit) reads this; the results screen and awards still use the plain total."""
    racer = _live_racer(room, callsign)
    if racer is not None:
        racer.hits_landed_by_item[item] = racer.hits_landed_by_item.get(item, 0) + 1


def _note_pos(room: Room, player: Player) -> None:
    """Keep the racer's own progress, and the worst place they have been in, current. Rank is
    worked out with rank_racers() over the whole field rather than Room.ranking(), because that
    one knows nothing about who has finished and a finisher's last `pos` is stale by then."""
    racer = _live_racer(room, player.callsign)
    if racer is None:
        return
    racer.gate, racer.elapsed_ms, racer.reported = player.gate, player.elapsed_ms, True
    ordered = rank_racers(list(room.race.racers.values()))
    for i, r in enumerate(ordered):
        if r.reported and r.status is None:
            r.worst_rank = max(r.worst_rank or 0, i + 1)


async def _accept_finish(room: Room, player: Player, msg: FinishMsg) -> Optional[str]:
    """Returns why a finish was refused, or None once it has been taken. Refusals are ordered from
    'this frame cannot belong to any race' to 'this racer already has a result'."""
    rec = room.race
    if rec is None:
        return "no race in progress"
    if msg.race_id != rec.race_id:
        return "wrong race"
    if rec.ended:
        return "the race is over"
    racer = rec.racers.get(player.callsign)
    if racer is None:
        return "not a racer in this race"
    if racer.status is not None:
        return "already finished or out"
    if room.phase != "racing":
        return "the race has not started"
    now = server_ms()
    if not finish_time_ok(msg.go_time_ms, now, rec.start_at_ms, msg.jump_start):
        return "time does not match the relay's clock"
    rec.finish_seq += 1
    racer.status, racer.seq = "finished", rec.finish_seq
    racer.go_time_ms, racer.jump_start = msg.go_time_ms, msg.jump_start
    racer.best_sector_ms = best_sector_from(msg.splits, msg.best_sector_ms)
    racer.trace_blob = validate_lobby_trace(msg.trace, msg.go_time_ms)
    if rec.first_finish_ms is None:
        rec.first_finish_ms = now
        rec.timer = asyncio.create_task(_results_deadline(room, rec))
    await _after_result(room, rec)
    return None


async def _accept_dnf(room: Room, player: Player, msg: DnfMsg) -> Optional[str]:
    rec = room.race
    if rec is None:
        return "no race in progress"
    if msg.race_id != rec.race_id:
        return "wrong race"
    if rec.ended:
        return "the race is over"
    racer = rec.racers.get(player.callsign)
    if racer is None:
        return "not a racer in this race"
    if racer.status is not None:
        return "already finished or out"
    if room.phase != "racing":
        return "the race has not started"
    racer.status, racer.gate = "dnf", msg.gate
    racer.trace_blob = validate_lobby_trace(msg.trace, None)
    await _after_result(room, rec)
    return None


async def _note_disconnect(room: Room, callsign: str) -> None:
    """A racer whose socket went away is out, at the last gate they reported. Somebody who had
    already finished keeps the finish: the result was theirs before the connection dropped."""
    rec = room.race
    if rec is None or rec.ended:
        return
    racer = rec.racers.get(callsign)
    if racer is None or racer.status is not None:
        return
    racer.status = "dnf"
    await _after_result(room, rec)


async def _after_result(room: Room, rec: RaceRecord) -> None:
    """Something changed who is still racing: end the race if that was the last of them, else tell
    the room who is still being waited on (once there is a first finisher to be waiting after)."""
    if rec.ended:
        return
    if all(r.status is not None for r in rec.racers.values()):
        await _end_race(room, rec)
    elif rec.first_finish_ms is not None:
        await _broadcast_progress(room, rec)


async def _broadcast_progress(room: Room, rec: RaceRecord) -> None:
    """`results_progress`: the finishers so far, and who the room is still waiting for. A
    finisher's place and points are already final — nobody who finishes later can be ahead of
    them — so the rows carry both."""
    finished = [r for r in rec.racers.values() if r.status == "finished"]
    await _broadcast(room, {
        "type": "results_progress", "race_id": rec.race_id,
        "rows": [public_row(r) for r in build_rows(finished)],
        "waiting": [cs for cs, r in rec.racers.items() if r.status is None],
        "deadline_server_ms": rec.first_finish_ms + int(RESULTS_TIMEOUT_S * 1000)})


async def _results_deadline(room: Room, rec: RaceRecord) -> None:
    """RESULTS_TIMEOUT_S after the first finisher, whoever is still flying is out."""
    try:
        await asyncio.sleep(RESULTS_TIMEOUT_S)
    except asyncio.CancelledError:
        return
    if room.race is rec and not rec.ended:
        await _end_race(room, rec)


async def _end_race(room: Room, rec: RaceRecord) -> None:
    """Score the race, move the room to 'results', tell everyone, and hand the write to a thread.
    Idempotent: the last finisher, the deadline and a disconnect can all arrive together."""
    if rec.ended:
        return
    rec.ended = True
    if rec.timer is not None and rec.timer is not asyncio.current_task():
        rec.timer.cancel()
    rec.timer = None
    room.cancel_countdown()
    for r in rec.racers.values():
        if r.status is None:          # a straggler: out, at the last gate it reported
            r.status = "dnf"
    rows = build_rows(list(rec.racers.values()))
    awards = compute_awards(rows)
    cup = room.cup
    cup_frame = None
    if cup is not None:
        cup["race_no"] += 1
        for row in rows:
            cup["points"][row["callsign"]] = cup["points"].get(row["callsign"], 0) + row["points"]
        cup_frame = {"name": cup["name"], "race_no": cup["race_no"], "race_count": cup["race_count"],
                     "standings": cup_standings(cup["points"])}
    room.phase = "results"
    frame = {"type": "results", "race_id": rec.race_id, "course": dict(rec.course),
             "rows": [public_row(r) for r in rows], "awards": awards, "cup": cup_frame}
    room.last_results = frame
    race_no = cup["race_no"] if cup is not None else 0
    if cup is not None and race_no >= cup["race_count"]:
        room.cup = None               # that was the last race of the cup; the next one is a one-off
    await _broadcast(room, frame)
    await _broadcast_lobby(room)      # the phase changed
    # races/race_results are time-trial history. A room playing any other mode keeps its results
    # in memory only, until that mode defines what its lobby results mean.
    if (room.mode or DEFAULT_MODE) != "race":
        return
    task = asyncio.create_task(_persist_results(room.name, room.persist_lock, rec, rows, cup, race_no))
    _persist_tasks.add(task)
    task.add_done_callback(_persist_tasks.discard)


async def _persist_results(room_name: str, lock: asyncio.Lock, rec: RaceRecord, rows: list[dict],
                           cup: Optional[dict], race_no: int) -> None:
    """The one place the relay touches SQLite: once per race, in a worker thread. It takes the
    room's lock so two races' writes cannot interleave, and reads the cup's id INSIDE it so the
    second race of a cup always sees the id the first one's write created. A failed write is
    logged and swallowed: losing a race from the history must never take the room down."""
    async with lock:
        cup_arg = None if cup is None else {"id": cup.get("id"), "name": cup["name"],
                                            "race_count": cup["race_count"], "race_no": race_no}
        traces = {r.callsign: {"blob": r.trace_blob, "model": r.model, "time_ms": r.go_time_ms}
                 for r in rec.racers.values() if r.trace_blob is not None}
        try:
            saved = await asyncio.to_thread(persist_race, room_name, rec.course, rec.started_at,
                                            rows, cup_arg, traces)
        except Exception:
            logging.getLogger("race").exception("could not persist race %s of room %s", rec.race_id, room_name)
            return
        if cup is not None and saved.get("cup_id") is not None:
            cup["id"] = saved["cup_id"]


@app.websocket("/ws/race/{room}")
async def ws_race(websocket: WebSocket, room: str):
    if not ROOM_PATTERN.match(room):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    r = rooms.setdefault(room, Room(room))
    player: Optional[Player] = None
    gate = RateGate(WS_RATE_LIMIT_PER_S)
    try:
        while True:
            raw_text = await websocket.receive_text()

            if len(raw_text.encode("utf-8")) > MAX_WS_MSG_BYTES:
                await websocket.close(code=1009)
                return

            now = time.monotonic()
            if not gate.allow(now):
                if gate.violations > WS_MAX_VIOLATIONS:
                    await websocket.close(code=1008)
                    return
                await _safe_send(websocket, {"type": "error", "detail": "rate limited"})
                continue

            try:
                raw = json.loads(raw_text)
                msg = parse_message(raw)
            except (json.JSONDecodeError, ValueError, ValidationError) as e:
                await _safe_send(websocket, {"type": "error", "detail": str(e)[:200]})
                continue

            # Clock sync is stateless and deliberately allowed before join: it measures the
            # socket, not the player. t0 is echoed untouched — the server never interprets a
            # client's own clock, it only stamps its own.
            if isinstance(msg, PingMsg):
                await _safe_send(websocket, {"type": "pong", "t0": msg.t0, "server_ms": server_ms()})
                continue

            if isinstance(msg, JoinMsg):
                if msg.room is not None and msg.room != room:
                    await _safe_send(websocket, {"type": "error", "detail": "room mismatch"})
                    continue
                if msg.callsign in r.players:
                    await _safe_send(websocket, {"type": "error", "detail": "callsign already connected in this room"})
                    continue
                # Proto 6. A join without `mode` is a race join, so a pre-6 client can only ever
                # be turned away from a room some proto-6 client opened in another mode.
                mode = msg.mode if msg.mode is not None else DEFAULT_MODE
                if mode not in MODES:
                    await _safe_send(websocket, {"type": "error", "detail": f"unknown mode {mode!r}"[:200]})
                    continue
                if r.mode is not None and r.mode != mode:
                    await _safe_send(websocket, {"type": "error",
                                                 "detail": f"mode mismatch: this room is playing {r.mode!r}"})
                    continue
                # The pilot cap counts pilots, not spectators: a full grid with a crowd watching
                # is the point, so `spectate: true` walks past this.
                if not msg.spectate and sum(1 for p in r.players.values() if not p.spectate) >= ROOM_MAX_PILOTS:
                    await _safe_send(websocket, {"type": "error",
                                                 "detail": f"room is full ({ROOM_MAX_PILOTS} pilots)"})
                    continue
                player = Player(websocket, msg.callsign)
                # A pilot_token on a join is only ever sent by a client that knows about proto 5
                # identity, so its presence doubles as this connection's capability marker (see
                # JoinMsg). Conservative on purpose: it can under-detect a real proto-5 client
                # that has never been to the hub, and never over-detects an old one.
                player.proto5 = msg.pilot_token is not None or (msg.client_proto or 0) >= 5
                player.client_proto = msg.client_proto or 0
                # Asking to spectate also proves proto 5 — no client before it knew the field.
                if msg.spectate:
                    player.spectate = True
                    player.proto5 = True
                    player.role = "spectator"
                # Joining anything but an open lobby means the race is already under way: you
                # watch this one. back_to_lobby puts everyone back to 'racer'.
                if r.phase != "lobby":
                    player.role = "spectator"
                r.players[msg.callsign] = player
                if r.mode is None:
                    r.mode = mode
                if r.host is None:
                    r.host = msg.callsign
                _registry_touch(r, time.monotonic())
                _hub_mark_dirty()
                # The room's course vote is drawn once, on its first join, weighted toward what
                # the pilots present have raced least. A server with no posted runs at all simply
                # has no candidates and the whole feature stays dark.
                if not r.vote_candidates:
                    r.vote_candidates, r.vote_seen = await asyncio.to_thread(
                        _draw_vote_in_thread, list(r.players.keys()))
                await _safe_send(websocket, {"type": "joined", "room": room, "proto": PROTO,
                                             "server_ms": server_ms(), "mode": r.mode})
                # Anything already live in the room, so a joiner is not blind to a banana that
                # was dropped before they arrived or a box that is currently dark.
                for b in r.bananas:
                    await _safe_send(websocket, {"type": "dropped", "id": b["id"], "lat": b["lat"],
                                                 "lon": b["lon"], "alt": b["alt"], "from": b["from"],
                                                 "armed_at_server_ms": b["armed_at"]})
                now_ms = server_ms()
                for box_id, until in list(r.boxes_dark.items()):
                    if until > now_ms:
                        await _safe_send(websocket, {"type": "box_state", "id": box_id,
                                                     "until_server_ms": until})
                # The candidates and the tally so far, so a joiner can vote without waiting for
                # somebody else to move first. Additive: an old client ignores the frame.
                if r.vote_candidates:
                    await _safe_send(websocket, vote_frame(r))
                # Somebody arriving while the results are up (or reconnecting to them) sees them.
                if r.phase == "results" and r.last_results is not None:
                    await _safe_send(websocket, r.last_results)
                await _broadcast_lobby(r)
                continue

            if player is None:
                await _safe_send(websocket, {"type": "error", "detail": "join first"})
                continue

            # ---- opt-in spectators (proto 5) don't race. Refused rather than ignored, so a
            # client that thinks it is racing finds out it asked to spectate. Only the OPT-IN
            # flag does this: a mid-race joiner (proto 2's automatic role == "spectator") keeps
            # sending pos exactly as it always has, and must not start collecting errors for it.
            if player.spectate and isinstance(msg, (PosMsg, BoxMsg, FireMsg, FinishMsg, DnfMsg)):
                await _safe_send(websocket, {"type": "error",
                                             "detail": f"spectators cannot send {msg.type}"})
                continue

            # ---- lobby frames (proto 2). Host-only ones are refused for everyone else rather
            # than silently ignored, so a client whose host migrated away finds out.
            if isinstance(msg, (CourseMsg, RulesMsg, StartMsg, AbortMsg, BackToLobbyMsg, CupMsg, RematchMsg)):
                if player.callsign != r.host:
                    await _safe_send(websocket, {"type": "error", "detail": "host only"})
                    continue

            if isinstance(msg, HelloMsg):
                player.model = msg.model
                await _broadcast_lobby(r)
            elif isinstance(msg, ReadyMsg):
                player.ready = msg.ready
                if msg.ready and player.callsign not in r.ready_seq:
                    r.ready_seq[player.callsign] = r._ready_seq_next
                    r._ready_seq_next += 1
                # A ready arriving DURING formation (proto 8, "Latecomers… get the next slot at
                # the back") — not a lobby ready at all, since the room already launched. Refused
                # once green is within the no-more-latecomers window, same as a formation_drop
                # would be pointless to honor that close to the line.
                if msg.ready and r.phase == "formation" and r.formation_order is not None and not player.spectate:
                    if player.callsign not in r.formation_order:
                        if r.formation_green_at_ms is not None and \
                                r.formation_green_at_ms - server_ms() < RACE_FORMATION_LATE_CUTOFF_S * 1000:
                            await _safe_send(websocket, {"type": "error",
                                                         "detail": "too close to green to join the formation"})
                            continue
                        r.formation_order.append(player.callsign)
                        player.role = "racer"
                        if r.race is not None and player.callsign not in r.race.racers:
                            r.race.racers[player.callsign] = Racer(player.callsign, player.model)
                        await _broadcast(r, formation_frame(r))
                    continue
                await _broadcast_lobby(r)
            elif isinstance(msg, ChatMsg):
                # NOTHING HERE IS EVER PERSISTED — not SQLite, not disk, not a log line. That is
                # deliberate: this is the only place in the whole relay that carries a string one
                # pilot typed to another, and a chat log is a liability nobody asked for. If you
                # are here to "just add a log for debugging", don't. Room state is in-memory and
                # chat is not even that: it is forwarded and forgotten.
                if msg.code is not None:
                    # Proto 2's fixed enum, byte-for-byte unchanged, still to the whole room.
                    await _broadcast(r, {"type": "chat", "callsign": player.callsign, "code": msg.code})
                    continue
                player.proto5 = True     # only a proto-5 client can send this shape at all
                if not player.chat_gate.allow(now):
                    await _safe_send(websocket, {"type": "error", "detail": "chat rate limited"})
                    continue
                line = sanitize_chat(msg.text, CHAT_MAX_CHARS)
                if line is None:
                    await _safe_send(websocket, {"type": "error", "detail": "empty chat line"})
                    continue
                # Delivered ONLY to connections that proved proto 5. An old client has a working
                # `chat` handler that reads `callsign`/`code`, so this shape would render as a
                # blank "?: " line in its feed — worse than not receiving it at all.
                for other in list(r.players.values()):
                    if other.proto5:
                        await _safe_send(other.ws, {"type": "chat", "from": player.callsign,
                                                    "text": line})
            elif isinstance(msg, RenameMsg):
                new_cs = msg.callsign
                if new_cs == player.callsign:
                    pass    # no-op: renaming to your own current name changes nothing
                elif new_cs in r.players:
                    await _safe_send(websocket, {"type": "error",
                                                 "detail": "callsign already connected in this room"})
                else:
                    old_cs = player.callsign
                    del r.players[old_cs]
                    player.callsign = new_cs
                    r.players[new_cs] = player
                    if r.host == old_cs:
                        r.host = new_cs
                    if old_cs in r.votes:
                        r.votes[new_cs] = r.votes.pop(old_cs)
                    # Bananas remember who dropped them (self-hit exclusion, credit on a kill) by
                    # callsign — keep that pointing at the renamed player rather than orphaning it.
                    for b in r.bananas:
                        if b["from"] == old_cs:
                            b["from"] = new_cs
                    # Mid-race: the racer's own gate/elapsed_ms/items live on rec.racers, keyed the
                    # same way. Re-key it too, or a renamed racer's standings row and tallies
                    # (hits, items used) would silently stop updating for the rest of the race.
                    rec = r.race
                    if rec is not None and old_cs in rec.racers:
                        racer = rec.racers.pop(old_cs)
                        racer.callsign = new_cs
                        rec.racers[new_cs] = racer
                    await _broadcast(r, {"type": "renamed", "old": old_cs, "new": new_cs})
                    await _broadcast_lobby(r)
            elif isinstance(msg, VoteMsg):
                # Anyone may vote, one active vote each, changeable right up to the launch.
                if r.phase != "lobby":
                    await _safe_send(websocket, {"type": "error",
                                                 "detail": "voting is closed once the room launches"})
                    continue
                allowed = {c["course_id"] for c in r.vote_candidates}
                if msg.course_id not in allowed:
                    await _safe_send(websocket, {"type": "error",
                                                 "detail": f"not a candidate: {msg.course_id}"})
                    continue
                r.votes[player.callsign] = msg.course_id
                await _broadcast(r, vote_frame(r))
            elif isinstance(msg, CourseMsg):
                # Everyone re-confirms after a course or rules change: what you said yes to is
                # gone, and the client has to load the new course before it can honestly be ready.
                r.course = {"course_id": msg.course_id, "course_hash": msg.course_hash,
                            "name": msg.name, "start_type": msg.start_type, "gates": msg.gates}
                r.host_set_course = True     # a hand-picked course always beats the vote
                r.clear_ready()
                await _broadcast_lobby(r)
            elif isinstance(msg, RulesMsg):
                r.rules = {"powerups": msg.powerups, "teleport": msg.teleport, "rolling": msg.rolling}
                r.clear_ready()
                await _broadcast_lobby(r)
            elif isinstance(msg, StartMsg):
                # The vote is BINDING only when the host never picked a course by hand. A host
                # `course` frame always wins (host_set_course), and a room where nobody voted
                # still gets the "no course selected" refusal — the vote adds a way to start, it
                # never takes the host's away.
                vote_won = None
                if not r.host_set_course and r.votes and r.vote_candidates:
                    vote_won = vote_winner(r.votes, r.vote_candidates, r.vote_seen)
                    if vote_won is not None:
                        resolved = await asyncio.to_thread(
                            _resolve_course_in_thread, vote_won["course_id"])
                        if resolved is not None:
                            r.course = resolved
                        else:
                            vote_won = None   # unresolvable: fall through to the usual refusal
                if r.course is None:
                    await _safe_send(websocket, {"type": "error", "detail": "no course selected"})
                    continue
                # A spectator's ready flag is nobody's business: they are not on the grid, so the
                # room must not wait on them to say yes before it can start.
                if not msg.force and not all(p.ready for p in r.players.values() if not p.spectate):
                    await _safe_send(websocket, {"type": "error", "detail": "not everyone is ready"})
                    continue
                r.cancel_countdown()
                r.discard_race()       # a start over a race in flight, or over its results, replaces it
                r.race_id += 1
                for p in r.players.values():
                    p.role = "spectator" if p.spectate else ("racer" if p.ready else "spectator")
                racers = [cs for cs, p in r.players.items() if p.role == "racer"]
                racer_players = [r.players[cs] for cs in racers]
                # Rolling start (proto 8, race/PROTOCOL.md "Proto 8"): only ever offered when
                # EVERY racer's own connection has proven FORMATION_PROTO — never guessed from
                # the host's proto alone, and never partial (a room can't put some pilots in
                # FORMATION and the rest on the old grid; they'd disagree about what phase the
                # room is in). Anything else — a ground-start course, the host's rules.rolling
                # off, no racers, or any racer below FORMATION_PROTO — is the existing grid path,
                # byte-for-byte unchanged.
                wants_formation = (r.rules.get("rolling", True) and racer_players and
                                    r.course.get("start_type") == "air" and
                                    all(p.client_proto >= FORMATION_PROTO for p in racer_players))
                start_at = server_ms() + msg.lead_s * 1000
                # A start with nobody racing has nothing to score, so there is no record to end it
                # (it stays 'racing' until the host goes back to the lobby, exactly as before).
                if racers:
                    r.race = RaceRecord(r.race_id, r.course, start_at, racer_players)
                # `vote` is additive on the start frame: the winner and the tally that produced
                # it, or null when the host picked the course (or nobody voted). An old client
                # reads race_id/start_at_server_ms/racers and ignores the rest.
                vote_payload = None
                if vote_won is not None:
                    vote_payload = {"course_id": vote_won["course_id"],
                                     "name": r.course["name"] if r.course else vote_won["course_id"],
                                     "votes": dict(r.votes)}
                if wants_formation:
                    r.phase = "formation"
                    r.countdown_start_at_ms = None
                    # Slot order = ready order (Room.ready_seq), for whoever is actually racing.
                    r.formation_order = sorted(racers, key=lambda cs: r.ready_seq.get(cs, 10**9))
                    r.formation_green_at_ms = start_at
                    r.formation_pace_kt = RACE_FORMATION_PACE_KT
                    await _broadcast(r, formation_frame(r, formation_start_ms=server_ms(), vote=vote_payload,
                                                         course=dict(r.course)))
                    r.start_task = asyncio.create_task(_run_formation(r, r.race_id, msg.lead_s))
                else:
                    r.phase = "countdown"
                    r.countdown_start_at_ms = start_at
                    # `course` is additive (lobby reliability pass): the course this start is FOR,
                    # so a client can load it before arming. The `lobby` frame that also carries
                    # it is sent after this one, and a vote-won course was otherwise unknown to
                    # every client at the moment its start arrived — no countdown armed, no grid,
                    # no teleport.
                    start_frame = {"type": "start", "race_id": r.race_id,
                                   "start_at_server_ms": start_at, "racers": racers,
                                   "vote": vote_payload, "course": dict(r.course)}
                    await _broadcast(r, start_frame)
                    r.start_task = asyncio.create_task(_run_countdown(r, r.race_id, msg.lead_s))
                # The vote has been spent. The next race in this room votes again from scratch,
                # rather than inheriting a tally cast for a course that has already been run.
                r.votes.clear()
                await _broadcast_lobby(r)
            elif isinstance(msg, FormationDropMsg):
                # "If a pilot touches the controls and the autopilot disengages during the pace
                # lap, they drop to the back of the formation." Only ever moves the SENDER — a
                # client can only ever report its own autopilot state.
                if r.phase != "formation" or r.formation_order is None:
                    continue
                if player.callsign in r.formation_order:
                    r.formation_order.remove(player.callsign)
                    r.formation_order.append(player.callsign)
                    await _broadcast(r, formation_frame(r))
            elif isinstance(msg, AbortMsg):
                if r.phase not in ("countdown", "formation"):
                    await _safe_send(websocket, {"type": "error", "detail": "nothing to abort"})
                    continue
                r.cancel_countdown()
                r.discard_race()
                r.phase = "lobby"
                r.formation_order = None
                r.formation_green_at_ms = None
                for p in r.players.values():
                    # ready flags survive an abort: nobody un-said yes. An opt-in spectator
                    # stays a spectator — they never said yes in the first place.
                    p.role = "spectator" if p.spectate else "racer"
                await _broadcast(r, {"type": "abort"})
                await _broadcast_lobby(r)
            elif isinstance(msg, BackToLobbyMsg):
                r.cancel_countdown()
                r.discard_race()           # a race sent home early is not scored
                r.phase = "lobby"
                r.formation_order = None
                r.formation_green_at_ms = None
                r.clear_ready()
                for p in r.players.values():
                    p.role = "spectator" if p.spectate else "racer"
                await _broadcast_lobby(r)
            elif isinstance(msg, RematchMsg):
                # Same course, same cup: back to the lobby to ready up again. Only from the
                # results — anything else has nothing to re-run.
                if r.phase != "results":
                    await _safe_send(websocket, {"type": "error", "detail": "nothing to rematch"})
                    continue
                r.discard_race()
                r.phase = "lobby"
                r.clear_ready()
                for p in r.players.values():
                    p.role = "spectator" if p.spectate else "racer"
                await _broadcast_lobby(r)
            elif isinstance(msg, CupMsg):
                if r.phase not in ("lobby", "results"):
                    await _safe_send(websocket, {"type": "error", "detail": "a cup can only change between races"})
                    continue
                r.cup = {"id": None, "name": msg.name, "race_count": msg.race_count,
                         "race_no": 0, "points": {}}
                await _broadcast_lobby(r)

            if isinstance(msg, PosMsg):
                player.gate, player.elapsed_ms, player.lat, player.lon = msg.gate, msg.elapsed_ms, msg.lat, msg.lon
                if msg.alt is not None:
                    player.alt = msg.alt
                    player.proto3 = True   # only a proto-3 client sends alt; see _check_banana
                _note_pos(r, player)
                await _check_banana(r, player)
                await _broadcast_standings(r)
                await _broadcast_world(r)
            elif isinstance(msg, BoxMsg):
                # Boxes are contested (proto 3): a taken one is dark for BOX_RESPAWN_S for
                # EVERYONE, so two pilots arriving together don't both get an item. A `box` for a
                # dark box is refused with no grant, and the refusal carries the relight time so
                # the client can fade it back in rather than guess.
                dark_until = r.boxes_dark.get(msg.id, 0)
                if dark_until > server_ms():
                    await _safe_send(websocket, {"type": "box_state", "id": msg.id,
                                                 "until_server_ms": dark_until})
                    continue
                ranking = r.ranking()
                item = roll_item(ranking.index(player.callsign), len(ranking))
                player.carrying = item
                until = server_ms() + int(BOX_RESPAWN_S * 1000)
                r.boxes_dark[msg.id] = until
                await _safe_send(websocket, {"type": "grant", "item": item, "box": msg.id})
                await _broadcast(r, {"type": "box_state", "id": msg.id, "until_server_ms": until})
                # Everyone else learns what you picked up. Deliberately not secret: knowing the
                # player behind you is holding a missile is the fun part, and it drives the
                # client's kill feed ("Steve boxed a missile").
                await _broadcast_boxed(r, player, item)
            elif isinstance(msg, FireMsg):
                if player.carrying != msg.item:
                    await _safe_send(websocket, {"type": "error", "detail": "item not carried"})
                    continue
                player.carrying = None
                if msg.heading is not None:
                    player.proto3 = True
                _tally_item(r, player.callsign, msg.item)
                await _resolve_fire(r, player, msg.item, msg.heading)
            elif isinstance(msg, FxMsg):
                # Cosmetic rebroadcast, rate-limited so a stuck client can't strobe the room.
                # The one non-cosmetic part: a shield fx opens the window _resolve_projectile()
                # checks, capped at SHIELD_MS, so a shield the relay never saw light up can never
                # block anything. Boost carries no authority at all.
                player.proto3 = True
                now_ms = server_ms()
                if now_ms - player.last_fx_ms < FX_MIN_INTERVAL_MS:
                    continue
                player.last_fx_ms = now_ms
                _tally_item(r, player.callsign, msg.item)
                ms = min(msg.ms, SHIELD_MS if msg.item == "shield" else msg.ms)
                if msg.item == "shield":
                    player.shield_until = now_ms + ms
                await _broadcast(r, {"type": "fx", "callsign": player.callsign,
                                     "item": msg.item, "ms": ms})
            elif isinstance(msg, TrippedMsg):
                # "I flew into banana <id>". Validated against this client's own last known
                # position — the relay still never takes a client's word for where it is, it just
                # checks the claim against what that client already reported about itself.
                player.proto3 = True
                banana = next((b for b in r.bananas if b["id"] == msg.id), None)
                if banana is None or server_ms() < banana["armed_at"]:
                    continue
                if player.lat is None or player.lon is None:
                    continue
                if _meters_between(player.lat, player.lon, banana["lat"], banana["lon"]) > BANANA_RADIUS_M + TRIP_SLACK_M:
                    await _safe_send(websocket, {"type": "error", "detail": "too far from that banana"})
                    continue
                await _resolve_banana(r, player, banana)
            elif isinstance(msg, (FinishMsg, DnfMsg)):
                # Proto 4. A refusal is an `error` to the sender alone and changes nothing; the
                # connection is never closed for it, like every other refused frame.
                accept = _accept_finish if isinstance(msg, FinishMsg) else _accept_dnf
                why = await accept(r, player, msg)
                if why is not None:
                    await _safe_send(websocket, {"type": "error", "detail": f"{msg.type} rejected: {why}"})
    except WebSocketDisconnect:
        pass
    finally:
        # Captured before any mutation below: the registry's release snapshot wants to remember
        # who was host on the way out, and host migration (next) can zero that out first when
        # this departure empties the room.
        last_host = r.host
        if player is not None:
            r.players.pop(player.callsign, None)
            # Host migration: the longest-connected remaining player, which is the first key of
            # an insertion-ordered dict. A room with a host nobody can reach is a dead lobby.
            if r.host == player.callsign:
                r.host = next(iter(r.players), None)
        if not r.players:
            _registry_release(r, time.monotonic(), last_host)
            r.cancel_countdown()
            r.cancel_tasks()
            r.discard_race()
            rooms.pop(room, None)
            _hub_mark_dirty()
        elif player is not None:
            # A racer who drops is out (DNF at their last gate) — which can be what ends the race.
            await _note_disconnect(r, player.callsign)
            await _broadcast_lobby(r)
            _hub_mark_dirty()


# ===================================================================================
# The matchmaking hub (1.2.0, proto 5) — WS /ws/hub.
#
# A second socket, deliberately not a second protocol on the first one: a race room is a race,
# and the hub is the ramp you stand on before you pick one. Nothing here can change what happens
# in a race room, and a pilot who never opens the hub races exactly as they did in 1.1.0.
#
# All of it is in-memory (see PROTOCOL.md's trust model): presence is a dict that a restart
# empties, and that is correct — presence that outlives the process is a lie about who is online.
# The ONE thing proto 5 persists is pilot identity, which is a different kind of fact.
#
# Trust model: `room` and `activity` in a `where` frame are SELF-REPORTED and cosmetic, exactly
# like `pos`. A client can claim to be anywhere. The authoritative list of who is actually in a
# room is the registry's, which is built from live race sockets and not from anything a hub
# client says.
# ===================================================================================


class HubClient:
    __slots__ = ("ws", "pilot_id", "callsign", "model", "room", "activity",
                 "last_seen", "last_busy", "last_push", "dirty")

    def __init__(self, ws: WebSocket, pilot_id: str, callsign: str, model: str, now: float):
        self.ws = ws
        self.pilot_id = pilot_id
        self.callsign = callsign
        self.model = model
        self.room: Optional[str] = None
        self.activity = "idle"
        self.last_seen = now       # monotonic; two missed heartbeats past this and they are dropped
        self.last_busy = now       # …the last time they reported doing something, for idle_seconds
        self.last_push = 0.0       # monotonic of the last presence/rooms push, for the 1 Hz coalescing
        self.dirty = True


hub: dict[str, HubClient] = {}          # pilot_id -> client. One connection per pilot; a second replaces it.
_hub_task: Optional[asyncio.Task] = None


# ------------------------------------------------------------------ room registry (proto 5)
# A room self-registers on its first join and is listed publicly to every hub client — this is
# what lets a pilot find a race without already knowing its code. No private rooms in this
# version (future work — see PROTOCOL.md).
#
# The registry is deliberately thin: while a room is LIVE, `rooms.get(code)` is the only source
# of truth for its host/course/pilots/phase, and registry_rows() projects that fresh every time
# it is asked, exactly like everything else in this file's trust model. The registry ADDS exactly
# one thing rooms.py cannot: a code and a snapshot survive 10 minutes after the room empties and
# `rooms.pop()` drops the live Room object (test_ws_disconnect_cleans_up_an_empty_room, unchanged)
# — which is what lets a reopen within that window return to the same code.

ROOM_STATUS_FROM_PHASE = {"lobby": "boarding", "countdown": "launching", "formation": "launching",
                          "racing": "racing", "results": "results"}


class RegistryEntry:
    __slots__ = ("code", "emptied_at", "snapshot")

    def __init__(self, code: str):
        self.code = code
        self.emptied_at: Optional[float] = None   # monotonic; None while the room is occupied
        self.snapshot: Optional[dict] = None       # last projection, captured only at release


registry: dict[str, RegistryEntry] = {}


def room_status_line(room: "Room", now_ms: int) -> str:
    """Pure: the one status-specific line PROTOCOL.md's registry section names — seconds to
    start during a countdown, or the leader's progress during a race. Empty otherwise; a lobby
    or a results screen already says everything the status word needs."""
    if room.phase == "countdown" and room.countdown_start_at_ms is not None:
        secs = max(0, round((room.countdown_start_at_ms - now_ms) / 1000))
        return f"starts in {secs}s"
    if room.phase == "formation" and room.formation_green_at_ms is not None:
        secs = max(0, round((room.formation_green_at_ms - now_ms) / 1000))
        return f"pace lap, green in {secs}s"
    if room.phase == "racing":
        order = room.ranking()
        if order:
            leader = order[0]
            total = (room.course or {}).get("gates")
            of = f" of {total}" if total else ""
            return f"gate {room.players[leader].gate}{of} — {leader} leads"
    return ""


def registry_projection(room: "Room", now_ms: int) -> dict:
    """Pure: what the registry shows for a room that is CURRENTLY live. Everything here is read
    straight off the Room the race socket already maintains — nothing is duplicated or cached."""
    return {
        "host": room.host,
        "course": room.course,
        "cup": room.cup_public(),
        "format": "cup" if room.cup is not None else "race",
        "status": ROOM_STATUS_FROM_PHASE.get(room.phase, room.phase),
        "line": room_status_line(room, now_ms),
        "pilots": len(room.players),
        "callsigns": list(room.players.keys()),
    }


def _prune_registry(now: float) -> None:
    """Drop entries whose reopen window has elapsed. Lazy, like _prune_bananas — no background
    task, just checked at the top of anything that reads or changes the registry.

    A live room (rooms.get(code) is not None) is never pruned regardless of what its
    `emptied_at` says — occupancy is ground truth here, same as everywhere else in this file,
    and a stale marker must never expire a room somebody is still standing in.
    """
    for code in [c for c, e in registry.items()
                if e.emptied_at is not None and now - e.emptied_at > REGISTRY_TTL_S
                and rooms.get(c) is None]:
        del registry[code]


def _registry_touch(room: "Room", now: float) -> None:
    """A room's first join, or a reopen within the TTL window. The code is the dict key, so it
    is kept automatically; a reopen just clears the empty marker. If the room's own host — set by
    the ordinary first-joiner-is-host rule right before this runs — happens to be nobody yet
    (can't happen post-join, but keeps this safe to call early) this does nothing special: the
    host that "comes back" on a reopen is simply whoever the join logic already made host, which
    is the original host whenever they are the one who reopens it.
    """
    _prune_registry(now)
    entry = registry.get(room.name)
    if entry is None:
        registry[room.name] = RegistryEntry(room.name)
    else:
        entry.emptied_at = None
        entry.snapshot = None


def _registry_release(room: "Room", now: float, last_host: Optional[str]) -> None:
    """The room just went empty (its Room object is about to be dropped). Keep the code and a
    snapshot of what it last looked like for REGISTRY_TTL_S, so a reopen has something to return
    to and a browsing pilot sees "closing soon" rather than the room vanishing mid-glance.

    `last_host` is the caller's own room.host, read BEFORE host-migration logic reset it to None
    for an about-to-be-empty room — by the time this runs, room.host is already gone.
    """
    entry = registry.get(room.name)
    if entry is None:
        return
    entry.emptied_at = now
    snap = registry_projection(room, server_ms())
    snap.update(host=last_host, pilots=0, callsigns=[])
    entry.snapshot = snap


def registry_rows(now: float) -> list[dict]:
    """The `rooms` payload: every room worth listing, live or within its reopen window. `now` is
    time.monotonic(), matching every other TTL/coalescing check in this file."""
    _prune_registry(now)
    now_ms = server_ms()
    rows = []
    for entry in registry.values():
        room = rooms.get(entry.code)
        if room is not None:
            proj = registry_projection(room, now_ms)
        else:
            proj = dict(entry.snapshot) if entry.snapshot else {
                "host": None, "course": None, "cup": None, "format": "race",
                "status": "empty", "line": "", "pilots": 0, "callsigns": []}
            proj["status"] = "empty"
            proj["line"] = ""
        rows.append({"code": entry.code, **proj})
    rows.sort(key=lambda r: (r["status"] == "empty", r["code"]))
    return rows


def presence_rows(clients, now: float) -> list[dict]:
    """Pure: the `presence` payload, given whatever is currently connected.

    `idle_seconds` is how long since this pilot last reported *doing* something, and is 0 while
    they are doing it — not seconds since their last heartbeat, which would be a constant 0..5
    for everyone and tell you nothing. Sorted busy-first then by callsign so the list does not
    reshuffle under the reader every second.
    """
    rows = [{"callsign": c.callsign, "model": c.model, "activity": c.activity, "room": c.room,
             "idle_seconds": 0 if c.activity != "idle" else max(0, int(now - c.last_busy))}
            for c in clients]
    rows.sort(key=lambda r: (r["activity"] == "idle", r["idle_seconds"], r["callsign"].casefold()))
    return rows


def _hub_mark_dirty() -> None:
    """Something changed that every hub client's view depends on. The actual sending is throttled
    per client by _hub_flush — this only records that a push is owed."""
    for c in hub.values():
        c.dirty = True


async def _hub_push(client: HubClient, now: float) -> None:
    client.dirty = False
    client.last_push = now
    ok = await _safe_send(client.ws, {"type": "presence", "pilots": presence_rows(hub.values(), now)})
    if ok:
        await _safe_send(client.ws, {"type": "rooms", "rooms": registry_rows(now)})


async def _hub_flush(now: float, always: Optional[HubClient] = None) -> None:
    """Send to every client that is owed a push AND is outside its 1 Hz window.

    A quiet ramp gets its update immediately (last_push is already a second old); a busy one
    coalesces, and the 1 Hz _hub_loop picks up whatever was held back. `always` forces one client
    through regardless — used right after `welcome`, so a pilot who just arrived is not shown an
    empty ramp for up to a second.
    """
    for c in list(hub.values()):
        if c is always or (c.dirty and now - c.last_push >= HUB_PUSH_MIN_S):
            await _hub_push(c, now)


async def _hub_loop() -> None:
    """The hub's one background task: flush coalesced pushes, and reap clients whose heartbeats
    stopped. Started when the first client connects and cancelled when the last leaves, so an
    idle server runs no timers at all."""
    try:
        while True:
            await asyncio.sleep(HUB_TICK_S)
            now = time.monotonic()
            # A socket that is merely half-open never raises, so the heartbeat is the only thing
            # that can tell us this pilot is gone. Two missed beats plus a grace beat.
            stale = [c for c in hub.values() if now - c.last_seen > HUB_DROP_S]
            for c in stale:
                if hub.get(c.pilot_id) is c:
                    hub.pop(c.pilot_id, None)
                try:
                    await c.ws.close(code=1001)
                except Exception:
                    pass
            if stale:
                _hub_mark_dirty()
            # A live race's status line (gate N of M, who leads) changes on every gate without
            # any hub-side event to hang a dirty flag on — pos frames are the race socket's
            # business, not the hub's. Ticking the registry itself is what keeps that line
            # current, still bounded to the same 1 Hz this loop already runs at.
            if registry:
                _hub_mark_dirty()
            await _hub_flush(now)
    except asyncio.CancelledError:
        raise
    except Exception:
        logging.exception("hub loop died")


def _hub_start() -> None:
    global _hub_task
    if _hub_task is None or _hub_task.done():
        _hub_task = asyncio.create_task(_hub_loop())


def _hub_stop_if_idle() -> None:
    global _hub_task
    if not hub and _hub_task is not None:
        _hub_task.cancel()
        _hub_task = None


COURSE_ENV_HASH_RANGES = {"windKt": (0, 200), "windDir": (0, 360), "turbulence": (0, 100), "precip": (0, 100)}


def course_env_hash_part(course: dict):
    """Pure: race.js's Course.envHashPart() — a course env's wind/turbulence/precip as
    ["wx", kt, dir, turbulence, precip] (clamped, rounded half up, direction only with wind), or None
    when all three are zero. Buildings, time, clouds and fog are cosmetic and never reach the hash,
    so a course with a cosmetic-only env keeps the hash (and leaderboard) it had without one."""
    env = course.get("env")
    w = env.get("weather") if isinstance(env, dict) else None
    if not isinstance(w, dict):
        return None

    def r(key):
        v = w.get(key)
        if isinstance(v, bool) or v is None:
            return 0
        try:
            f = float(v)
        except (TypeError, ValueError):
            return 0
        if f != f or f in (float("inf"), float("-inf")):
            return 0
        lo, hi = COURSE_ENV_HASH_RANGES[key]
        return math.floor(min(hi, max(lo, f)) + 0.5)

    kt, tu, pr = r("windKt"), r("turbulence"), r("precip")
    if not (kt or tu or pr):
        return None
    return ["wx", kt, r("windDir") % 360 if kt else 0, tu, pr]


def course_hash(course: dict) -> str:
    """Pure: race.js's Course.hash() — FNV-1a over the rounded geometry plus the aircraft lock plus
    the time-changing part of env (course_env_hash_part).
    Must agree with the client byte for byte, or every vote-won race opens on a COURSE MISMATCH
    banner; race/test/course_hashes.json pins both sides (test_server.py and run.js)."""
    payload = [
        course.get("aircraftId"),
        [[f"{float(g['lat']):.6f}", f"{float(g['lon']):.6f}", f"{float(g['alt']):.1f}",
          f"{float(g.get('radius', DEFAULT_GATE_RADIUS_M)):.1f}"] for g in course["gates"]],
    ]
    wx = course_env_hash_part(course)
    if wx:
        payload.append(wx)
    s = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def course_length_km(gates: list[dict]) -> float:
    """Pure: straight-line gate-to-gate distance, summed — the same flat-earth approximation
    _meters_between uses everywhere else in this file. Not the flown distance (turns cut corners,
    climbs add real distance) but plenty for a homepage "12.4 km" chip."""
    total_m = 0.0
    for a, b in zip(gates, gates[1:]):
        total_m += _meters_between(a["lat"], a["lon"], b["lat"], b["lon"])
    return round(total_m / 1000.0, 1)


def load_courses(path: str) -> list[dict]:
    """The shared course list: race/courses/index.json plus each file it names, as catalog rows.
    A broken entry is skipped with a warning rather than taking the whole catalog down.

    `cup` and `difficulty` come from the index entry (docs-only fields, same posture as `name`'s
    parenthetical difficulty tag — see race/courses/CUPS.md); a course with neither is simply
    "Other"/no chip on the client. `length_km` and `gates` (lat/lon/alt/radius, for a mini route
    map) are derived from the course file itself, never hand-entered, so they can't drift from the
    real geometry the way a typed-in number could.
    """
    try:
        with open(os.path.join(path, "index.json"), encoding="utf-8") as f:
            index = json.load(f)
    except (OSError, ValueError) as e:
        logging.getLogger("uvicorn.error").warning("course index unreadable at %s: %s", path, e)
        return []
    rows = []
    for entry in index if isinstance(index, list) else []:
        try:
            with open(os.path.join(path, os.path.basename(entry["file"])), encoding="utf-8") as f:
                raw = json.load(f)
            gates = raw.get("gates")
            if not gates:
                raise ValueError("no gates")
            rows.append({
                "course_id": entry["id"], "course_hash": course_hash(raw),
                "course_name": raw.get("name") or entry.get("name") or entry["id"],
                "start_type": raw.get("startType") or "air", "gates": len(gates),
                "cup": entry.get("cup"), "difficulty": entry.get("difficulty"),
                "length_km": course_length_km(gates),
                "gate_coords": [{"lat": g["lat"], "lon": g["lon"], "alt": g.get("alt", 0.0),
                                 "radius": g.get("radius", DEFAULT_GATE_RADIUS_M)} for g in gates],
            })
        except (OSError, ValueError, KeyError, TypeError) as e:
            logging.getLogger("uvicorn.error").warning("course %r skipped: %s", entry, e)
    return rows


COURSES: list[dict] = []


def refresh_courses() -> int:
    """Re-read the catalog from COURSES_DIR. Called at startup and whenever a vote opens, so a
    `git pull` over the read-only mount reaches the next room with no restart. A re-read that
    comes back empty (a pull caught mid-write, a vanished mount) keeps the last good catalog."""
    global COURSES
    rows = load_courses(COURSES_DIR)
    if rows:
        COURSES = rows
    return len(COURSES)


def course_catalog(conn: sqlite3.Connection) -> list[dict]:
    """The vote's pool: every course in the shared list, whether or not anyone has raced it yet,
    each with how many runs it has on this board."""
    counts = {r["course_id"]: r["n"] for r in conn.execute(
        "SELECT course_id, COUNT(*) AS n FROM runs GROUP BY course_id")}
    return [{**c, "runs": counts.get(c["course_id"], 0)} for c in COURSES]


def runs_by_callsigns(conn: sqlite3.Connection, callsigns: list[str]) -> dict[str, int]:
    """{course_id: runs these pilots have on it} — the bias the draw and the tie-break both use."""
    if not callsigns:
        return {}
    marks = ",".join("?" * len(callsigns))
    return {r["course_id"]: r["n"] for r in conn.execute(
        f"""SELECT course_id, COUNT(*) AS n FROM runs
            WHERE lower(trim(callsign)) IN ({marks}) GROUP BY course_id""",
        [callsign_key(cs) for cs in callsigns])}


def _draw_vote_in_thread(callsigns: list[str]):
    """The vote draw's disk half, off the event loop like every other query the sockets make."""
    refresh_courses()
    with connect() as conn:
        stats = course_catalog(conn)
        seen = runs_by_callsigns(conn, callsigns)
    return vote_candidates(stats, seen, VOTE_CANDIDATES), seen


def _resolve_course_in_thread(course_id: str):
    """A winning course_id -> the course dict a race needs, or None if this server cannot resolve
    it (which is what makes the vote fall back to the host's own pick)."""
    pool = list(COURSES)
    if course_id == SURPRISE_ME:
        if not pool:
            return None
        row = random.choice(pool)
    else:
        row = next((c for c in pool if c["course_id"] == course_id), None)
        if row is None:
            return None
    return {"course_id": row["course_id"], "course_hash": row["course_hash"],
            "name": row["course_name"], "start_type": row["start_type"], "gates": row["gates"]}


def _claim_in_thread(token: Optional[str], callsign: str):
    """The identity step, off the event loop — it is the only disk access the hub does per pilot.
    Returns plain dicts so nothing holding a sqlite3 connection escapes the worker thread."""
    with connect() as conn:
        row, new_token, err = claim_callsign(conn, token, callsign)
        return (dict(row) if row is not None else None), new_token, err


def _ramp_ping_in_thread(pilot_id: str):
    with connect() as conn:
        ok, err = try_ramp_ping(conn, pilot_id)
        return ok, err


@app.websocket("/ws/hub")
async def ws_hub(websocket: WebSocket):
    await websocket.accept()
    client: Optional[HubClient] = None
    gate = RateGate(WS_RATE_LIMIT_PER_S)
    try:
        while True:
            raw_text = await websocket.receive_text()

            # Same two guards as the race socket, same codes — see PROTOCOL.md "Framing".
            if len(raw_text.encode("utf-8")) > MAX_WS_MSG_BYTES:
                await websocket.close(code=1009)
                return
            now = time.monotonic()
            if not gate.allow(now):
                if gate.violations > WS_MAX_VIOLATIONS:
                    await websocket.close(code=1008)
                    return
                await _safe_send(websocket, {"type": "error", "detail": "rate limited"})
                continue

            try:
                msg = parse_message(json.loads(raw_text), _HUB_MSG_MODELS)
            except (json.JSONDecodeError, ValueError, ValidationError) as e:
                await _safe_send(websocket, {"type": "error", "detail": str(e)[:200]})
                continue

            if isinstance(msg, HubHelloMsg):
                row, new_token, err = await asyncio.to_thread(
                    _claim_in_thread, msg.pilot_token, msg.callsign)
                if err is not None:
                    # A refused claim leaves the socket open: the pilot picks another name and
                    # says hello again. Nothing about their identity changed.
                    await _safe_send(websocket, {"type": "error", "detail": err})
                    continue
                now = time.monotonic()
                # One connection per pilot. A second (a reloaded tab, a second browser) replaces
                # the first rather than showing the same pilot on the ramp twice.
                previous = hub.get(row["pilot_id"])
                if previous is not None and previous.ws is not websocket:
                    hub.pop(row["pilot_id"], None)
                    try:
                        await previous.ws.close(code=1001)
                    except Exception:
                        pass
                if client is not None:      # a second hello on this socket = a rename
                    hub.pop(client.pilot_id, None)
                client = HubClient(websocket, row["pilot_id"], row["callsign"], msg.model, now)
                hub[client.pilot_id] = client
                # `pilot_token` is echoed when we did not mint one, so the frame has one shape and
                # the client can store what it is given without checking whether it is new.
                await _safe_send(websocket, {"type": "welcome", "pilot_id": client.pilot_id,
                                             "pilot_token": new_token or msg.pilot_token,
                                             "proto": HUB_PROTO})
                _hub_start()
                _hub_mark_dirty()
                await _hub_flush(now, always=client)
                continue

            if client is None:
                await _safe_send(websocket, {"type": "error", "detail": "hello first"})
                continue
            client.last_seen = now

            if isinstance(msg, HeartbeatMsg):
                pass                        # the heartbeat IS the last_seen update above
            elif isinstance(msg, WhereMsg):
                if msg.room is not None and not ROOM_PATTERN.match(msg.room):
                    await _safe_send(websocket, {"type": "error",
                                                 "detail": f"not a room code: {msg.room!r}"})
                    continue
                client.room, client.activity = msg.room, msg.activity
                if msg.activity != "idle":
                    client.last_busy = now
                _hub_mark_dirty()
                await _hub_flush(now)
            elif isinstance(msg, ListMsg):
                # An explicit ask is answered now, not on the next tick — it costs one frame and
                # it is what a panel opening for the first time does.
                await _hub_push(client, now)
            elif isinstance(msg, RampPingMsg):
                # Deliberately scarce (PROTOCOL.md) — not per-room configurable, and the budget
                # lives on the pilot row (see try_ramp_ping) so a redeploy cannot refill it.
                ok, err = await asyncio.to_thread(_ramp_ping_in_thread, client.pilot_id)
                if not ok:
                    await _safe_send(websocket, {"type": "error", "detail": err})
                    continue
                for other in list(hub.values()):
                    if other is not client:
                        await _safe_send(other.ws, {"type": "ramp_ping", "from": client.callsign})
    except WebSocketDisconnect:
        pass
    finally:
        if client is not None and hub.get(client.pilot_id) is client:
            hub.pop(client.pilot_id, None)
            _hub_mark_dirty()
            await _hub_flush(time.monotonic())
        _hub_stop_if_idle()


# ===================================================================================
# Read-only results API and the landing page (0.11.0). Everything here only SELECTs: the one and
# only write to these tables is persist_race(), once per finished lobby race. Same CORS as the
# rest of the API, no auth (a secret shipped in public JS protects nothing — see the top of this
# file), and nothing here can change what the relay does.
# ===================================================================================

def _cup_rows(conn: sqlite3.Connection, cups: list) -> list[dict]:
    """Cup rows -> API dicts with `open`, `races_run` and `standings`, in three queries however
    many cups there are. Standings order matches cup_standings(): points, then callsign."""
    ids = [c["id"] for c in cups]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    standings: dict[int, list] = {i: [] for i in ids}
    for r in conn.execute(
            f"""SELECT r.cup_id AS cup_id, rr.callsign AS callsign, SUM(rr.points) AS points,
                       COUNT(*) AS races,
                       SUM(CASE WHEN rr.status = 'finished' AND rr.pos = 1 THEN 1 ELSE 0 END) AS wins
                FROM race_results rr JOIN races r ON r.id = rr.race_id
                WHERE r.cup_id IN ({marks}) GROUP BY r.cup_id, rr.callsign""", ids).fetchall():
        standings[r["cup_id"]].append({"callsign": r["callsign"], "points": r["points"],
                                       "races": r["races"], "wins": r["wins"]})
    run = {r[0]: r[1] for r in conn.execute(
        f"SELECT cup_id, COUNT(*) FROM races WHERE cup_id IN ({marks}) GROUP BY cup_id", ids).fetchall()}
    out = []
    for c in cups:
        d = dict(c)
        d["open"] = d["closed_at"] is None
        d["races_run"] = run.get(c["id"], 0)
        d["standings"] = sorted(standings[c["id"]], key=lambda s: (-s["points"], s["callsign"]))
        out.append(d)
    return out


@app.get("/races/recent")
def races_recent(limit: int = Query(10, ge=1, le=100)):
    """The most recently finished lobby races, newest first, each with its results best-first."""
    with connect() as conn:
        races = conn.execute(
            """SELECT r.id, r.room, r.course_hash, r.course_name, r.started_at, r.cup_id,
                      c.name AS cup_name
               FROM races r LEFT JOIN cups c ON c.id = r.cup_id ORDER BY r.id DESC LIMIT ?""",
            (limit,)).fetchall()
        results: dict[int, list] = {r["id"]: [] for r in races}
        if results:
            marks = ",".join("?" * len(results))
            for r in conn.execute(
                    f"""SELECT race_id, callsign, pos, go_time_ms, status, points, model
                        FROM race_results WHERE race_id IN ({marks}) ORDER BY race_id, pos""",
                    list(results)).fetchall():
                results[r["race_id"]].append({k: r[k] for k in (
                    "callsign", "pos", "go_time_ms", "status", "points", "model")})
    return [{**dict(r), "results": results[r["id"]]} for r in races]


@app.get("/races/{race_id}/replay")
def race_replay(race_id: int):
    """One finished lobby race, with results and decoded traces -- enough for a client to render a
    full-race replay. A race with no race_traces rows still returns (results, empty traces): not
    every racer sends a trace (an old client, or one that failed validate_lobby_trace()), and that
    is a legitimate, documented gap rather than a 404."""
    with connect() as conn:
        race = conn.execute(
            """SELECT r.id, r.room, r.course_hash, r.course_name, r.started_at, r.cup_id
               FROM races r WHERE r.id = ?""", (race_id,)).fetchone()
        if race is None:
            raise HTTPException(404, "No such race.")
        results = [dict(r) for r in conn.execute(
            """SELECT callsign, pos, go_time_ms, status, points, model, stats_json
               FROM race_results WHERE race_id = ? ORDER BY pos""", (race_id,)).fetchall()]
        for r in results:
            r["stats"] = json.loads(r.pop("stats_json"))
        traces = [dict(t) for t in conn.execute(
            """SELECT callsign, model, time_ms, go_elapsed_ms, trace_blob, created_at
               FROM race_traces WHERE race_id = ? ORDER BY callsign""", (race_id,)).fetchall()]
        for t in traces:
            t["trace"] = json.loads(t.pop("trace_blob"))
    return {"race": dict(race), "results": results, "traces": traces}


@app.get("/cups/{cup_id}")
def cup_detail(cup_id: int):
    """One cup: its standings so far and the races that made them."""
    with connect() as conn:
        row = conn.execute(
            "SELECT id, room, name, race_count, created_at, closed_at FROM cups WHERE id = ?",
            (cup_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "No such cup.")
        cup = _cup_rows(conn, [row])[0]
        cup["races"] = [dict(r) for r in conn.execute(
            """SELECT r.id, r.course_hash, r.course_name, r.started_at,
                      (SELECT callsign FROM race_results
                        WHERE race_id = r.id AND status = 'finished' AND pos = 1) AS winner
               FROM races r WHERE r.cup_id = ? ORDER BY r.id""", (cup_id,)).fetchall()]
    return cup


@app.get("/cups")
def cups_list(room: Optional[str] = Query(default=None, pattern=ROOM_PATTERN.pattern),
              open_only: bool = Query(False, alias="open"), limit: int = Query(20, ge=1, le=100)):
    """Cups, newest first — one room's with `room`, only the unfinished ones with `open=1`."""
    where, args = [], []
    if room is not None:
        where.append("room = ?")
        args.append(room)
    if open_only:
        where.append("closed_at IS NULL")
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, room, name, race_count, created_at, closed_at FROM cups"
            + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC LIMIT ?",
            (*args, limit)).fetchall()
        return _cup_rows(conn, rows)


def _resolve_pilot_ident(conn: sqlite3.Connection, ident: str) -> Optional[sqlite3.Row]:
    """A path segment that's either a pilot_id (uuid4 hex) or a callsign (case-insensitive) ->
    the pilot row, or None. Tried as a pilot_id first since that's an exact, unambiguous key; a
    callsign that happens to collide with a hex uuid string is not a realistic concern (32 hex
    chars is not a callsign anyone types)."""
    row = conn.execute("SELECT * FROM pilots WHERE pilot_id = ?", (ident,)).fetchone()
    if row is not None:
        return row
    return conn.execute("SELECT * FROM pilots WHERE callsign_key = ?", (callsign_key(ident),)).fetchone()


@app.get("/pilots")
def pilots_list(limit: int = Query(50, ge=1, le=200)):
    """Known pilots, most recently active first -- same shape/limit posture as /courses and
    /races/recent. Never returns a token or its hash."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT pilot_id, callsign, created_at, last_seen FROM pilots"
            " ORDER BY last_seen DESC, created_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


@app.get("/pilots/{ident}")
def pilot_detail(ident: str = Path(min_length=1, max_length=64),
                 vs: Optional[str] = Query(default=None, max_length=64)):
    """One pilot's public profile: personal bests, lobby races, wins, and the raw inputs a medal
    system would need (this codebase has no medal concept yet -- see the report/CHANGELOG entry
    for this route). `vs=<pilot_id-or-callsign>` adds a head-to-head over races both pilots have a
    race_results row in, compared by go_time_ms. Never returns a token or its hash; pilot_id
    itself is not secret (it is the client's own lookup key, already round-tripped through
    localStorage and this very URL)."""
    with connect() as conn:
        pilot = _resolve_pilot_ident(conn, ident)
        if pilot is None:
            raise HTTPException(404, "No such pilot.")
        pid = pilot["pilot_id"]
        bests = [dict(r) for r in conn.execute(
            """SELECT course_hash, course_id, course_name, MIN(time_ms) AS time_ms
               FROM runs WHERE pilot_id = ? GROUP BY course_hash ORDER BY course_name""",
            (pid,)).fetchall()]
        race_rows = conn.execute(
            """SELECT race_id, pos, go_time_ms, status, points FROM race_results
               WHERE pilot_id = ? ORDER BY race_id DESC""", (pid,)).fetchall()
        races = [dict(r) for r in race_rows]
        wins = sum(1 for r in races if r["pos"] == 1 and r["status"] == "finished")
        records_taken = conn.execute(
            "SELECT COUNT(*) FROM record_events WHERE pilot_id = ?", (pid,)).fetchone()[0]
        out = {
            "pilot_id": pid, "callsign": pilot["callsign"], "created_at": pilot["created_at"],
            "last_seen": pilot["last_seen"], "personal_bests": bests,
            "races": races, "race_count": len(races), "wins": wins,
            # Deferred (see report): no medal system exists server-side yet. These are the raw
            # counts one would be built from -- race wins, cup points earned, records taken.
            "medal_inputs": {"wins": wins, "cup_points": sum(r["points"] for r in races),
                             "records_taken": records_taken},
        }
        if vs:
            other = _resolve_pilot_ident(conn, vs)
            if other is None:
                out["head_to_head"] = None
            else:
                mine = {r["race_id"]: r for r in race_rows}
                theirs = {r["race_id"]: r for r in conn.execute(
                    """SELECT race_id, pos, go_time_ms, status FROM race_results
                       WHERE pilot_id = ?""", (other["pilot_id"],)).fetchall()}
                shared = sorted(set(mine) & set(theirs))
                wins_me = wins_them = 0
                h2h = []
                for rid in shared:
                    m, t = mine[rid], theirs[rid]
                    m_won = m["status"] == "finished" and (t["status"] != "finished" or m["pos"] < t["pos"])
                    t_won = t["status"] == "finished" and (m["status"] != "finished" or t["pos"] < m["pos"])
                    winner = pilot["callsign"] if m_won else (other["callsign"] if t_won else None)
                    wins_me += 1 if m_won else 0
                    wins_them += 1 if t_won else 0
                    h2h.append({"race_id": rid, "winner": winner,
                               "my_go_time_ms": m["go_time_ms"], "their_go_time_ms": t["go_time_ms"]})
                out["head_to_head"] = {"callsign": other["callsign"], "shared_races": len(shared),
                                       "wins": wins_me, "losses": wins_them, "races": h2h}
    return out


def _room_label(name: str) -> str:
    """A room's real code is how a friend joins it -- never send it to a page anyone with the link
    can open. This is a stable, non-reversible label (8 hex chars of sha256) so the same room reads
    as the same tile across polls without revealing or hinting at the code itself."""
    return hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]


@app.get("/stats")
def stats(request: Request):
    """Homepage hero tiles: races flown, known pilots, gates crossed, missiles landed. Cheap
    aggregates over tables that already exist, cached briefly since every open tab polls this."""
    _get_rate_limit(client_ip(request), time.time())

    def build():
        with connect() as conn:
            races = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
            races += conn.execute(
                "SELECT COUNT(*) FROM race_results WHERE status = 'finished'").fetchone()[0]
            pilots = conn.execute("SELECT COUNT(*) FROM pilots").fetchone()[0]
            gates = conn.execute("SELECT COALESCE(SUM(gates), 0) FROM runs").fetchone()[0]
            missiles_hit = 0
            for (blob,) in conn.execute("SELECT stats_json FROM race_results"):
                try:
                    by_item = json.loads(blob).get("hits_landed_by_item") or {}
                except (TypeError, ValueError):
                    continue
                missiles_hit += by_item.get("missile", 0)
        return {"races": races, "pilots": pilots, "gates": gates, "missiles_hit": missiles_hit}

    return _cached("stats", GET_CACHE_TTL_S, build)


@app.get("/rooms/live")
def rooms_live(request: Request):
    """Departures board: rooms currently in the air. Never the join code (`_room_label` hashes it),
    never a pilot_token, never chat -- just what a spectator deciding whether to watch would want."""
    _get_rate_limit(client_ip(request), time.time())

    def build():
        out = []
        for name, room in rooms.items():
            if not room.players:
                continue
            order = room.ranking()
            leader_gate = room.players[order[0]].gate if order else None
            total_gates = (room.course or {}).get("gates")
            out.append({
                "room": _room_label(name),
                "course": (room.course or {}).get("name"),
                "phase": room.phase,
                "gate_progress": ({"gate": leader_gate, "of": total_gates}
                                  if room.phase == "racing" else None),
                "pilot_callsigns": [p.callsign for p in room.players.values() if not p.spectate],
                "spectators": sum(1 for p in room.players.values() if p.spectate),
            })
        out.sort(key=lambda r: r["room"])
        return out

    return _cached("rooms_live", GET_CACHE_TTL_S, build)


@app.get("/bookmarklet")
def bookmarklet_endpoint():
    """The install panel's real, draggable bookmarklet -- built from race/bookmarklet.txt at
    server start (see load_bookmarklet()), never retyped into the page by hand."""
    if BOOKMARKLET is None:
        raise HTTPException(503, "bookmarklet unavailable")
    return BOOKMARKLET


# ===================================================================================
# Tile proxy + disk cache (0.7-1.0 series). The HQ site (race/server/static/js/config.js's
# TILE_SOURCES) used to point straight at third-party hosts (AWS Terrarium terrain, Esri/EOX
# imagery and labels); every `url` there is now this server's own /tiles/... route instead, so the
# CSP can stay img-src 'self' and one flaky third-party host cannot break the globe for everyone
# at once. RACE_TILE_PROXY is the one killswitch: off, every route below 404s and an operator
# reverts config.js to point at the hosts directly (see the CHANGELOG entry).
#
# z/x/y are typed as `int` path parameters, which is what actually stops a path-traversal
# attempt: FastAPI's int converter rejects anything that isn't a plain non-negative-looking
# integer literal (`../`, `1.5`, `-1` as a *string with a sign* all fail to route at all, landing
# a plain 404 before this code ever runs), and _valid_tile_coords() then checks the numeric range
# for that zoom level. Nothing here ever builds a filesystem path or a URL from unvalidated input.
# ===================================================================================

_last_tile: dict[str, float] = {}
TILE_MIN_INTERVAL_S = 1.0 / TILE_RATE_PER_S if TILE_RATE_PER_S > 0 else 0.0


def _tile_rate_limit(ip: str, now: float) -> None:
    """Same shape as _get_rate_limit, its own budget: tile fetches are far more frequent than a
    leaderboard poll (panning a map can fire a dozen requests a second), so this has its own,
    much higher default (RACE_TILE_RATE_PER_S, 20/s) rather than sharing GET_MIN_INTERVAL_S."""
    if TILE_MIN_INTERVAL_S <= 0:
        return
    with _lock:
        if now - _last_tile.get(ip, 0) < TILE_MIN_INTERVAL_S:
            raise HTTPException(429, "Too many tile requests; slow down.")
        _last_tile[ip] = now
        if len(_last_tile) > 5000:
            _last_tile.clear()


def _valid_tile_coords(z: int, x: int, y: int, max_zoom: int) -> bool:
    """Pure: is (z, x, y) a real tile address at or under this source's max zoom? Called AFTER
    FastAPI's int path converter has already rejected anything that isn't a plain integer."""
    if not (0 <= z <= max_zoom):
        return False
    n = 2 ** z
    return 0 <= x < n and 0 <= y < n


def _tile_cache_path(kind: str, z: int, a: int, b: int, ext: str) -> str:
    # Every component is already an int by the time it reaches here (path converter + the
    # _valid_tile_coords check above), so this can never escape TILE_CACHE_DIR.
    return os.path.join(TILE_CACHE_DIR, kind, str(z), str(a), f"{b}.{ext}")


def _tile_cache_read(path: str) -> Optional[bytes]:
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    try:
        os.utime(path, None)     # bump mtime so the LRU sweep treats a re-read as freshly used
    except OSError:
        pass
    return data


def _tile_cache_evict(cap_mb: Optional[float] = None) -> None:
    """The simplest correct LRU: walk the whole cache dir, and if it is over the cap, delete the
    oldest-mtime files first until it isn't. Run on every write rather than on a timer -- a tile
    cache write is already an outbound HTTP round trip, so one directory walk on top of it is
    noise, and this never needs a background task or its own lifecycle."""
    cap = (TILE_CACHE_MB if cap_mb is None else cap_mb) * 1024 * 1024
    entries = []
    total = 0
    for root, _dirs, files in os.walk(TILE_CACHE_DIR):
        for name in files:
            if name.endswith(".tmp"):
                continue
            p = os.path.join(root, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, p))
            total += st.st_size
    if total <= cap:
        return
    for _mtime, size, p in sorted(entries):
        if total <= cap:
            break
        try:
            os.remove(p)
            total -= size
        except OSError:
            pass


def _tile_cache_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o664)
    except OSError:
        pass
    _tile_cache_evict()


def _tile_http_get(url: str) -> bytes:
    """The one place a tile route reaches an external host. Broken out so tests can monkeypatch it
    and never touch the network -- api.cesium.com/opentopodata.org style hosts are not guaranteed
    reachable in any test sandbox, and that posture applies here too."""
    resp = httpx.get(url, timeout=8.0, headers={"User-Agent": "finsonly-racing-tile-proxy/1"})
    resp.raise_for_status()
    return resp.content


def _tiles_or_404() -> None:
    if not RACE_TILE_PROXY:
        raise HTTPException(404, "tile proxy disabled")


@app.get("/tiles/terrain/{z}/{x}/{y}.png")
def tile_terrain(z: int, x: int, y: int, request: Request):
    """AWS Terrarium PNG, proxied and disk-cached. Same URL config.js used to hit directly."""
    _tiles_or_404()
    _tile_rate_limit(client_ip(request), time.time())
    if not _valid_tile_coords(z, x, y, TERRAIN_MAX_ZOOM):
        raise HTTPException(400, "tile coordinates out of range")
    path = _tile_cache_path("terrain", z, x, y, "png")
    data = _tile_cache_read(path)
    if data is None:
        try:
            data = _tile_http_get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png")
        except httpx.HTTPError:
            raise HTTPException(502, "upstream terrain tile fetch failed")
        _tile_cache_write(path, data)
    return Response(content=data, media_type="image/png",
                    headers={"Cache-Control": f"public, max-age={TILE_CACHE_MAX_AGE_S}, immutable"})


@app.get("/tiles/imagery/{z}/{y}/{x}")
def tile_imagery(z: int, y: int, x: int, request: Request):
    """World imagery, proxied and disk-cached. Esri World_Imagery by default; RACE_IMAGERY=eox
    switches every request here to EOX Sentinel-2 cloudless instead (a server-side, whole-fleet
    switch -- the client no longer probes multiple hosts itself, see config.js)."""
    _tiles_or_404()
    _tile_rate_limit(client_ip(request), time.time())
    source = IMAGERY_SOURCES.get(RACE_IMAGERY, IMAGERY_SOURCES["esri"])
    if not _valid_tile_coords(z, x, y, source["max_zoom"]):
        raise HTTPException(400, "tile coordinates out of range")
    path = _tile_cache_path(f"imagery-{RACE_IMAGERY}", z, y, x, source["ext"])
    data = _tile_cache_read(path)
    if data is None:
        try:
            data = _tile_http_get(source["url"].format(z=z, y=y, x=x))
        except httpx.HTTPError:
            raise HTTPException(502, "upstream imagery tile fetch failed")
        _tile_cache_write(path, data)
    media = "image/jpeg" if source["ext"] == "jpg" else "image/png"
    return Response(content=data, media_type=media,
                    headers={"Cache-Control": f"public, max-age={TILE_CACHE_MAX_AGE_S}, immutable"})


@app.get("/tiles/labels/{z}/{y}/{x}")
def tile_labels(z: int, y: int, x: int, request: Request):
    """Esri place names/borders, proxied and disk-cached -- the same host as the Esri imagery
    source, so this adds no new upstream host, only a new local route."""
    _tiles_or_404()
    _tile_rate_limit(client_ip(request), time.time())
    if not _valid_tile_coords(z, x, y, LABELS_MAX_ZOOM):
        raise HTTPException(400, "tile coordinates out of range")
    path = _tile_cache_path("labels", z, y, x, "png")
    data = _tile_cache_read(path)
    if data is None:
        try:
            data = _tile_http_get(LABELS_URL.format(z=z, y=y, x=x))
        except httpx.HTTPError:
            raise HTTPException(502, "upstream labels tile fetch failed")
        _tile_cache_write(path, data)
    return Response(content=data, media_type="image/png",
                    headers={"Cache-Control": f"public, max-age={TILE_CACHE_MAX_AGE_S}, immutable"})


@app.get("/tiles/attribution")
def tile_attribution():
    """Whatever credit strings the currently active sources need -- so swapping RACE_IMAGERY, or
    swapping a URL, can never silently drop a required attribution."""
    _tiles_or_404()
    source = IMAGERY_SOURCES.get(RACE_IMAGERY, IMAGERY_SOURCES["esri"])
    return {"terrain": TERRAIN_CREDIT, "imagery": source["credit"], "labels": LABELS_CREDIT,
            "imagery_source": RACE_IMAGERY}


# ===================================================================================
# Dynamic OG images (0.7-1.0 series). One PNG per (kind, id), 1200x630, cached on disk next to
# the tile cache (its own subdirectory, same eviction machinery would apply if this ever grew
# large enough to need it -- in practice a handful of KB per record/course/pilot/replay, nowhere
# near TILE_CACHE_MB, so there is no eviction here, only a content-hash cache key that naturally
# invalidates when the underlying data changes).
# ===================================================================================

OG_CACHE_DIR = os.path.normpath(os.path.join(TILE_CACHE_DIR, "..", "og"))
OG_W, OG_H = 1200, 630
OG_BG_TOP = (44, 26, 61)          # PLUM, matching site.css/globe.js's scene background
OG_BG_BOTTOM = (255, 138, 61)     # a sunset orange
OG_LINE = (255, 210, 61)          # GHOST_COLORS[0] from config.js
OG_TEXT = (255, 244, 234)


def _og_gradient() -> "Image.Image":
    img = Image.new("RGB", (OG_W, OG_H))
    px = img.load()
    for yy in range(OG_H):
        t = yy / (OG_H - 1)
        row = tuple(int(a + (b - a) * t) for a, b in zip(OG_BG_TOP, OG_BG_BOTTOM))
        for xx in range(OG_W):
            px[xx, yy] = row
    return img


def _og_route_points(gates: list[dict]) -> list[tuple[float, float]]:
    """Course gates -> image-space points, equirectangular-fit to the course's own bbox. Not
    geodetically precise (no cos(lat) correction) -- this is a social-preview thumbnail, not a
    nav chart, and the task spec calls that out as an acceptable simplification."""
    if not gates:
        return []
    lats = [g["lat"] for g in gates]
    lons = [g["lon"] for g in gates]
    lat_lo, lat_hi = min(lats), max(lats)
    lon_lo, lon_hi = min(lons), max(lons)
    pad = 120
    w, h = OG_W - 2 * pad, OG_H - 2 * pad - 80   # leave room for the text band at the bottom
    lat_span = (lat_hi - lat_lo) or 1e-6
    lon_span = (lon_hi - lon_lo) or 1e-6
    pts = []
    for g in gates:
        fx = (g["lon"] - lon_lo) / lon_span
        fy = 1.0 - (g["lat"] - lat_lo) / lat_span   # north is up
        pts.append((pad + fx * w, pad + fy * h))
    return pts


def _og_key(kind: str, ident: str, extra: str = "") -> str:
    return hashlib.sha256(f"{kind}:{ident}:{extra}".encode("utf-8")).hexdigest()[:16]


def render_og_image(kind: str, title: str, subtitle: str, gates: list[dict]) -> bytes:
    """Pure-ish (Pillow is the only side effect, and it is in-memory): the actual drawing, broken
    out from the route so tests can call it directly without a real id existing in the database."""
    img = _og_gradient()
    draw = ImageDraw.Draw(img)
    pts = _og_route_points(gates)
    if len(pts) >= 2:
        draw.line(pts, fill=OG_LINE, width=6, joint="curve")
        for p in (pts[0], pts[-1]):
            draw.ellipse([p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8], fill=OG_LINE)
    draw.rectangle([0, OG_H - 150, OG_W, OG_H], fill=(0, 0, 0))
    draw.text((60, OG_H - 130), title[:80], fill=OG_TEXT)
    draw.text((60, OG_H - 90), subtitle[:100], fill=OG_LINE)
    draw.text((60, OG_H - 50), "FINSONLY Racing", fill=OG_TEXT)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _og_source(conn: sqlite3.Connection, kind: str, ident: str):
    """(title, subtitle, gates, cache_extra) for one og image id, or None if it doesn't exist.
    cache_extra folds in whatever makes the image stale (a new record time, a new best) so the
    disk cache key changes exactly when the picture should."""
    by_id = {c["course_id"]: c for c in COURSES}
    by_hash = {c["course_hash"]: c for c in COURSES}
    if kind == "course":
        c = by_id.get(ident)
        if c is None:
            return None
        return (c["course_name"], f"{c['length_km']} km · {c['gates']} gates", c["gate_coords"], "")
    if kind == "record":
        c = by_hash.get(ident)
        row = conn.execute(
            "SELECT callsign, MIN(time_ms) AS time_ms FROM runs WHERE course_hash = ? GROUP BY callsign"
            " ORDER BY time_ms LIMIT 1", (ident,)).fetchone()
        if c is None or row is None:
            return None
        return (c["course_name"], f"Record: {row['callsign']} · {row['time_ms'] / 1000:.3f}s",
                c["gate_coords"], f"{row['callsign']}:{row['time_ms']}")
    if kind == "pilot":
        pilot = _resolve_pilot_ident(conn, ident)
        if pilot is None:
            return None
        wins = conn.execute(
            "SELECT COUNT(*) FROM race_results WHERE pilot_id = ? AND pos = 1 AND status = 'finished'",
            (pilot["pilot_id"],)).fetchone()[0]
        return (pilot["callsign"], f"{wins} race win{'s' if wins != 1 else ''}", [],
                f"{pilot['last_seen']}")
    if kind == "replay":
        try:
            race_id = int(ident)
        except ValueError:
            return None
        race = conn.execute("SELECT course_hash, course_name FROM races WHERE id = ?",
                            (race_id,)).fetchone()
        if race is None:
            return None
        winner = conn.execute(
            """SELECT callsign, go_time_ms FROM race_results
               WHERE race_id = ? AND status = 'finished' ORDER BY pos LIMIT 1""", (race_id,)).fetchone()
        c = by_hash.get(race["course_hash"])
        subtitle = f"Winner: {winner['callsign']}" if winner else "Replay"
        return (race["course_name"], subtitle, c["gate_coords"] if c else [], "")
    return None


@app.get("/og/{kind}/{ident}.png")
def og_image(kind: Literal["record", "course", "pilot", "replay"], ident: str):
    """A 1200x630 social-preview PNG for a course, record, pilot or replay. Cached on disk keyed by
    a hash of the inputs, so the same id/underlying-data combination is never re-rendered; a new
    record or a new callsign naturally gets a new key. Unknown id -> 404 (documented choice: a
    placeholder image would make a broken share link look intentional)."""
    with connect() as conn:
        src = _og_source(conn, kind, ident)
    if src is None:
        raise HTTPException(404, "No such id for an OG image.")
    title, subtitle, gates, extra = src
    key = _og_key(kind, ident, extra)
    path = os.path.join(OG_CACHE_DIR, kind, f"{key}.png")
    data = _tile_cache_read(path)
    if data is None:
        data = render_og_image(kind, title, subtitle, gates)
        _tile_cache_write(path, data)
    return Response(content=data, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


def _share_target(kind: str, ident: str) -> str:
    """The SPA's own hash route to land on after the unfurl -- race/server/static/js/app.js routes
    entirely by `location.hash` (course pages are `#/course/<id>`), and the server never sees a
    hash fragment, so this redirect page is the only way a shared link can carry both a real
    server-rendered <meta> tag AND land the browser in the right place. `pilot`/`record`/`replay`
    have no SPA view yet (only home/courses/course/notfound exist under static/js/views/ today) --
    this falls back to the course page for `record` (same course, most useful landing spot) and to
    home for `pilot`/`replay`, which is the plainly-documented gap; see the report."""
    if kind == "course":
        return f"/#/course/{ident}"
    if kind == "record":
        return f"/#/course/{ident}"
    return "/#/"


@app.get("/share/{kind}/{ident}", response_class=HTMLResponse)
def share_page(kind: Literal["record", "course", "pilot", "replay"], ident: str):
    """The smallest server-side hook that can inject a per-page <meta> tag before an unfurl bot
    ever runs JS: a small HTML shell (not the SPA itself) carrying the right og:image/twitter:image
    and og:title, that immediately sends a human on to the real SPA route. Slack/Teams/Discord
    read the <meta> tags from this response directly; a person clicking the link is redirected in
    well under a second (meta refresh, no JS required, with a visible fallback link)."""
    with connect() as conn:
        src = _og_source(conn, kind, ident)
    raw_title = f"{src[0]} — FINSONLY Racing" if src else "FINSONLY Racing"
    raw_desc = src[1] if src else "Checkpoint racing for GeoFS."
    img = f"/og/{kind}/{ident}.png" if src else "/img/og.png"
    target = _share_target(kind, ident)
    # Course names, callsigns and record margins are all client-supplied strings that end up here
    # (same posture as the static site's own "textContent only" rule) -- escape everything before
    # it goes into HTML, since this route (unlike the SPA) renders on the server.
    title, desc = html.escape(raw_title), html.escape(raw_desc)
    img_esc, target_esc = html.escape(img), html.escape(target)
    page = f"""<!doctype html><html><head><meta charset="utf-8">
<title>{title}</title>
<meta http-equiv="refresh" content="0; url={target_esc}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{img_esc}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{img_esc}">
</head><body>Redirecting to <a href="{target_esc}">{title}</a>&hellip;</body></html>"""
    return HTMLResponse(content=page, status_code=200 if src else 404)


# ===================================================================================
# The public site: race/server/static/{index.html,site.css,site.js}, served as plain static files
# (StaticFiles(html=True) answers "/" with index.html). It fetches the JSON endpoints above from
# the same origin and builds the DOM with textContent only -- callsigns and course names are
# client-supplied, and putting one through innerHTML would be an XSS hole in a page that has no
# login to lose but is still somebody's browser. Google Fonts is the one deliberate exception to
# "same origin only", allowed explicitly below; everything else is 'none'.
#
# This mount MUST stay the last route added: Starlette matches routes in registration order, and a
# Mount at "/" is a catch-all that would otherwise swallow every path (including "/health",
# "/courses", ...) declared after it.
# ===================================================================================
_STATIC_CSP = ("default-src 'none'; script-src 'self'; "
              "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
              "img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; "
              "frame-ancestors 'none'")


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path in ("/", "/index.html"):
        response.headers["Content-Security-Policy"] = _STATIC_CSP
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
