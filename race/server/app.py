"""FINSONLY Racing leaderboard — FastAPI + SQLite.

No accounts: the client is public JS, so any shared secret would be public too.
Protection is plausibility checks, per-IP rate limiting, and Caddy's geoblock/CrowdSec.
"""
import asyncio
import json
import math
import os
import random
import re
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
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
"""

_lock = threading.Lock()
_last_post: dict[str, float] = {}


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


@asynccontextmanager
async def lifespan(_app: FastAPI):
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
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
# Shield is honored by the VICTIM'S OWN CLIENT on receiving a "hit", not enforced here. The
# relay has no reason to track a purely self-only defensive timer just to gate a message it
# would send to that same client anyway — the client already knows its own shield state.
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
PROTO = 3                       # the integer `joined` advertises; clients gate features on it
LOBBY_PROTO = 2                 # the proto the lobby (above) arrived in — kept for documentation
ITEMS_PROTO = 3                 # …and the one the items layer below needs
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


_MSG_MODELS = {"join": JoinMsg, "pos": PosMsg, "box": BoxMsg, "fire": FireMsg,
               "ping": PingMsg, "hello": HelloMsg, "ready": ReadyMsg, "course": CourseMsg,
               "rules": RulesMsg, "start": StartMsg, "abort": AbortMsg, "chat": ChatMsg,
               "back_to_lobby": BackToLobbyMsg, "fx": FxMsg, "tripped": TrippedMsg}


def parse_message(raw: dict):
    """Pure: dict -> validated message model, or raises ValueError/ValidationError. No sockets."""
    if not isinstance(raw, dict):
        raise ValueError("message must be a JSON object")
    model = _MSG_MODELS.get(raw.get("type"))
    if not model:
        raise ValueError(f"unknown message type: {raw.get('type')!r}")
    return model(**raw)


def server_ms() -> int:
    """The one clock every lobby countdown is measured against. Clients never compare their own
    wall clocks to each other — they measure an offset to this via ping/pong (race.js's
    clockOffset()) and convert start_at_server_ms into their local frame."""
    return int(time.time() * 1000)


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
    def __init__(self):
        self.players: dict[str, Player] = {}
        self.banana: Optional[dict] = None  # legacy single banana; proto 3 uses `bananas` below
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

    def ranking(self) -> list[str]:
        """Leader first: most gates passed, then whoever reached their current gate sooner."""
        return [cs for cs, _ in sorted(self.players.items(), key=lambda kv: (-kv[1].gate, kv[1].elapsed_ms))]

    def lobby_frame(self) -> dict:
        return {"type": "lobby", "phase": self.phase, "host": self.host, "course": self.course,
                "rules": dict(self.rules), "race_id": self.race_id,
                "players": [{"callsign": p.callsign, "model": p.model, "ready": p.ready, "role": p.role}
                            for p in self.players.values()]}

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
    if not room.bananas:
        room.banana = None
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
    room.banana = {"lat": lat, "lon": lon, "from": shooter.callsign}  # legacy single-banana view
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
        await _clear_banana(room, banana, victim.callsign, "blocked")
        return
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


@app.websocket("/ws/race/{room}")
async def ws_race(websocket: WebSocket, room: str):
    if not ROOM_PATTERN.match(room):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    r = rooms.setdefault(room, Room())
    player: Optional[Player] = None
    msg_times: list[float] = []
    violations = 0
    try:
        while True:
            raw_text = await websocket.receive_text()

            if len(raw_text.encode("utf-8")) > MAX_WS_MSG_BYTES:
                await websocket.close(code=1009)
                return

            now = time.monotonic()
            msg_times = [t for t in msg_times if now - t < 1.0]
            msg_times.append(now)
            if len(msg_times) > WS_RATE_LIMIT_PER_S:
                violations += 1
                if violations > WS_MAX_VIOLATIONS:
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
                await _broadcast_lobby(r)
                continue

            if player is None:
                await _safe_send(websocket, {"type": "error", "detail": "join first"})
                continue

            # ---- lobby frames (proto 2). Host-only ones are refused for everyone else rather
            # than silently ignored, so a client whose host migrated away finds out.
            if isinstance(msg, (CourseMsg, RulesMsg, StartMsg, AbortMsg, BackToLobbyMsg)):
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
                r.phase = "countdown"
                r.race_id += 1
                for p in r.players.values():
                    p.role = "racer" if p.ready else "spectator"
                racers = [cs for cs, p in r.players.items() if p.role == "racer"]
                start_at = server_ms() + msg.lead_s * 1000
                await _broadcast(r, {"type": "start", "race_id": r.race_id,
                                     "start_at_server_ms": start_at, "racers": racers})
                await _broadcast_lobby(r)
                r.start_task = asyncio.create_task(_run_countdown(r, r.race_id, msg.lead_s))
            elif isinstance(msg, AbortMsg):
                if r.phase != "countdown":
                    await _safe_send(websocket, {"type": "error", "detail": "nothing to abort"})
                    continue
                r.cancel_countdown()
                r.phase = "lobby"
                for p in r.players.values():
                    p.role = "racer"       # ready flags survive an abort: nobody un-said yes
                await _broadcast(r, {"type": "abort"})
                await _broadcast_lobby(r)
            elif isinstance(msg, BackToLobbyMsg):
                r.cancel_countdown()
                r.phase = "lobby"
                r.clear_ready()
                for p in r.players.values():
                    p.role = "racer"
                await _broadcast_lobby(r)

            if isinstance(msg, PosMsg):
                player.gate, player.elapsed_ms, player.lat, player.lon = msg.gate, msg.elapsed_ms, msg.lat, msg.lon
                if msg.alt is not None:
                    player.alt = msg.alt
                    player.proto3 = True   # only a proto-3 client sends alt; see _check_banana
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
            rooms.pop(room, None)
        elif player is not None:
            await _broadcast_lobby(r)
