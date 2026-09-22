"""FINSONLY Racing leaderboard — FastAPI + SQLite.

No accounts: the client is public JS, so any shared secret would be public too.
Protection is plausibility checks, per-IP rate limiting, and Caddy's geoblock/CrowdSec.
"""
import asyncio
import datetime as _dt
import hashlib
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
from typing import Annotated, Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, ValidationError, model_validator

DB_PATH = os.environ.get("RACE_DB", "/data/race.db")
ORIGINS = [o.strip() for o in os.environ.get(
    "RACE_ORIGINS", "https://www.geo-fs.com,https://geo-fs.com").split(",") if o.strip()]
MAX_SPEED_MS = float(os.environ.get("RACE_MAX_SPEED_MS", "700"))
MIN_INTERVAL_S = float(os.environ.get("RACE_MIN_INTERVAL_S", "5"))

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
        if not key or key in seen:
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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        # SCHEMA creates what is missing; migrate() alters what already exists. Both run on every
        # start and both are no-ops the second time — see migrate()'s docstring.
        migrate(conn)
    yield


app = FastAPI(title="FINSONLY Racing", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS,
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
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
    return {"ok": True}


@app.post("/runs")
def post_run(run: RunIn, request: Request):
    ip = client_ip(request)
    now = time.time()
    with _lock:
        if now - _last_post.get(ip, 0) < MIN_INTERVAL_S:
            raise HTTPException(429, "Too many submissions; wait a few seconds.")
        _last_post[ip] = now
        if len(_last_post) > 5000:
            _last_post.clear()
    trace_saved, trace_reason = False, None
    with connect() as conn:
        prev_best = conn.execute(
            "SELECT MIN(time_ms) FROM runs WHERE course_hash = ? AND callsign = ?",
            (run.course_hash, run.callsign)).fetchone()[0]
        cur = conn.execute(
            """INSERT INTO runs (course_id, course_hash, course_name, callsign, aircraft_id, model,
               time_ms, splits, gates, length_m, client_version, ip, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (run.course_id, run.course_hash, run.course_name, run.callsign, run.aircraft_id, run.model,
             run.time_ms, json.dumps(run.splits), run.gates, run.length_m, run.client_version, ip, int(now)))
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
                """SELECT callsign, time_ms, model, trace_blob, created_at FROM traces
                   WHERE course_hash = ? AND callsign = ?""", (course_hash, callsign.strip())).fetchone()
        else:
            row = conn.execute(
                """SELECT callsign, time_ms, model, trace_blob, created_at FROM traces
                   WHERE course_hash = ? ORDER BY time_ms, created_at LIMIT 1""", (course_hash,)).fetchone()
    if row is None:
        raise HTTPException(404, "No ghost recorded for that course yet.")
    return {"course_hash": course_hash, "callsign": row["callsign"], "time_ms": row["time_ms"],
            "model": row["model"], "created_at": row["created_at"], "trace": json.loads(row["trace_blob"])}


@app.get("/ghosts")
def ghosts_list(course_hash: str = Query(pattern=r"^[0-9a-f]{8}$")):
    """Every ghost recorded on a course, fastest first — the picker behind "race a friend's ghost"
    (0.12.0). Reuses the same `traces` table /ghost already reads; this is just the index over it,
    not a new kind of row. `is_course_record` marks the fastest entry, same definition /ghost uses
    for "course record holder": the fastest pilot who actually has a trace, not the fastest time on
    the board.
    """
    with connect() as conn:
        rows = conn.execute(
            """SELECT callsign, time_ms, model, created_at FROM traces
               WHERE course_hash = ? ORDER BY time_ms, created_at""", (course_hash,)).fetchall()
    return [{"callsign": r["callsign"], "time_ms": r["time_ms"], "model": r["model"],
              "recorded_at": r["created_at"], "is_course_record": i == 0} for i, r in enumerate(rows)]


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
    """Courses that have at least one time, newest activity first."""
    with connect() as conn:
        rows = conn.execute(
            """SELECT course_hash, course_id, course_name, COUNT(DISTINCT callsign) AS racers,
                      MIN(time_ms) AS record_ms, MAX(created_at) AS last_run
               FROM runs GROUP BY course_hash ORDER BY last_run DESC LIMIT 100""").fetchall()
        return [dict(r) for r in rows]


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
PROTO = 5                       # the integer `joined` advertises; clients gate features on it
LOBBY_PROTO = 2                 # the proto the lobby (above) arrived in — kept for documentation
ITEMS_PROTO = 3                 # …and the one the items layer below needs
RESULTS_PROTO = 4               # …and results + cups (the "results" section further down)
HUB_PROTO = 5                   # …and the hub, identity, chat, spectating and the course vote
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


class RulesMsg(BaseModel):
    type: Literal["rules"]
    powerups: bool
    teleport: bool


class StartMsg(BaseModel):
    type: Literal["start"]
    lead_s: int = Field(ge=MIN_LEAD_S, le=MAX_LEAD_S)
    force: bool = False


class AbortMsg(BaseModel):
    type: Literal["abort"]


class ChatMsg(BaseModel):
    type: Literal["chat"]
    code: Literal[CHAT_CODES]  # type: ignore[valid-type]


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


_HUB_MSG_MODELS = {"hello": HubHelloMsg, "heartbeat": HeartbeatMsg, "where": WhereMsg,
                   "list": ListMsg}


_MSG_MODELS = {"join": JoinMsg, "pos": PosMsg, "box": BoxMsg, "fire": FireMsg,
               "ping": PingMsg, "hello": HelloMsg, "ready": ReadyMsg, "course": CourseMsg,
               "rules": RulesMsg, "start": StartMsg, "abort": AbortMsg, "chat": ChatMsg,
               "back_to_lobby": BackToLobbyMsg, "fx": FxMsg, "tripped": TrippedMsg,
               "finish": FinishMsg, "dnf": DnfMsg, "cup": CupMsg, "rematch": RematchMsg}


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
                 "worst_rank", "seq", "reported")

    def __init__(self, callsign: str, model: str = ""):
        self.callsign = callsign
        self.model = model
        self.status: Optional[str] = None      # None while racing, then 'finished' | 'dnf'
        self.go_time_ms: Optional[int] = None
        self.gate = 0                          # last gate this racer reported; a DNF is "at" this
        self.elapsed_ms = 0
        self.jump_start = False
        self.best_sector_ms: Optional[int] = None
        self.items_used: dict[str, int] = {}
        self.hits_taken = 0
        self.hits_blocked = 0
        self.hits_landed = 0                   # this racer's offensive items that actually landed
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


def cup_standings(points: dict) -> list[dict]:
    """Pure: {callsign: points} -> standings, most points first, alphabetical on a tie so the
    order is stable from one frame to the next."""
    return [{"callsign": cs, "points": pts}
            for cs, pts in sorted(points.items(), key=lambda kv: (-kv[1], kv[0]))]


_persist_tasks: set = set()   # strong refs: a fire-and-forget task nobody holds can be collected mid-write


def persist_race(room: str, course: dict, started_at: int, rows: list[dict],
                 cup: Optional[dict]) -> dict:
    """Write one finished race — and its cup, if any — to SQLite, in one transaction. Synchronous:
    the caller runs it in a worker thread so the event loop never waits on the disk. Nothing else
    in the relay touches the database.

    `cup` is None for a one-off, else {id, name, race_count, race_no}. A cup gets its row here, on
    the first race that finishes (`id` None until then), and is closed the moment its last race
    does. Any OTHER still-open cup for the same room is closed too: a host who started a new cup
    without finishing the old one abandoned it, and an abandoned cup must not sit in the open list
    forever.
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
                          "worst_rank": r["worst_rank"], "final_rank": r["pos"],
                          "best_sector_ms": r["best_sector_ms"], "jump_start": r["jump_start"],
                          "gate": r["gate"]}, separators=(",", ":")))
             for r in rows])
    return {"race_id": race_id, "cup_id": cup_id}


class Player:
    __slots__ = ("ws", "callsign", "gate", "elapsed_ms", "lat", "lon", "alt", "carrying",
                 "ready", "model", "role", "shield_until", "last_fx_ms", "proto3")

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
        self.phase = "lobby"              # lobby | countdown | racing | results
        self.course: Optional[dict] = None
        self.rules = {"powerups": True, "teleport": True}
        self.race_id = 0
        self.start_task: Optional[asyncio.Task] = None
        # ---- results and cups (proto 4). In-memory like the rest of the room; the finished race
        # (and its cup) is written to SQLite once, by persist_race(), and read back only by REST.
        self.race: Optional[RaceRecord] = None   # the race in flight, or the one whose results are up
        self.last_results: Optional[dict] = None  # the `results` frame, replayed to a joiner
        # None = every race is a one-off. Else {id, name, race_count, race_no, points}; `id` stays
        # None until the first race of the cup has been written.
        self.cup: Optional[dict] = None
        self.persist_lock = asyncio.Lock()       # one race's write at a time, so a cup id exists for the next

    def ranking(self) -> list[str]:
        """Leader first: most gates passed, then whoever reached their current gate sooner."""
        return [cs for cs, _ in sorted(self.players.items(), key=lambda kv: (-kv[1].gate, kv[1].elapsed_ms))]

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
    for cs in order:
        player = room.players.get(cs)
        if player:
            await _safe_send(player.ws, frame)


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
        try:
            saved = await asyncio.to_thread(persist_race, room_name, rec.course, rec.started_at, rows, cup_arg)
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
                player = Player(websocket, msg.callsign)
                # Joining anything but an open lobby means the race is already under way: you
                # watch this one. back_to_lobby puts everyone back to 'racer'.
                if r.phase != "lobby":
                    player.role = "spectator"
                r.players[msg.callsign] = player
                if r.host is None:
                    r.host = msg.callsign
                await _safe_send(websocket, {"type": "joined", "room": room,
                                             "proto": PROTO, "server_ms": server_ms()})
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
                # Somebody arriving while the results are up (or reconnecting to them) sees them.
                if r.phase == "results" and r.last_results is not None:
                    await _safe_send(websocket, r.last_results)
                await _broadcast_lobby(r)
                continue

            if player is None:
                await _safe_send(websocket, {"type": "error", "detail": "join first"})
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
                await _broadcast_lobby(r)
            elif isinstance(msg, ChatMsg):
                await _broadcast(r, {"type": "chat", "callsign": player.callsign, "code": msg.code})
            elif isinstance(msg, CourseMsg):
                # Everyone re-confirms after a course or rules change: what you said yes to is
                # gone, and the client has to load the new course before it can honestly be ready.
                r.course = {"course_id": msg.course_id, "course_hash": msg.course_hash,
                            "name": msg.name, "start_type": msg.start_type}
                r.clear_ready()
                await _broadcast_lobby(r)
            elif isinstance(msg, RulesMsg):
                r.rules = {"powerups": msg.powerups, "teleport": msg.teleport}
                r.clear_ready()
                await _broadcast_lobby(r)
            elif isinstance(msg, StartMsg):
                if r.course is None:
                    await _safe_send(websocket, {"type": "error", "detail": "no course set"})
                    continue
                if not msg.force and not all(p.ready for p in r.players.values()):
                    await _safe_send(websocket, {"type": "error", "detail": "not everyone is ready"})
                    continue
                r.cancel_countdown()
                r.discard_race()       # a start over a race in flight, or over its results, replaces it
                r.phase = "countdown"
                r.race_id += 1
                for p in r.players.values():
                    p.role = "racer" if p.ready else "spectator"
                racers = [cs for cs, p in r.players.items() if p.role == "racer"]
                start_at = server_ms() + msg.lead_s * 1000
                # A start with nobody racing has nothing to score, so there is no record to end it
                # (it stays 'racing' until the host goes back to the lobby, exactly as before).
                if racers:
                    r.race = RaceRecord(r.race_id, r.course, start_at, [r.players[cs] for cs in racers])
                await _broadcast(r, {"type": "start", "race_id": r.race_id,
                                     "start_at_server_ms": start_at, "racers": racers})
                await _broadcast_lobby(r)
                r.start_task = asyncio.create_task(_run_countdown(r, r.race_id, msg.lead_s))
            elif isinstance(msg, AbortMsg):
                if r.phase != "countdown":
                    await _safe_send(websocket, {"type": "error", "detail": "nothing to abort"})
                    continue
                r.cancel_countdown()
                r.discard_race()
                r.phase = "lobby"
                for p in r.players.values():
                    p.role = "racer"       # ready flags survive an abort: nobody un-said yes
                await _broadcast(r, {"type": "abort"})
                await _broadcast_lobby(r)
            elif isinstance(msg, BackToLobbyMsg):
                r.cancel_countdown()
                r.discard_race()           # a race sent home early is not scored
                r.phase = "lobby"
                r.clear_ready()
                for p in r.players.values():
                    p.role = "racer"
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
                    p.role = "racer"
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
        if player is not None:
            r.players.pop(player.callsign, None)
            # Host migration: the longest-connected remaining player, which is the first key of
            # an insertion-ordered dict. A room with a host nobody can reach is a dead lobby.
            if r.host == player.callsign:
                r.host = next(iter(r.players), None)
        if not r.players:
            r.cancel_countdown()
            r.cancel_tasks()
            r.discard_race()
            rooms.pop(room, None)
        elif player is not None:
            # A racer who drops is out (DNF at their last gate) — which can be what ends the race.
            await _note_disconnect(r, player.callsign)
            await _broadcast_lobby(r)


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


def registry_rows(now: float) -> list[dict]:
    """The `rooms` payload. Empty until the room registry lands in the next commit — the frame
    ships now so its shape is fixed and a client can bind to it without a second protocol bump."""
    return []


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


def _claim_in_thread(token: Optional[str], callsign: str):
    """The identity step, off the event loop — it is the only disk access the hub does per pilot.
    Returns plain dicts so nothing holding a sqlite3 connection escapes the worker thread."""
    with connect() as conn:
        row, new_token, err = claim_callsign(conn, token, callsign)
        return (dict(row) if row is not None else None), new_token, err


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


# One static page: inline CSS and script, no framework, no external request of any kind — not a
# font, not an image, not a CDN — so it works from a locked-down machine and leaks nothing. It
# fetches the JSON endpoints above from the same origin and builds the DOM with textContent only:
# callsigns and course names are client-supplied, and putting one through innerHTML would be an XSS
# hole in a page that has no login to lose but is still somebody's browser. The response header
# repeats that as a policy (default-src 'none', connect-src 'self').
INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FINSONLY Racing</title>
<style>
:root{--plum:#1d1029;--plum2:#2c1a3d;--sun:#ff8a3d;--pink:#ff3d8b;--cream:#fff4ea;--dim:#b9a6c8;--slow:#ff6b6b}
*{box-sizing:border-box}
html{background:var(--plum)}
body{margin:0;color:var(--cream);font:15px/1.5 "Trebuchet MS","Segoe UI",system-ui,sans-serif;
  background:radial-gradient(1100px 460px at 50% -8%,rgba(255,61,139,.2),transparent),var(--plum)}
header,main,footer{max-width:960px;margin:0 auto;padding:0 16px}
header{padding-top:28px}
h1{margin:0;font-size:32px;line-height:1.15;background:linear-gradient(90deg,var(--sun),var(--pink));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin:2px 0 0;color:var(--dim)}
h2{margin:30px 0 10px;font-size:14px;letter-spacing:.09em;text-transform:uppercase;color:var(--sun)}
h3{margin:0;font-size:16px}
.card{background:rgba(44,26,61,.85);border:1px solid rgba(255,138,61,.28);border-radius:14px;
  padding:12px 14px;box-shadow:0 10px 30px rgba(10,0,20,.35);overflow-x:auto}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(290px,1fr))}
.head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-bottom:6px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:normal;font-size:12px;color:var(--dim);padding:2px 10px 6px 0}
td{padding:4px 10px 4px 0;border-top:1px solid rgba(255,255,255,.08);vertical-align:baseline}
th.n,td.n{text-align:right;padding-right:0}
.dim{color:var(--dim)}
.err{color:var(--slow)}
.badge{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:bold;
  color:#240a1f;background:linear-gradient(90deg,var(--sun),var(--pink))}
.empty{color:var(--dim);padding:4px 0}
footer{padding-top:22px;padding-bottom:30px;color:var(--dim);font-size:12px}
</style>
</head>
<body>
<header>
<h1>FINSONLY Racing</h1>
<p class="sub">Course records, recent lobby races and the cups still being flown.</p>
</header>
<main>
<h2>Course records</h2>
<div class="card" id="records" aria-live="polite"><div class="empty">Loading…</div></div>
<h2>Recent races</h2>
<div class="grid" id="races" aria-live="polite"><div class="empty">Loading…</div></div>
<h2>Open cups</h2>
<div class="grid" id="cups" aria-live="polite"><div class="empty">Loading…</div></div>
</main>
<footer id="foot"></footer>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function fmt(ms) {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(3);
}
function ago(unix) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 129600) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
function getJSON(path) {
  return fetch(path, { headers: { Accept: "application/json" } }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}
function table(cols, rows) {
  const t = el("table"), head = el("tr");
  cols.forEach((c) => { const th = el("th", c.n ? "n" : "", c.h); th.scope = "col"; head.append(th); });
  t.append(head);
  rows.forEach((cells) => {
    const tr = el("tr");
    cells.forEach((v, i) => tr.append(el("td", cols[i].n ? "n" : "", v == null ? "—" : String(v))));
    t.append(tr);
  });
  return t;
}
function show(id, nodes, emptyText) {
  $(id).replaceChildren(...(nodes.length ? nodes : [el("div", "empty", emptyText)]));
}
function fail(id, e) { $(id).replaceChildren(el("div", "err", "Could not load this: " + e.message)); }

async function loadRecords() {
  const courses = (await getJSON("/courses")).slice(0, 12);
  const tops = await Promise.all(courses.map((c) =>
    getJSON("/leaderboard?course_hash=" + encodeURIComponent(c.course_hash) + "&limit=1").catch(() => [])));
  const rows = courses.map((c, i) => {
    const top = tops[i][0];
    return [c.course_name, fmt(c.record_ms), top ? top.callsign + (top.model ? " (" + top.model + ")" : "") : null, c.racers];
  });
  show("records", rows.length ? [table([{ h: "Course" }, { h: "Record", n: 1 }, { h: "Held by" }, { h: "Pilots", n: 1 }], rows)] : [],
    "No times posted yet.");
}
async function loadRaces() {
  const races = await getJSON("/races/recent?limit=8");
  show("races", races.map((r) => {
    const card = el("div", "card"), head = el("div", "head");
    head.append(el("h3", "", r.course_name));
    if (r.cup_name) head.append(el("span", "badge", r.cup_name));
    head.append(el("span", "dim", ago(r.started_at)));
    card.append(head, table([{ h: "#", n: 1 }, { h: "Pilot" }, { h: "Time", n: 1 }, { h: "Pts", n: 1 }],
      r.results.slice(0, 8).map((x) => [x.pos, x.callsign, x.status === "finished" ? fmt(x.go_time_ms) : "DNF", x.points])));
    return card;
  }), "No lobby races finished yet.");
}
async function loadCups() {
  const cups = await getJSON("/cups?open=1&limit=6");
  show("cups", cups.map((c) => {
    const card = el("div", "card"), head = el("div", "head");
    head.append(el("h3", "", c.name), el("span", "dim", "race " + Math.min(c.races_run + 1, c.race_count) + " of " + c.race_count));
    card.append(head, c.standings.length
      ? table([{ h: "Pilot" }, { h: "Pts", n: 1 }, { h: "Wins", n: 1 }], c.standings.slice(0, 8).map((s) => [s.callsign, s.points, s.wins]))
      : el("div", "empty", "No race finished yet."));
    return card;
  }), "No cup is running.");
}
async function refresh() {
  await Promise.all([loadRecords().catch((e) => fail("records", e)), loadRaces().catch((e) => fail("races", e)),
    loadCups().catch((e) => fail("cups", e))]);
  $("foot").textContent = "Updated " + new Date().toLocaleTimeString() + ". Refreshes every 30 seconds.";
}
refresh();
setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
</script>
</body>
</html>
"""

INDEX_HEADERS = {
    "Content-Security-Policy": ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                                "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
}


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def index_page():
    return HTMLResponse(INDEX_HTML, headers=INDEX_HEADERS)
