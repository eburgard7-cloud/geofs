"""FINSONLY Racing leaderboard — FastAPI + SQLite.

No accounts: the client is public JS, so any shared secret would be public too.
Protection is plausibility checks, per-IP rate limiting, and Caddy's geoblock/CrowdSec.
"""
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
    return [dict(r) for r in rows]


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
        best = min(run.time_ms, prev_best) if prev_best is not None else run.time_ms
        faster = conn.execute(
            """SELECT COUNT(*) FROM (SELECT MIN(time_ms) AS m FROM runs
               WHERE course_hash = ? GROUP BY callsign) WHERE m < ?""",
            (run.course_hash, best)).fetchone()[0]
    return {"id": cur.lastrowid, "rank": faster + 1, "personal_best": best,
            "improved": prev_best is None or run.time_ms < prev_best}


@app.get("/leaderboard")
def leaderboard(course_hash: str = Query(pattern=r"^[0-9a-f]{8}$"), limit: int = Query(10, ge=1, le=100)):
    with connect() as conn:
        return board_rows(conn, course_hash, limit)


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
ROOM_PATTERN = re.compile(r"^[a-z0-9-]{1,32}$")
MAX_WS_MSG_BYTES = 2048
WS_RATE_LIMIT_PER_S = int(os.environ.get("RACE_WS_RATE_PER_S", "20"))
WS_MAX_VIOLATIONS = 20          # repeated flooding beyond the rate limit closes the socket
BANANA_RADIUS_M = 75.0          # roughly one gate-radius; matches this project's casual precision

ITEMS = ["nothing", "banana", "goop", "boost", "missile"]

# Position-weighted catch-up table (README "Powerups" once written explains this to players).
# Anchors are hand-picked, each summing to 100; weights_for_rank() interpolates between them
# by normalized rank so there's no hard cliff between e.g. "midfield" and "last".
_LEADER = {"nothing": 45, "banana": 45, "goop": 8, "boost": 2, "missile": 0}
_MIDFIELD = {"nothing": 5, "banana": 20, "goop": 25, "boost": 35, "missile": 15}
_LAST = {"nothing": 0, "banana": 5, "goop": 10, "boost": 35, "missile": 50}


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


class BoxMsg(BaseModel):
    type: Literal["box"]


class FireMsg(BaseModel):
    type: Literal["fire"]
    item: Literal["banana", "goop", "missile"]  # offensive, box-only items — never "boost"/"nothing"


_MSG_MODELS = {"join": JoinMsg, "pos": PosMsg, "box": BoxMsg, "fire": FireMsg}


def parse_message(raw: dict):
    """Pure: dict -> validated message model, or raises ValueError/ValidationError. No sockets."""
    if not isinstance(raw, dict):
        raise ValueError("message must be a JSON object")
    model = _MSG_MODELS.get(raw.get("type"))
    if not model:
        raise ValueError(f"unknown message type: {raw.get('type')!r}")
    return model(**raw)


class Player:
    __slots__ = ("ws", "callsign", "gate", "elapsed_ms", "lat", "lon", "carrying")

    def __init__(self, ws: WebSocket, callsign: str):
        self.ws = ws
        self.callsign = callsign
        self.gate = 0
        self.elapsed_ms = 0
        self.lat: Optional[float] = None
        self.lon: Optional[float] = None
        self.carrying: Optional[str] = None  # the item most recently granted, awaiting a fire


class Room:
    def __init__(self):
        self.players: dict[str, Player] = {}
        self.banana: Optional[dict] = None  # {"lat", "lon", "from"} — dropped, awaiting a crossing

    def ranking(self) -> list[str]:
        """Leader first: most gates passed, then whoever reached their current gate sooner."""
        return [cs for cs, _ in sorted(self.players.items(), key=lambda kv: (-kv[1].gate, kv[1].elapsed_ms))]


rooms: dict[str, Room] = {}


async def _safe_send(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        return False


async def _broadcast_standings(room: Room):
    order = room.ranking()
    for cs in order:
        player = room.players.get(cs)
        if player:
            await _safe_send(player.ws, {"type": "standings", "order": order})


async def _check_banana(room: Room, player: Player):
    b = room.banana
    if not b or player.callsign == b["from"] or player.lat is None:
        return
    if _meters_between(player.lat, player.lon, b["lat"], b["lon"]) <= BANANA_RADIUS_M:
        room.banana = None
        await _safe_send(player.ws, {"type": "hit", "item": "banana", "from": b["from"]})


async def _resolve_fire(room: Room, shooter: Player, item: str):
    if item == "banana":
        if shooter.lat is not None and shooter.lon is not None:
            room.banana = {"lat": shooter.lat, "lon": shooter.lon, "from": shooter.callsign}
        return  # a banana with no known drop position is simply lost, never a crash
    # missile / goop: nearest player ahead by rank. Already in the lead -> nothing to hit.
    ranking = room.ranking()
    idx = ranking.index(shooter.callsign)
    if idx == 0:
        return
    target = room.players.get(ranking[idx - 1])
    if target:
        await _safe_send(target.ws, {"type": "hit", "item": item, "from": shooter.callsign})


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

            if isinstance(msg, JoinMsg):
                if msg.room is not None and msg.room != room:
                    await _safe_send(websocket, {"type": "error", "detail": "room mismatch"})
                    continue
                if msg.callsign in r.players:
                    await _safe_send(websocket, {"type": "error", "detail": "callsign already connected in this room"})
                    continue
                player = Player(websocket, msg.callsign)
                r.players[msg.callsign] = player
                await _safe_send(websocket, {"type": "joined", "room": room})
                continue

            if player is None:
                await _safe_send(websocket, {"type": "error", "detail": "join first"})
                continue

            if isinstance(msg, PosMsg):
                player.gate, player.elapsed_ms, player.lat, player.lon = msg.gate, msg.elapsed_ms, msg.lat, msg.lon
                await _check_banana(r, player)
                await _broadcast_standings(r)
            elif isinstance(msg, BoxMsg):
                ranking = r.ranking()
                item = roll_item(ranking.index(player.callsign), len(ranking))
                player.carrying = item
                await _safe_send(websocket, {"type": "grant", "item": item})
            elif isinstance(msg, FireMsg):
                if player.carrying != msg.item:
                    await _safe_send(websocket, {"type": "error", "detail": "item not carried"})
                    continue
                player.carrying = None
                await _resolve_fire(r, player, msg.item)
    except WebSocketDisconnect:
        pass
    finally:
        if player is not None:
            r.players.pop(player.callsign, None)
        if not r.players:
            rooms.pop(room, None)
