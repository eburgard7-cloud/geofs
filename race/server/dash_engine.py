"""The Dash: an airport-to-airport race, ground start, landing finish (race/PROTOCOL.md "Proto 11").

Pure. No sockets, no asyncio, no SQLite, no wall clock: every method takes the server's `now_ms`
(app.py's server_ms()), and every judgement is made from the entrants' OWN pings as the relay
received them. app.py owns one DashEngine per room while a Dash is on, feeds it frames and a 1 Hz
tick, and turns what it reports (`take_events()`) into frames, hook calls and the SQLite write.

State machine (the room's phase while a Dash is on):

    ROAM -> dash_staging -> dash_countdown -> dash_running -> dash_results -> ROAM
              (create)        (go)              (GO)          (all done / 10 min
                                                               after 1st finish / cap)
    staging or countdown with nobody left, or staging nobody starts in 15 min -> cancelled -> ROAM

Every tunable number is a module constant below (the Dash's "CONFIG" table), so a test can
monkeypatch it and a reader can find it.
"""
import math
import re
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import airportdb

# ------------------------------------------------------------------------------------- CONFIG
DASH_LEAD_PRESETS_S = (10, 20, 30, 45)   # race.js CONFIG.COUNTDOWN_LEAD_PRESETS_S
READY_MAX_GS_KT = 30.0          # ready (and a clean start) means on the ground, slower than this...
READY_RADIUS_M = 3000.0         # ...within this of the departure airport's reference point...
PING_FRESH_MS = 5000            # ...on a ping no older than this
JUMP_START_PENALTY_MS = 15000   # airborne or > READY_MAX_GS_KT between countdown start and GO
CEILING_GRACE_MS = 3000         # each excursion above the ceiling is free for this long...
CEILING_PENALTY_MS_PER_S = 1000  # ...then costs this per whole second
SPLIT_FRACTIONS = (0.25, 0.50, 0.75)
FINISH_MIN_PINGS = 2            # a finish needs the last 2 pings...
FINISH_WINDOW_MS = 4000         # ...both from the last 4 s, inside the destination,
FINISH_MAX_GS_KT = 30.0         # on the ground and slower than this
TOUCHDOWN_TOLERANCE_MS = 3000   # touchdown_ms vs the relay's own airborne/ground observations
NO_PING_DNF_MS = 30000          # running, and silent this long: DNF (timeout)
FINISH_WINDOW_AFTER_FIRST_MS = 10 * 60 * 1000   # the Dash ends this long after the first finish
DASH_MAX_MS = 3 * 3600 * 1000   # ...or this long after GO, whatever happens
RESULTS_LINGER_MS = 20000       # dash_results -> ROAM after this, or when everyone dismisses
STAGING_MAX_MS = 15 * 60 * 1000  # a card nobody starts is cancelled after this (the room is freed)
# Landing penalty by sink rate at touchdown: (below this fpm, penalty ms), checked in order; at or
# above the last bound, or bounced, it is LANDING_PENALTY_HARD_MS.
LANDING_PENALTIES = ((600, 0), (900, 3000), (1200.0001, 10000))
LANDING_PENALTY_HARD_MS = 20000
PING_RING = 64                  # pings kept per entrant
CEILING_MIN_FT, CEILING_MAX_FT = 1000, 60000
# Runways and the generated route (dash-arrival). A route is a plan, not a course: nothing makes a
# pilot fly over it, so it never changes route_key; it only steers the HUD and measures progress.
NM_M = 1852.0
RUNWAY_TIE_DEG = 5.0            # runway ends this close to the best alignment are a tie -> the longest
RUNWAY_MIN_LENGTH_FRAC = 0.6    # auto-pick skips runways shorter than this x the airport's longest
CLIMB_NM = 5.0                  # the climb waypoint: this far out on the departure runway heading...
CLIMB_MIN_ROUTE_NM = 20.0       # ...dropped when the airports are closer than this
FAF_NM = 8.0                    # the final approach fix: this far out on the arrival's extended centreline
MAX_VIAS = 3
LANDING_RUNWAY_MAX_DEG = 60.0   # a touchdown heading within this of a runway end's = that end
CLASS_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
FT_M = 0.3048
DNF_REASONS = ("retired", "crash", "timeout", "left", "disconnect", "cap", "dq")
DQ_DETAILS = ("slew", "teleport")   # why a "dq" (the client's own cheat detection); optional

STAGING, COUNTDOWN, RUNNING, RESULTS = "dash_staging", "dash_countdown", "dash_running", "dash_results"
CANCELLED = "cancelled"         # nobody left before GO: the room goes home, nothing is scored
PHASES = (STAGING, COUNTDOWN, RUNNING, RESULTS)


# ------------------------------------------------------------------------------------- geometry
def _unit(lat: float, lon: float) -> tuple[float, float, float]:
    p, lam = math.radians(lat), math.radians(lon)
    return (math.cos(p) * math.cos(lam), math.cos(p) * math.sin(lam), math.sin(p))


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a):
    n = math.sqrt(_dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n) if n > 0 else a


def along_track(dep: dict, dst: dict, lat: float, lon: float) -> tuple[float, float]:
    """(progress 0..1 along the great circle dep -> dst, metres remaining to dst). Progress is the
    point projected onto the route's great circle, so flying wide of the line neither helps nor
    hurts it; remaining is plain great-circle distance to the destination."""
    a, b, p = _unit(dep["lat"], dep["lon"]), _unit(dst["lat"], dst["lon"]), _unit(lat, lon)
    total = math.atan2(math.sqrt(_dot(_cross(a, b), _cross(a, b))), _dot(a, b))
    remaining = airportdb.distance_m(lat, lon, dst["lat"], dst["lon"])
    if total <= 0:
        return 1.0, remaining
    n = _norm(_cross(a, b))
    off = _dot(p, n)
    q = _norm((p[0] - off * n[0], p[1] - off * n[1], p[2] - off * n[2]))
    along = math.atan2(_dot(_cross(a, q), n), _dot(a, q))
    return max(0.0, min(1.0, along / total)), remaining


def split_crossings(prev: Optional[tuple[int, float]], cur: tuple[int, float],
                    done: set, fractions=None) -> list[tuple[int, int]]:
    """[(split number 1.., GO-relative ms)] for every split line first crossed between two pings,
    the time interpolated linearly on progress. `prev`/`cur` are (t_ms, progress); `done` holds
    the split numbers already crossed (never re-reported)."""
    fractions = SPLIT_FRACTIONS if fractions is None else fractions
    t1, s1 = cur
    out = []
    for i, f in enumerate(fractions, start=1):
        if i in done or s1 < f:
            continue
        if prev is None or prev[1] >= f or s1 <= prev[1]:
            out.append((i, t1))
        else:
            t0, s0 = prev
            out.append((i, int(round(t0 + (f - s0) / (s1 - s0) * (t1 - t0)))))
    return out


def landing_penalty(sink_fpm: float, bounced: bool) -> int:
    """< 600 fpm 0; 600-900 +3 s; 900-1200 +10 s; over 1200 or bounced +20 s."""
    if bounced:
        return LANDING_PENALTY_HARD_MS
    s = abs(sink_fpm)
    for bound, ms in LANDING_PENALTIES:
        if s < bound:
            return ms
    return LANDING_PENALTY_HARD_MS


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle bearing, degrees true 0..360."""
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def final_bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """The great circle's bearing on ARRIVAL at the second point (the inbound course there)."""
    return (bearing_deg(lat2, lon2, lat1, lon1) + 180.0) % 360.0


def destination_point(lat: float, lon: float, brg: float, dist_m: float) -> tuple[float, float]:
    d, b = dist_m / airportdb.EARTH_R_M, math.radians(brg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def ang_diff(a: float, b: float) -> float:
    return abs(((a - b) % 360.0 + 540.0) % 360.0 - 180.0)


def runway_ends(apt: dict) -> list[dict]:
    """Every runway end with coordinates: {ident, opposite, lat, lon (threshold), heading_deg (true,
    threshold toward the far end), length_m, width_m, elev_ft}. The dataset's own `hdg` is not used:
    the two ends give the true bearing exactly."""
    out = []
    for r in apt.get("runways") or ():
        if not airportdb.runway_has_ends(r):
            continue
        le, he = (r["le_lat"], r["le_lon"]), (r["he_lat"], r["he_lon"])
        length_m = r["length_ft"] * FT_M if r.get("length_ft") else airportdb.distance_m(*le, *he)
        width_m = (r.get("width_ft") or 150) * FT_M
        elev = r.get("elev_ft") if r.get("elev_ft") is not None else apt.get("elev_ft")
        for (a, b, ident, opp) in ((le, he, r.get("le"), r.get("he")), (he, le, r.get("he"), r.get("le"))):
            out.append({"ident": str(ident or "").upper(), "opposite": str(opp or "").upper(),
                        "lat": a[0], "lon": a[1], "heading_deg": bearing_deg(*a, *b),
                        "length_m": length_m, "width_m": width_m, "elev_ft": elev})
    return out


def pick_runway(apt: dict, course_deg: Optional[float], override: Optional[str] = None
                ) -> tuple[Optional[str], Optional[dict]]:
    """(error, end) for one airport. `override` must name a real end (case-insensitive). Otherwise
    the end best aligned with `course_deg` among the airport's main runways (at least
    RUNWAY_MIN_LENGTH_FRAC of its longest, so a crosswind strip never wins an airliner arrival); ends within RUNWAY_TIE_DEG of the best are a tie, which
    goes to the longest, then the ident (so every server picks the same one). (None, None) for an
    airport with no runway coordinates: the Dash then falls back to its reference point."""
    ends = runway_ends(apt)
    if override is not None and str(override).strip():
        want = str(override).strip().upper()
        hit = next((e for e in ends if e["ident"] == want), None)
        if hit is None:
            return f"unknown runway {want!r} at {apt['icao']}", None
        return None, {**hit, "auto": False}
    if not ends:
        return None, None
    longest = max(e["length_m"] for e in ends)
    ends = [e for e in ends if e["length_m"] >= RUNWAY_MIN_LENGTH_FRAC * longest]
    course = course_deg if course_deg is not None else 0.0
    best = min(ang_diff(e["heading_deg"], course) for e in ends)
    tied = [e for e in ends if ang_diff(e["heading_deg"], course) <= best + RUNWAY_TIE_DEG]
    tied.sort(key=lambda e: (-round(e["length_m"]), e["ident"]))
    return None, {**tied[0], "auto": True}


def runway_public(end: Optional[dict]) -> Optional[dict]:
    """A picked end as the card carries it."""
    if end is None:
        return None
    return {"ident": end["ident"], "opposite": end["opposite"], "thr_lat": round(end["lat"], 6),
            "thr_lon": round(end["lon"], 6), "heading_deg": round(end["heading_deg"], 2),
            "length_m": round(end["length_m"]), "width_m": round(end["width_m"], 1),
            "elev_ft": end["elev_ft"], "auto": bool(end.get("auto"))}


def build_route(dep: dict, dep_end: Optional[dict], dst: dict, dst_end: Optional[dict],
                vias: Optional[list] = None) -> list[list]:
    """[[lat, lon, name], ...]: departure threshold -> CLIMB (CLIMB_NM out on the runway heading)
    -> vias -> FAF (FAF_NM out on the arrival's extended centreline) -> arrival threshold. With no
    runway at an end, that end is its reference point and its CLIMB/FAF is left out; CLIMB is also
    left out when the airports are under CLIMB_MIN_ROUTE_NM apart. `vias`: [{lat, lon, name}]."""
    pts: list[tuple] = []
    gc = airportdb.distance_m(dep["lat"], dep["lon"], dst["lat"], dst["lon"])
    if dep_end is not None:
        pts.append((dep_end["lat"], dep_end["lon"], f"{dep['icao']} {dep_end['ident']}".strip()))
        if gc >= CLIMB_MIN_ROUTE_NM * NM_M:
            pts.append((*destination_point(dep_end["lat"], dep_end["lon"], dep_end["heading_deg"], CLIMB_NM * NM_M), "CLIMB"))
    else:
        pts.append((dep["lat"], dep["lon"], dep["icao"]))
    for v in vias or ():
        pts.append((v["lat"], v["lon"], v["name"]))
    if dst_end is not None:
        back = (dst_end["heading_deg"] + 180.0) % 360.0
        pts.append((*destination_point(dst_end["lat"], dst_end["lon"], back, FAF_NM * NM_M), "FAF"))
        pts.append((dst_end["lat"], dst_end["lon"], f"{dst['icao']} {dst_end['ident']}".strip()))
    else:
        pts.append((dst["lat"], dst["lon"], dst["icao"]))
    return [[round(a, 6), round(b, 6), n] for a, b, n in pts]


def route_length_m(route: list) -> float:
    return sum(airportdb.distance_m(a[0], a[1], b[0], b[1]) for a, b in zip(route, route[1:]))


def _project(a: tuple, b: tuple, lat: float, lon: float) -> tuple[float, float]:
    """(fraction 0..1 along the great-circle segment a -> b of the point nearest (lat, lon), metres
    from (lat, lon) to that point)."""
    ua, ub, p = _unit(*a), _unit(*b), _unit(lat, lon)
    total = math.atan2(math.sqrt(_dot(_cross(ua, ub), _cross(ua, ub))), _dot(ua, ub))
    if total <= 0:
        return 0.0, airportdb.distance_m(lat, lon, a[0], a[1])
    n = _norm(_cross(ua, ub))
    off = _dot(p, n)
    q = _norm((p[0] - off * n[0], p[1] - off * n[1], p[2] - off * n[2]))
    f = max(0.0, min(1.0, math.atan2(_dot(_cross(ua, q), n), _dot(ua, q)) / total))
    w, t = f * total, _cross(n, ua)
    c = tuple(ua[i] * math.cos(w) + t[i] * math.sin(w) for i in range(3))
    clat, clon = math.degrees(math.asin(max(-1.0, min(1.0, c[2])))), math.degrees(math.atan2(c[1], c[0]))
    return f, airportdb.distance_m(lat, lon, clat, clon)


def along_route(route: list, lat: float, lon: float) -> tuple[float, float]:
    """(progress 0..1 along the route polyline, metres remaining along it). The position is
    projected onto the nearest segment (clamped to it), so flying wide neither helps nor hurts."""
    legs = [airportdb.distance_m(a[0], a[1], b[0], b[1]) for a, b in zip(route, route[1:])]
    total = sum(legs)
    if total <= 0:
        return 1.0, airportdb.distance_m(lat, lon, route[-1][0], route[-1][1])
    best, cum = None, 0.0
    for i, (a, b) in enumerate(zip(route, route[1:])):
        f, d = _project((a[0], a[1]), (b[0], b[1]), lat, lon)
        if best is None or d < best[0]:
            best = (d, cum + f * legs[i])
        cum += legs[i]
    along = best[1]
    return max(0.0, min(1.0, along / total)), max(0.0, total - along)


def landing_runway(apt: dict, lat: float, lon: float, hdg: Optional[float]) -> Optional[str]:
    """The runway end a touchdown at (lat, lon) heading `hdg` was on: of the ends within
    LANDING_RUNWAY_MAX_DEG of the heading, the one whose centreline is nearest. None without a
    heading or runway coordinates. Informational only (never scored)."""
    if hdg is None:
        return None
    best = None
    for r in apt.get("runways") or ():
        if not airportdb.runway_has_ends(r):
            continue
        d = airportdb.point_segment_m(lat, lon, r["le_lat"], r["le_lon"], r["he_lat"], r["he_lon"])
        for ident, a, b in ((r.get("le"), (r["le_lat"], r["le_lon"]), (r["he_lat"], r["he_lon"])),
                            (r.get("he"), (r["he_lat"], r["he_lon"]), (r["le_lat"], r["le_lon"]))):
            if ident and ang_diff(bearing_deg(*a, *b), hdg) <= LANDING_RUNWAY_MAX_DEG and (best is None or d < best[0]):
                best = (d, str(ident).upper())
    return best[1] if best else None


def validate_plan(db, dep: dict, dst: dict, from_runway: Optional[str] = None,
                  to_runway: Optional[str] = None, vias: Optional[list] = None
                  ) -> tuple[Optional[str], Optional[dict]]:
    """(error, None) or (None, plan) for a Dash's runways and route. `vias`: up to MAX_VIAS, each an
    airport code or [lat, lon]. The departure runway is the end best aligned with the first leg's
    outbound course, the arrival runway the one best aligned with the last leg's inbound course
    (each overridable by ident). plan: {from_runway, to_runway (picked ends or None), vias, route,
    route_m, overrides: {from_runway, to_runway, vias} (what a rematch reuses)}."""
    vias = list(vias or [])
    if len(vias) > MAX_VIAS:
        return f"at most {MAX_VIAS} via waypoints", None
    pts = []
    for i, v in enumerate(vias, start=1):
        if isinstance(v, str):
            apt = db.get(v) if db is not None else None
            if apt is None:
                return f"unknown airport {v.upper()!r}", None
            pts.append({"lat": apt["lat"], "lon": apt["lon"], "name": apt["icao"], "spec": apt["icao"]})
        elif (isinstance(v, (list, tuple)) and len(v) == 2
              and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)
              and -90 <= v[0] <= 90 and -180 <= v[1] <= 180):
            pts.append({"lat": float(v[0]), "lon": float(v[1]), "name": f"WPT{i}",
                        "spec": [round(float(v[0]), 5), round(float(v[1]), 5)]})
        else:
            return "a via must be an airport code or [lat, lon]", None
    first = pts[0] if pts else dst
    last = pts[-1] if pts else dep
    err, dep_end = pick_runway(dep, bearing_deg(dep["lat"], dep["lon"], first["lat"], first["lon"]), from_runway)
    if err:
        return err, None
    err, dst_end = pick_runway(dst, final_bearing_deg(last["lat"], last["lon"], dst["lat"], dst["lon"]), to_runway)
    if err:
        return err, None
    route = build_route(dep, dep_end, dst, dst_end, pts)
    specs = [p["spec"] for p in pts]
    return None, {"from_runway": dep_end, "to_runway": dst_end, "vias": specs,
                  "route": route, "route_m": route_length_m(route),
                  "overrides": {"from_runway": dep_end["ident"] if dep_end and not dep_end["auto"] else None,
                                "to_runway": dst_end["ident"] if dst_end and not dst_end["auto"] else None,
                                "vias": specs}}


def route_key(from_icao: str, to_icao: str, ceiling_ft: Optional[int], cls: Optional[str]) -> str:
    """KPDX>KSEA|10000|jets -- ceiling 'none' when there is none, the class part only when set."""
    key = f"{from_icao}>{to_icao}|{ceiling_ft if ceiling_ft else 'none'}"
    return f"{key}|{cls}" if cls else key


@dataclass
class Ping:
    at_ms: int                      # server_ms() the relay received it
    lat: float
    lon: float
    alt_m: Optional[float]
    on_ground: Optional[bool]
    gs_kt: Optional[float]
    hdg: Optional[float] = None     # dash-arrival: which runway a touchdown was on (informational)


def ready_block(ping: Optional[Ping], dep: dict, now_ms: int) -> Optional[str]:
    """Why this ping does NOT make its pilot ready (None = it does): fresh, on the ground, slow,
    and within READY_RADIUS_M of the departure airport's reference point. Named, with the value."""
    if ping is None:
        return "no position report yet"
    if now_ms - ping.at_ms > PING_FRESH_MS:
        return f"no position report for {(now_ms - ping.at_ms) // 1000} s"
    if ping.on_ground is not True:
        return "not on the ground"
    if ping.gs_kt is None or ping.gs_kt >= READY_MAX_GS_KT:
        return f"moving ({ping.gs_kt if ping.gs_kt is not None else '?'} kt, max {READY_MAX_GS_KT:g})"
    d = airportdb.distance_m(ping.lat, ping.lon, dep["lat"], dep["lon"])
    if d > READY_RADIUS_M:
        return f"{d / 1000:.1f} km from {dep['icao']} (max {READY_RADIUS_M / 1000:g} km)"
    return None


def validate_create(db, from_code, to_code, ceiling_ft, cls) -> tuple[Optional[str], Optional[tuple]]:
    """(error, None) or (None, (dep, dst, ceiling_ft, cls)) for a dash_create."""
    if db is None:
        return "dash unavailable: this server has no airport data", None
    dep, dst = db.get(from_code or ""), db.get(to_code or "")
    if dep is None:
        return f"unknown airport {str(from_code).upper()!r}", None
    if dst is None:
        return f"unknown airport {str(to_code).upper()!r}", None
    if dep["icao"] == dst["icao"]:
        return "departure and destination are the same airport", None
    if ceiling_ft is not None and not (CEILING_MIN_FT <= ceiling_ft <= CEILING_MAX_FT):
        return f"ceiling must be {CEILING_MIN_FT}-{CEILING_MAX_FT} ft or none", None
    if cls is not None:
        cls = cls.strip().lower()
        if not CLASS_RE.match(cls):
            return "class must be 1-24 of a-z, 0-9 and '-'", None
    return None, (dep, dst, ceiling_ft, cls or None)


# ------------------------------------------------------------------------------------- entrants
@dataclass
class Entrant:
    callsign: str
    model: str = ""
    ready: bool = False
    status: Optional[str] = None        # None (in it) | finished | dnf | dns
    reason: Optional[str] = None        # dnf/dns reason
    detail: Optional[str] = None        # only for reason "dq": one of DQ_DETAILS, else None
    slot: int = 0                       # stable line-up slot (0-based), held from join until they leave
    pings: deque = field(default_factory=lambda: deque(maxlen=PING_RING))
    progress: float = 0.0
    best_progress: float = 0.0
    remaining_m: Optional[float] = None
    last_t: Optional[int] = None        # GO-relative ms of the last running ping
    splits: dict = field(default_factory=dict)   # split no -> GO-relative ms
    jump: bool = False
    above_since: Optional[int] = None   # ceiling: GO-relative ms of this excursion's first ping
    exc_counted_ms: int = 0
    over_ms: int = 0                    # ceiling time beyond the grace, summed over excursions
    last_airborne_t: Optional[int] = None
    dest_ground_t: Optional[int] = None  # first in-destination ground ping since last airborne
    dest_ground_ping: Optional[Ping] = None   # ...and that ping (the landing runway is read off it)
    touchdown_ms: Optional[int] = None
    stopped_ms: Optional[int] = None
    sink_fpm: Optional[float] = None
    bounced: Optional[bool] = None
    landing_score: Optional[float] = None
    seq: int = 0
    dismissed: bool = False

    @property
    def last_ping(self) -> Optional[Ping]:
        return self.pings[-1] if self.pings else None

    @property
    def jump_ms(self) -> int:
        return JUMP_START_PENALTY_MS if self.jump else 0

    @property
    def ceiling_ms(self) -> int:
        return (self.over_ms // 1000) * CEILING_PENALTY_MS_PER_S

    @property
    def landing_ms(self) -> int:
        return 0 if self.sink_fpm is None else landing_penalty(self.sink_fpm, bool(self.bounced))

    @property
    def total_ms(self) -> Optional[int]:
        if self.status != "finished":
            return None
        return self.touchdown_ms + self.jump_ms + self.ceiling_ms + self.landing_ms


# ------------------------------------------------------------------------------------- engine
class DashEngine:
    def __init__(self, dash_id: int, dep: dict, dst: dict, ceiling_ft: Optional[int],
                 cls: Optional[str], marshal: str, now_ms: int, plan: Optional[dict] = None):
        self.dash_id = dash_id
        # dash-arrival: runways and the generated route (validate_plan). None = the old great-circle
        # Dash: progress along dep -> dst, guidance to the reference points.
        self.plan = plan
        self.route = plan["route"] if plan else None
        self.dep, self.dst = dep, dst
        self.ceiling_ft, self.cls = ceiling_ft, cls
        self.marshal = marshal
        self.created_ms = now_ms
        self.phase = STAGING
        self.entrants: dict[str, Entrant] = {}
        self.lead_s: Optional[int] = None
        self.countdown_start_ms: Optional[int] = None
        self.go_ms: Optional[int] = None
        self.first_finish_ms: Optional[int] = None
        self.results_at_ms: Optional[int] = None
        self.finish_seq = 0
        self.distance_m = airportdb.distance_m(dep["lat"], dep["lon"], dst["lat"], dst["lon"])
        self._events: list[dict] = []

    # ---- bookkeeping
    @property
    def route_key(self) -> str:
        return route_key(self.dep["icao"], self.dst["icao"], self.ceiling_ft, self.cls)

    @property
    def ceiling_m(self) -> Optional[float]:
        return None if self.ceiling_ft is None else self.ceiling_ft * FT_M

    def _emit(self, kind: str, **kw) -> None:
        self._events.append({"kind": kind, **kw})

    def take_events(self) -> list[dict]:
        out, self._events = self._events, []
        return out

    def racing(self) -> list[Entrant]:
        return [e for e in self.entrants.values() if e.status is None]

    # ---- staging
    def join(self, callsign: str, model: str = "") -> Optional[str]:
        if self.phase != STAGING:
            return "the dash has already started"
        if callsign in self.entrants:
            return "already in this dash"
        self.entrants[callsign] = Entrant(callsign, model, slot=self._free_slot())
        self._emit("card")
        return None

    def _free_slot(self) -> int:
        """The lowest line-up slot nobody holds. Slots are never renumbered: a pilot keeps theirs
        until they leave, and the next joiner takes the lowest gap."""
        taken = {e.slot for e in self.entrants.values()}
        return next(i for i in range(len(taken) + 1) if i not in taken)

    def leave(self, callsign: str, now_ms: int) -> Optional[str]:
        e = self.entrants.get(callsign)
        if e is None:
            return "not in this dash"
        if self.phase in (STAGING, COUNTDOWN):
            del self.entrants[callsign]
            self._emit("card")
            if not self.entrants:          # an empty card would hold the room's one event slot
                self._cancel("everyone left")
            return None
        if self.phase == RUNNING:
            return self.dnf(callsign, "left", now_ms)
        return "the dash is over"

    def ready(self, callsign: str, ready: bool, now_ms: int) -> Optional[str]:
        e = self.entrants.get(callsign)
        if e is None:
            return "join the dash first"
        if self.phase != STAGING:
            return "ready only before the countdown"
        if ready:
            why = ready_block(e.last_ping, self.dep, now_ms)
            if why is not None:
                return f"not ready: {why}"
        e.ready = ready
        self._emit("card")
        return None

    def go(self, lead_s: int, now_ms: int) -> Optional[str]:
        if self.phase != STAGING:
            return "the dash has already started"
        if lead_s not in DASH_LEAD_PRESETS_S:
            return f"lead must be one of {', '.join(str(s) for s in DASH_LEAD_PRESETS_S)} s"
        if not self.entrants:
            return "nobody has joined"
        waiting = [e.callsign for e in self.entrants.values() if not e.ready]
        if waiting:
            return f"not everyone is ready: {', '.join(waiting)}"
        self.phase = COUNTDOWN
        self.lead_s = lead_s
        self.countdown_start_ms = now_ms
        self.go_ms = now_ms + lead_s * 1000
        self._emit("card")
        return None

    def cancel(self, reason: str = "cancelled") -> Optional[str]:
        if self.phase not in (STAGING, COUNTDOWN):
            return "only before GO"
        self._cancel(reason)
        return None

    def _cancel(self, reason: str) -> None:
        self.phase = CANCELLED
        self._emit("cancelled", reason=reason)

    # ---- GO
    def on_go(self, now_ms: int) -> None:
        """The countdown ran out (app calls this at go_ms). GO is the server's timestamp, never
        `now_ms`: the race clock is ms since go_ms. Everyone is re-checked here."""
        if self.phase != COUNTDOWN:
            return
        for e in self.entrants.values():
            # The state AT GO: the newest ping from before it (a ping after GO is the race).
            p = next((q for q in reversed(e.pings) if q.at_ms <= self.go_ms), None)
            if p is None or self.go_ms - p.at_ms > PING_FRESH_MS:
                e.status, e.reason = "dns", "no position report at GO"
            else:
                d = airportdb.distance_m(p.lat, p.lon, self.dep["lat"], self.dep["lon"])
                if d > READY_RADIUS_M:
                    e.status, e.reason = "dns", f"{d / 1000:.1f} km from {self.dep['icao']} at GO"
                elif p.on_ground is not True or (p.gs_kt or 0) > READY_MAX_GS_KT:
                    e.jump = True
            if e.status == "dns":
                self._emit("scratched", callsign=e.callsign, reason=e.reason)
        if not self.racing():
            self._cancel("nobody was on the line at GO")
            return
        self.phase = RUNNING
        for e in self.racing():
            e.last_t = None
        self._emit("leg_start", entrants=[e.callsign for e in self.racing()], go_ms=self.go_ms)
        self._emit("card")

    # ---- pings
    def on_ping(self, callsign: str, ping: Ping) -> None:
        e = self.entrants.get(callsign)
        if e is None:
            return
        e.pings.append(ping)
        now_ms = ping.at_ms
        # GO is a timestamp, not an event: a ping at or after go_ms belongs to the race even if the
        # task that flips the phase has not run yet -- it must never be judged a jump start.
        if self.phase == COUNTDOWN and now_ms >= self.go_ms:
            self.on_go(now_ms)
            if self.phase != RUNNING or e.status is not None:
                return
        if self.phase == STAGING:
            if e.ready and ready_block(ping, self.dep, now_ms) is not None:
                e.ready = False            # ready means the LATEST ping says so
                self._emit("card")
            return
        if self.phase == COUNTDOWN:
            if not e.jump and (ping.on_ground is not True or (ping.gs_kt or 0) > READY_MAX_GS_KT):
                e.jump = True
                self._emit("penalty", callsign=callsign, penalty="jump", ms=JUMP_START_PENALTY_MS)
                self._emit("card")
            return
        if self.phase != RUNNING or e.status is not None:
            return
        t = now_ms - self.go_ms
        if self.route:
            prog, remaining = along_route(self.route, ping.lat, ping.lon)
        else:
            prog, remaining = along_track(self.dep, self.dst, ping.lat, ping.lon)
        prev = (e.last_t, e.best_progress) if e.last_t is not None else None
        for n, at in split_crossings(prev, (t, prog), set(e.splits)):
            e.splits[n] = at
            first = [x.splits[n] for x in self.entrants.values() if n in x.splits]
            leader_t = min(first)
            pos = sorted(first).index(at) + 1
            self._emit("split", callsign=callsign, split=n, pct=int(round(SPLIT_FRACTIONS[n - 1] * 100)),
                       t_ms=at, gap_ms=at - leader_t, pos=pos)
        e.progress, e.remaining_m, e.last_t = prog, remaining, t
        e.best_progress = max(e.best_progress, prog)
        # Ceiling: each excursion's first CEILING_GRACE_MS is free; after that every whole second
        # above costs CEILING_PENALTY_MS_PER_S. An excursion is timed first-above-ping to
        # last-above-ping, so a pilot is never charged for the gap after the ping that saw them
        # back below.
        if self.ceiling_m is not None and ping.alt_m is not None:
            if ping.alt_m > self.ceiling_m:
                if e.above_since is None:
                    e.above_since, e.exc_counted_ms = t, 0
                counted = max(0, (t - e.above_since) - CEILING_GRACE_MS)
                before = e.ceiling_ms
                e.over_ms += counted - e.exc_counted_ms
                e.exc_counted_ms = counted
                if e.ceiling_ms != before:
                    self._emit("penalty", callsign=callsign, penalty="ceiling", ms=e.ceiling_ms)
            else:
                e.above_since, e.exc_counted_ms = None, 0
        # What the finish check is measured against: the last time the relay saw this pilot in the
        # air, and the first in-destination ground ping since then.
        if ping.on_ground is not True:
            e.last_airborne_t, e.dest_ground_t, e.dest_ground_ping = t, None, None
        elif e.dest_ground_t is None and airportdb.in_destination(self.dst, ping.lat, ping.lon):
            e.dest_ground_t, e.dest_ground_ping = t, ping

    # ---- results
    def finish(self, callsign: str, touchdown_ms: int, stopped_ms: int, sink_fpm: float,
               bounced: bool, landing_score: Optional[float], now_ms: int) -> Optional[str]:
        """Why a finish is refused, or None once it is taken. The relay believes a touchdown only
        when its OWN recent pings put the pilot inside the destination, on the ground and nearly
        stopped, and the claimed time sits between what it saw airborne and on the ground."""
        if self.phase != RUNNING:
            return "the dash is not running"
        e = self.entrants.get(callsign)
        if e is None:
            return "not in this dash"
        if e.status is not None:
            return "already finished or out"
        # "Recent" is the last FINISH_MIN_PINGS pings, all inside FINISH_WINDOW_MS: a client sends
        # its finish once it has reported itself stopped twice, and the rollout before that (which
        # at 1-2 Hz still holds 50+ kt pings) does not count against it.
        recent = list(e.pings)[-FINISH_MIN_PINGS:]
        if len(recent) < FINISH_MIN_PINGS or any(
                now_ms - p.at_ms > FINISH_WINDOW_MS or p.at_ms < self.go_ms for p in recent):
            return "not enough recent position reports"
        if any(p.on_ground is not True for p in recent):
            return "not on the ground"
        fast = max((p.gs_kt if p.gs_kt is not None else 999.0) for p in recent)
        if fast >= FINISH_MAX_GS_KT:
            return f"still moving ({fast:.0f} kt, max {FINISH_MAX_GS_KT:g})"
        worst = max(airportdb.destination_distance_m(self.dst, p.lat, p.lon)[0] for p in recent)
        if worst > 0:
            return f"not at {self.dst['icao']} ({worst / 1000:.1f} km outside)"
        if e.last_airborne_t is None:
            return "never seen airborne"
        t_now = now_ms - self.go_ms
        hi = min(t_now, e.dest_ground_t if e.dest_ground_t is not None else t_now) + TOUCHDOWN_TOLERANCE_MS
        if not (e.last_airborne_t - TOUCHDOWN_TOLERANCE_MS <= touchdown_ms <= hi):
            return "touchdown time does not match the relay's clock"
        if stopped_ms < touchdown_ms:
            return "stopped before touching down"
        self.finish_seq += 1
        e.status, e.seq = "finished", self.finish_seq
        e.touchdown_ms, e.stopped_ms = touchdown_ms, stopped_ms
        e.sink_fpm, e.bounced, e.landing_score = float(sink_fpm), bool(bounced), landing_score
        e.progress = e.best_progress = 1.0
        e.remaining_m = 0.0
        if self.first_finish_ms is None:
            self.first_finish_ms = now_ms
        self._emit("leg_finish", callsign=callsign, status="finished", result=self.row(e))
        self._emit("card")
        self._maybe_end(now_ms)
        return None

    def dnf(self, callsign: str, reason: str, now_ms: int, detail: Optional[str] = None) -> Optional[str]:
        if self.phase != RUNNING:
            return "the dash is not running"
        e = self.entrants.get(callsign)
        if e is None:
            return "not in this dash"
        if e.status is not None:
            return "already finished or out"
        e.status, e.reason = "dnf", reason if reason in DNF_REASONS else "retired"
        e.detail = detail if e.reason == "dq" and detail in DQ_DETAILS else None
        self._emit("leg_finish", callsign=callsign, status="dnf", result=self.row(e))
        self._emit("card")
        self._maybe_end(now_ms)
        return None

    def tick(self, now_ms: int) -> None:
        """1 Hz from app.py: the GO flip as a fallback, silent pilots, and the end conditions."""
        if self.phase == COUNTDOWN and now_ms >= self.go_ms:
            self.on_go(now_ms)
        if self.phase == STAGING and now_ms - self.created_ms >= STAGING_MAX_MS:
            self._cancel("nobody started it")
            return
        if self.phase != RUNNING:
            return
        for e in self.racing():
            last = e.last_ping.at_ms if e.last_ping is not None else 0
            if now_ms - max(last, self.go_ms) > NO_PING_DNF_MS:
                self.dnf(e.callsign, "timeout", now_ms)
                if self.phase != RUNNING:
                    return
        if self.first_finish_ms is not None and now_ms - self.first_finish_ms >= FINISH_WINDOW_AFTER_FIRST_MS:
            self._end(now_ms, "cap")
        elif now_ms - self.go_ms >= DASH_MAX_MS:
            self._end(now_ms, "cap")

    def _maybe_end(self, now_ms: int) -> None:
        if self.phase == RUNNING and not self.racing():
            self._end(now_ms, None)

    def _end(self, now_ms: int, straggler_reason: Optional[str]) -> None:
        if self.phase != RUNNING:
            return
        for e in self.racing():
            e.status, e.reason = "dnf", straggler_reason or "cap"
        self.phase = RESULTS
        self.results_at_ms = now_ms
        self._emit("results")
        self._emit("card")

    def home_due(self, now_ms: int) -> bool:
        return self.phase == RESULTS and now_ms - self.results_at_ms >= RESULTS_LINGER_MS

    def dismiss(self, callsign: str) -> Optional[str]:
        if self.phase != RESULTS:
            return "nothing to dismiss"
        e = self.entrants.get(callsign)
        if e is not None:
            e.dismissed = True
        return None

    def all_dismissed(self, present: set) -> bool:
        """Every entrant still in the room has dismissed (an entrant who left cannot hold it)."""
        here = [e for e in self.entrants.values() if e.callsign in present]
        return self.phase == RESULTS and bool(here) and all(e.dismissed for e in here)

    # ---- views
    def row(self, e: Entrant) -> dict:
        return {"callsign": e.callsign, "model": e.model, "status": e.status, "reason": e.reason,
                "detail": e.detail, "slot": e.slot,
                "total_ms": e.total_ms, "touchdown_ms": e.touchdown_ms, "stopped_ms": e.stopped_ms,
                "penalties": {"jump_ms": e.jump_ms, "ceiling_ms": e.ceiling_ms,
                              "landing_ms": e.landing_ms if e.status == "finished" else 0},
                "splits": [e.splits.get(i) for i in range(1, len(SPLIT_FRACTIONS) + 1)],
                "landing": ({"sink_fpm": e.sink_fpm, "bounced": e.bounced, "landing_score": e.landing_score,
                             **({"runway": self.landed_on(e)} if self.plan else {})}
                            if e.status == "finished" else None),
                "progress": round(e.best_progress, 4)}

    def landed_on(self, e: Entrant) -> Optional[str]:
        """The runway end the relay's first in-destination ground ping puts this finisher on."""
        p = e.dest_ground_ping
        return landing_runway(self.dst, p.lat, p.lon, p.hdg) if p is not None else None

    def ranked(self) -> list[Entrant]:
        status_rank = {"finished": 0, None: 1, "dnf": 2, "dns": 3}
        return sorted(self.entrants.values(), key=lambda e: (
            status_rank.get(e.status, 4),
            e.reason == "dq",               # among the DNFs, a disqualification goes last
            e.total_ms if e.status == "finished" else 0,
            e.seq if e.status == "finished" else 0,
            -e.best_progress, e.callsign))

    def result_rows(self) -> list[dict]:
        rows, best = [], None
        for i, e in enumerate(self.ranked(), start=1):
            r = self.row(e)
            r["pos"] = i
            if e.status == "finished":
                best = e.total_ms if best is None else best
                r["gap_ms"] = e.total_ms - best
            else:
                r["gap_ms"] = None
            rows.append(r)
        return rows

    def standings(self, now_ms: int) -> dict:
        rows = []
        for e in self.ranked():
            p = e.last_ping
            rows.append({"callsign": e.callsign, "status": e.status, "progress": round(e.progress, 4),
                         "remaining_m": None if e.remaining_m is None else round(e.remaining_m),
                         "alt_m": p.alt_m if p else None, "gs_kt": p.gs_kt if p else None,
                         "splits": len(e.splits), "penalty_ms": e.jump_ms + e.ceiling_ms,
                         "total_ms": e.total_ms})
        return {"dash_id": self.dash_id,
                "t_ms": (now_ms - self.go_ms) if self.go_ms is not None else None, "rows": rows}

    def card(self, now_ms: int) -> dict:
        """The Dash card (the `dash` frame's body): everything a client needs to draw it."""
        return {
            "dash_id": self.dash_id, "phase": self.phase, "route_key": self.route_key,
            "from": airportdb.public(self.dep), "to": airportdb.public(self.dst),
            "ceiling_ft": self.ceiling_ft, "class": self.cls, "distance_m": round(self.distance_m),
            "marshal": self.marshal, "lead_s": self.lead_s,
            "countdown_start_server_ms": self.countdown_start_ms, "go_server_ms": self.go_ms,
            "first_finish_server_ms": self.first_finish_ms,
            "ends_by_server_ms": (self.first_finish_ms + FINISH_WINDOW_AFTER_FIRST_MS
                                  if self.first_finish_ms is not None else None),
            "home_at_server_ms": (self.results_at_ms + RESULTS_LINGER_MS
                                  if self.results_at_ms is not None else None),
            "entrants": [{"callsign": e.callsign, "model": e.model, "ready": e.ready, "status": e.status,
                          "reason": e.reason, "detail": e.detail, "slot": e.slot, "jump_start": e.jump,
                          "ready_block": (ready_block(e.last_ping, self.dep, now_ms)
                                          if self.phase == STAGING else None)}
                         for e in sorted(self.entrants.values(), key=lambda e: e.slot)],
            **self.plan_fields(),
        }

    def plan_fields(self) -> dict:
        """dash-arrival, additive: the runways and the generated route. Empty without a plan, so
        the card is byte-for-byte the old one."""
        if not self.plan:
            return {}
        return {"from_runway": runway_public(self.plan["from_runway"]),
                "to_runway": runway_public(self.plan["to_runway"]),
                "route": self.plan["route"], "route_m": round(self.plan["route_m"]),
                "vias": self.plan["vias"]}
