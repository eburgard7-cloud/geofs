"""Airport data for the Dash (race/PROTOCOL.md "Proto 11: ROAM and Dash").

Pure: no FastAPI, no sockets, no SQLite. app.py loads one AirportDB at import time and the Dash
engine (dash_engine.py) asks it two questions: "which airport is KPDX?" and "is this position inside
KSEA?". The data is race/server/airports/airports.json.gz, built from OurAirports (public domain)
by race/server/airports/build_airports.py -- see that script for what is kept.
"""
import gzip
import json
import math
import os
import re
from typing import Optional

EARTH_R_M = 6371000.0
FT_M = 0.3048
DEST_RUNWAY_MARGIN_M = 1000.0      # "runway extents + 1 km"
DEST_FALLBACK_RADIUS_M = 3000.0    # an airport with no runway end coordinates: 3 km around its ARP
SEARCH_LIMIT = 10
CODE_RE = re.compile(r"^[A-Z0-9-]{2,8}$")
TYPE_ORDER = {"large": 0, "medium": 1}


def default_path() -> str:
    """RACE_AIRPORTS_PATH, else the image's /app/airports copy, else the checkout's own file (a
    local uvicorn run from race/server) -- the same posture as app.py's _default_*_dir()."""
    env = os.environ.get("RACE_AIRPORTS_PATH")
    if env:
        return env
    if os.path.isfile("/app/airports/airports.json.gz"):
        return "/app/airports/airports.json.gz"
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "airports", "airports.json.gz")


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (haversine), metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


def _local_xy(lat0: float, lon0: float, lat: float, lon: float) -> tuple[float, float]:
    """Flat-earth metres east/north of (lat0, lon0). Plenty at airport scale (a few km)."""
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * EARTH_R_M
    y = math.radians(lat - lat0) * EARTH_R_M
    return x, y


def point_segment_m(lat: float, lon: float, a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    """Distance from a point to the segment A-B, metres, in a local flat frame centred on A."""
    bx, by = _local_xy(a_lat, a_lon, b_lat, b_lon)
    px, py = _local_xy(a_lat, a_lon, lat, lon)
    seg2 = bx * bx + by * by
    t = 0.0 if seg2 <= 0 else max(0.0, min(1.0, (px * bx + py * by) / seg2))
    return math.hypot(px - t * bx, py - t * by)


def runway_has_ends(rwy: dict) -> bool:
    return None not in (rwy.get("le_lat"), rwy.get("le_lon"), rwy.get("he_lat"), rwy.get("he_lon"))


def destination_distance_m(apt: dict, lat: float, lon: float) -> tuple[float, str]:
    """How far outside the destination boundary a position is (<= 0 means inside), and which rule
    applied: 'runway' (nearest runway centreline, minus half its width, minus DEST_RUNWAY_MARGIN_M)
    or 'radius' (DEST_FALLBACK_RADIUS_M around the ARP, for an airport with no runway ends)."""
    best = None
    for rwy in apt.get("runways") or ():
        if not runway_has_ends(rwy):
            continue
        half_w = ((rwy.get("width_ft") or 150) * FT_M) / 2
        d = point_segment_m(lat, lon, rwy["le_lat"], rwy["le_lon"], rwy["he_lat"], rwy["he_lon"]) - half_w
        best = d if best is None else min(best, d)
    if best is not None:
        return best - DEST_RUNWAY_MARGIN_M, "runway"
    return distance_m(lat, lon, apt["lat"], apt["lon"]) - DEST_FALLBACK_RADIUS_M, "radius"


def in_destination(apt: dict, lat: float, lon: float) -> bool:
    return destination_distance_m(apt, lat, lon)[0] <= 0


def public(apt: dict) -> dict:
    """What GET /api/airports/{icao} and the dash card show. Everything in the dataset is public."""
    return {k: apt.get(k) for k in ("icao", "iata", "name", "city", "country", "type", "lat", "lon",
                                     "elev_ft", "runways")}


def summary(apt: dict) -> dict:
    """A search row: no runways, so ten of them stay small."""
    return {k: apt.get(k) for k in ("icao", "iata", "name", "city", "country", "type", "lat", "lon", "elev_ft")}


class AirportDB:
    def __init__(self, data: dict):
        self.version = data.get("version")
        self.airports: list[dict] = list(data.get("airports") or [])
        self.by_icao: dict[str, dict] = {}
        self.by_alias: dict[str, dict] = {}
        for a in self.airports:
            self.by_icao[a["icao"]] = a
        for a in self.airports:
            for alias in a.get("aliases") or ():
                # An alias never shadows a real key, and the first airport to claim one keeps it
                # (the list is sorted by ICAO, so that is deterministic).
                if alias not in self.by_icao and alias not in self.by_alias:
                    self.by_alias[alias] = a

    def __len__(self) -> int:
        return len(self.airports)

    def get(self, code: str) -> Optional[dict]:
        c = (code or "").strip().upper()
        return self.by_icao.get(c) or self.by_alias.get(c)

    def search(self, q: str, limit: int = SEARCH_LIMIT) -> list[dict]:
        """Exact ICAO, then exact alias (IATA, gps/local code), then ICAO prefix, then alias
        prefix, then a name/city word starting with q, then name/city containing q. Large
        airports before medium within a tier, then by ICAO."""
        q = " ".join((q or "").split())
        if not q:
            return []
        up, low = q.upper(), q.casefold()
        tiers: list[tuple[int, int, str, dict]] = []
        for a in self.airports:
            aliases = a.get("aliases") or ()
            text = f"{a.get('name') or ''} {a.get('city') or ''}".casefold()
            if a["icao"] == up:
                tier = 0
            elif up in aliases:
                tier = 1
            elif a["icao"].startswith(up):
                tier = 2
            elif any(x.startswith(up) for x in aliases):
                tier = 3
            elif any(w.startswith(low) for w in re.split(r"[\s/,()\-]+", text) if w):
                tier = 4
            elif low in text:
                tier = 5
            else:
                continue
            tiers.append((tier, TYPE_ORDER.get(a.get("type"), 9), a["icao"], a))
        tiers.sort(key=lambda t: t[:3])
        return [t[3] for t in tiers[:max(0, limit)]]


def load(path: Optional[str] = None) -> Optional[AirportDB]:
    """The dataset, or None when the file is missing or unreadable -- the Dash then stays off (one
    named refusal), never a startup failure: the race relay does not depend on it."""
    path = path or default_path()
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    db = AirportDB(data)
    return db if len(db) else None
