#!/usr/bin/env python3
"""Fly a course's gate route past a terrain model and report anything that doesn't clear it.

The three hand-authored Oregon courses (gorge-run, crater-rim, hood-circuit) were placed from
coordinates rather than flown, so their gates could easily sit inside a ridge — see README.md's
"Shared course status". This samples terrain height at every gate and along every leg between
them, and reports, per course, whether the route clears terrain by a margin.

STRICTLY READ-ONLY with respect to courses: it never writes race/courses/. The only file it
ever writes is the sample cache you ask for with --cache.

Usage:
    python race/tools/check_terrain.py                        # the three hand-authored courses
    python race/tools/check_terrain.py gorge-run crater-rim   # named courses
    python race/tools/check_terrain.py --all                  # every course in race/courses/
    python race/tools/check_terrain.py --cache terrain.json   # read-through sample cache
    python race/tools/check_terrain.py --source file --samples-file terrain.json   # offline
    python race/tools/check_terrain.py --json                 # machine-readable
    python race/tools/check_terrain.py --all --source global  # worldwide Terrarium tiles only
    python race/tools/check_terrain.py --approach --source global --cache t.json   # every runway
    python race/tools/check_terrain.py --approach vnlk-06 lflj-22 --source global  # named runways
    python race/tools/check_terrain.py --starts --source global --cache t.json     # every air start

Exit codes: 0 every course passed, 1 at least one course failed, 2 the check couldn't be
completed (no terrain data, network error, bad arguments).

Terrain sources (--source):

  usgs    USGS 3DEP point queries, epqs.nationalmap.gov. US-only, which covers all
          three Oregon courses, and at 1-10 m it is *finer* than what GeoFS renders. One HTTP
          request per sample, so it runs with a small thread pool and likes a --cache.

  cesium  Cesium World Terrain through Cesium ion (quantized-mesh), i.e. the actual terrain
          Cesium 1.96 draws. Needs CESIUM_ION_TOKEN in the environment.
          UNVERIFIED END TO END: api.cesium.com is not reachable from the machine this was
          written on, so the decoder below has only ever run against synthetic tiles built by
          race/test/test_check_terrain.py. If a real tile disagrees with it, prefer `usgs` and
          fix the decoder rather than trusting a surprising number.

  global  AWS Terrain Tiles (Terrarium PNG, s3.amazonaws.com/elevation-tiles-prod), worldwide.
          Decoded as h = R*256 + G + B/256 - 32768 at zoom 12 (~38 m/px at the equator, finer
          toward the poles), bilinear between pixel centres. Tiles are cached next to --cache
          (<cache>.tiles/z/x/y.png) so a re-run is offline. Stdlib-only PNG decoder.

  auto    (default) usgs inside the CONUS bounding box, global everywhere else. If USGS can't
          be reached at all (network blocked), CONUS points fall back to global and the source
          name says so — a fallback is reported, never silent.

  file    Read samples from a JSON file ({"lat,lon": height_m}) and never touch the network.
          Any sample the file is missing is an error, not a pass. This is what the tests use
          and what --cache writes.

What gets flagged, per sample point (clearance = path altitude - terrain height):

    BURIED    clearance < 0            the route is inside the ground
    CLIPPING  clearance < gate radius  (gates only) the gate sphere cuts into terrain, so part
                                       of it can't be flown through
    LOW       clearance < --margin     above ground, but with less room than you asked for

BURIED and CLIPPING fail a course. LOW fails too by default, since the margin is the whole point;
pass --warn-low to report it without failing.

--approach: the same check for landing runways (race/runways/*.json) instead of courses. It samples
the path the Landing tab spawns onto and the robot's APPROACH mode flies (race.js landingSpawn(): 3 nm
out on a 3 deg glidepath to 15 m over the threshold, or the runway's own `approach` override), every
--step metres (default 100) out to max(spawn distance, 5 nm), and reports the glidepath's clearance
over terrain. Only the flown part (threshold to spawn) can fail; terrain beyond the spawn is
reported for information. Inside short final (0.5 nm) the runway environment is reported but never
fails. The required clearance at each point is min(--margin, half the path's height above the
threshold there), with --margin defaulting to 60 m: the robot's TERRAIN rule, which a flat field's
3 deg path meets everywhere. The spawn point must clear 150 m (its SPAWN_LOW rule). For a FAIL it also prints the shallowest angle that would clear everything by the
margin, which is where a provisional `approach` override starts. It is a starting point, not a
substitute for flying the approach with the ROBOT bookmarklet.

--starts: where an air start actually puts people, which the gate/leg check never looked at. For
every air-start course it samples (every --step metres, default 100) the grid's straight-in line to
gate 1 out to pace x the longest lead preset (180 kt x 45 s), for all 12 grid slots at 80 m lateral
spacing, plus the rolling start's whole path (gate 1, the exit straight and one lap of the oval). It
reports the highest terrain on each and the clearance at the lowest spawn altitude (gate 1's, or the
course's `start.min_alt_m` floor; the oval at gate 1's, or the formation altitude race.js derives from
`start.corridor_terrain_max_m`). Below --margin (default 150 m) is a FAIL; design_course.py
--fix-starts writes the `start` block that fixes it. Ground-start courses are SKIP.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
COURSES_DIR = REPO_ROOT / "race" / "courses"
RUNWAYS_DIR = REPO_ROOT / "race" / "runways"

# The hand-placed, never-flown courses this exists for (README "Shared course status").
DEFAULT_COURSE_IDS = ["gorge-run", "crater-rim", "hood-circuit"]

# Same sphere race.js's destination()/Course.length() use, so distances here and in the client
# agree to the metre.
EARTH_R_M = 6371008.8

DEFAULT_STEP_M = 250.0
DEFAULT_MARGIN_M = 150.0
DEFAULT_WORKERS = 8
SAMPLE_KEY_DP = 6          # ~0.1 m at these latitudes; also the cache key precision

# --approach (race.js landingSpawn() / robot_pilot.js makeApproachFlight() defaults)
NM_M = 1852.0
APPROACH_STEP_M = 100.0
APPROACH_MIN_PROFILE_M = 5 * NM_M
APPROACH_DEFAULT_DIST_M = 5556.0
APPROACH_DEFAULT_DEG = 3.0
APPROACH_TCH_M = 15.0
APPROACH_SHORT_FINAL_M = 926.0
APPROACH_MARGIN_M = 60.0
APPROACH_SPAWN_MARGIN_M = 150.0
APPROACH_MAX_SUGGEST_DEG = 8.0

# --starts (race.js gridSlot() / FlyToStart / formationBuildTrack() / formationAltitudeM())
START_PACE_KT = 180.0          # CONFIG.PACE_KT and the relay's RACE_FORMATION_PACE_KT
START_MAX_LEAD_S = 45.0        # the longest CONFIG.COUNTDOWN_LEAD_PRESETS_S choice
START_SLOTS = 12               # RACE_ROOM_MAX_PILOTS: the widest grid
START_LATERAL_M = 80.0         # gridSlot()'s lateral stagger
START_VERTICAL_M = 30.0        # gridSlot()'s vertical stagger
START_MARGIN_M = 150.0
START_STEP_M = 100.0
FORMATION_SETBACK_M = 1500.0   # CONFIG.START_LINE_SETBACK_M
FORMATION_OVAL_LEG_M = 4000.0  # CONFIG.OVAL_LEG_M
FORMATION_TURN_DEG_S = 3.0     # CONFIG.OVAL_TURN_DEG_S
FORMATION_EXIT_S = 45.0        # CONFIG.FORMATION_EXIT_S
FORMATION_ALT_MARGIN_M = 150.0 # CONFIG.FORMATION_ALT_MARGIN_M
KT_MS = 0.514444

USGS_URL = "https://epqs.nationalmap.gov/v1/json"
ION_ENDPOINT = "https://api.cesium.com/v1/assets/1/endpoint"
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TERRARIUM_ZOOM = 12
# Contiguous US (lower 48) — where --source auto prefers USGS 3DEP.
CONUS_BBOX = {"lat_min": 24.4, "lat_max": 49.5, "lon_min": -125.0, "lon_max": -66.9}


class TerrainError(RuntimeError):
    """The check could not be completed (no data, network failure, unusable source)."""


class _NoData:
    """Sentinel meaning "the source has no elevation at this point" (out of coverage), as
    opposed to a transient failure. A course sample that resolves to this is reported as
    UNVERIFIED -- never as a PASS, and never by crashing the whole run."""

    def __repr__(self):
        return "NO_DATA"


NO_DATA = _NoData()


# --------------------------------------------------------------------------- geometry
def haversine_m(a, b):
    """Great-circle distance in metres between (lat, lon) pairs."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(h)))


def interpolate(a, b, frac):
    """Point `frac` of the way from a to b along the great circle (spherical lerp).

    Falls back to the endpoint for coincident points, where the interpolation is undefined."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    d = haversine_m(a, b) / EARTH_R_M
    if d < 1e-12:
        return (a[0], a[1])
    sd = math.sin(d)
    f1, f2 = math.sin((1 - frac) * d) / sd, math.sin(frac * d) / sd
    x = f1 * math.cos(lat1) * math.cos(lon1) + f2 * math.cos(lat2) * math.cos(lon2)
    y = f1 * math.cos(lat1) * math.sin(lon1) + f2 * math.cos(lat2) * math.sin(lon2)
    z = f1 * math.sin(lat1) + f2 * math.sin(lat2)
    return (math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x)))


def chord_sag_m(distance_m, frac):
    """How far below the two gates' altitude line a straight flight path actually runs.

    Gate altitudes are heights above the ellipsoid, but nobody flies an arc between gates —
    they fly a straight line, which cuts inside the sphere. Max sag is d^2/8R at the midpoint
    (~31 m over a 40 km leg, ~2 m over 10 km), scaled here by 4t(1-t) so it's zero at both
    gates. Including it keeps the check conservative: the sampled path is where the aircraft
    is, not where the gate-to-gate altitude interpolation says it is."""
    return (distance_m * distance_m / (8 * EARTH_R_M)) * 4 * frac * (1 - frac)


def route_samples(gates, step_m=DEFAULT_STEP_M):
    """Every point to check: each gate, plus interpolated points along each leg.

    Yields dicts with lat/lon/alt plus enough context for the report to say where a problem is.
    """
    out = []
    for i, g in enumerate(gates):
        out.append({"kind": "gate", "gate": i, "lat": g["lat"], "lon": g["lon"], "alt": g["alt"],
                    "radius": g["radius"], "leg": None, "along_m": 0.0})
    for i in range(len(gates) - 1):
        a, b = gates[i], gates[i + 1]
        d = haversine_m((a["lat"], a["lon"]), (b["lat"], b["lon"]))
        n = int(d // step_m)
        for k in range(1, n + 1):      # exclusive of both gates; they're covered above
            frac = (k * step_m) / d
            if frac >= 1.0:
                break
            lat, lon = interpolate((a["lat"], a["lon"]), (b["lat"], b["lon"]), frac)
            alt = a["alt"] + (b["alt"] - a["alt"]) * frac - chord_sag_m(d, frac)
            out.append({"kind": "leg", "gate": None, "lat": lat, "lon": lon, "alt": alt,
                        "radius": None, "leg": (i, i + 1), "along_m": k * step_m})
    return out


def destination(lat, lon, bearing_deg, dist_m):
    """(lat, lon) dist_m along bearing_deg from a point: race.js's destination(), same sphere."""
    dr, th = dist_m / EARTH_R_M, math.radians(bearing_deg)
    f1, l1 = math.radians(lat), math.radians(lon)
    f2 = math.asin(math.sin(f1) * math.cos(dr) + math.cos(f1) * math.sin(dr) * math.cos(th))
    l2 = l1 + math.atan2(math.sin(th) * math.sin(dr) * math.cos(f1), math.cos(dr) - math.sin(f1) * math.sin(f2))
    return math.degrees(f2), ((math.degrees(l2) + 540) % 360) - 180


def approach_geometry(runway):
    """Pure: the inbound path race.js's landingSpawn() puts a pilot on, from the runway's own
    `approach` override or the defaults. Returns (dist_m, angle_deg, offset_deg, alt_offset_m)."""
    ap = runway.get("approach") or {}
    dist_m = ap["distNm"] * NM_M if ap.get("distNm") else APPROACH_DEFAULT_DIST_M
    return (dist_m, ap.get("angleDeg") or APPROACH_DEFAULT_DEG, ap.get("headingOffsetDeg") or 0.0,
            ap.get("altOffsetM") or 0.0)


def approach_samples(runway, step_m=APPROACH_STEP_M):
    """Every point on the inbound glidepath, threshold outward, plus the spawn point itself."""
    dist_m, angle, offset, alt_off = approach_geometry(runway)
    back = (runway["heading_deg"] + offset + 180.0) % 360.0
    thr = runway["thr_alt_m"] + APPROACH_TCH_M
    tan_a = math.tan(math.radians(angle))
    out = []
    n = int(max(dist_m, APPROACH_MIN_PROFILE_M) // step_m)
    for k in range(1, n + 1):
        d = k * step_m
        lat, lon = destination(runway["thr_lat"], runway["thr_lon"], back, d)
        out.append({"kind": "path" if d <= dist_m else "beyond", "lat": lat, "lon": lon, "alt": thr + d * tan_a, "dist_m": d})
    lat, lon = destination(runway["thr_lat"], runway["thr_lon"], back, dist_m)
    out.append({"kind": "spawn", "lat": lat, "lon": lon, "alt": thr + dist_m * tan_a + alt_off, "dist_m": dist_m})
    return out


def required_clearance_m(dist_m, angle_deg, margin_m):
    """Pure: the clearance the glidepath must keep at dist_m: margin_m, or half the path's own height
    above the threshold when that is less (a flat field's 3 deg path is only ~67 m up at 0.54 nm).
    robot_pilot.js's makeApproachFlight() applies the same rule in flight."""
    return min(margin_m, 0.5 * (APPROACH_TCH_M + dist_m * math.tan(math.radians(angle_deg))))


def min_clearing_angle_deg(runway, points, margin_m):
    """Pure: the shallowest glidepath (to APPROACH_TCH_M over the threshold) that clears every
    (dist_m, terrain_m) point outside short final by margin_m, rounded up to 0.5 deg."""
    need = APPROACH_DEFAULT_DEG
    for d, terrain in points:
        if d > APPROACH_SHORT_FINAL_M:
            rise = terrain + margin_m - runway["thr_alt_m"] - APPROACH_TCH_M
            need = max(need, math.degrees(math.atan2(rise, d)))
    return math.ceil(need * 2) / 2


def check_approach(runway, source, step_m=APPROACH_STEP_M, margin_m=APPROACH_MARGIN_M, workers=DEFAULT_WORKERS):
    samples = approach_samples(runway, step_m)
    heights = source.heights([(s["lat"], s["lon"]) for s in samples], workers=workers)
    dist_m, angle, offset, _ = approach_geometry(runway)
    worst, worst_final, worst_beyond, spawn, unverified, points = None, None, None, None, 0, []
    findings = []
    for s in samples:
        t = heights.get(sample_key(s["lat"], s["lon"]))
        if t is None:
            raise TerrainError(f"no terrain height for {sample_key(s['lat'], s['lon'])}")
        if t is NO_DATA:
            unverified += 1
            continue
        c = {"clearance_m": s["alt"] - t, "terrain_m": t,
             "required_m": required_clearance_m(s["dist_m"], angle, margin_m), **s}
        c["short_m"] = c["required_m"] - c["clearance_m"]
        if s["kind"] == "spawn":
            spawn = c
            continue
        if s["kind"] == "beyond":
            if worst_beyond is None or c["short_m"] > worst_beyond["short_m"]:
                worst_beyond = c
            continue
        points.append((s["dist_m"], t))
        if s["dist_m"] <= APPROACH_SHORT_FINAL_M:
            if worst_final is None or c["clearance_m"] < worst_final["clearance_m"]:
                worst_final = c
            continue
        if worst is None or c["short_m"] > worst["short_m"]:
            worst = c
        if c["short_m"] > 0:
            findings.append(c)
    spawn_low = spawn is not None and spawn["clearance_m"] < APPROACH_SPAWN_MARGIN_M
    failed = bool(findings) or spawn_low
    status = "FAIL" if failed else ("UNVERIFIED" if unverified else "PASS")
    suggest = min_clearing_angle_deg(runway, points, margin_m) if failed else None
    return {"id": runway["id"], "name": runway.get("name", runway["id"]), "dist_nm": round(dist_m / NM_M, 2),
            "angle_deg": angle, "offset_deg": offset, "samples": len(samples), "findings": findings,
            "worst": worst, "worst_short_final": worst_final, "worst_beyond_spawn": worst_beyond,
            "spawn": spawn, "spawn_low": spawn_low,
            "unverified": unverified, "status": status, "passed": status == "PASS",
            "suggest_angle_deg": suggest,
            "custom_path_needed": suggest is not None and suggest > APPROACH_MAX_SUGGEST_DEG}


def load_runway(runway_id):
    path = RUNWAYS_DIR / f"{runway_id}.json"
    if not path.exists():
        raise TerrainError(f"no such runway: {path.relative_to(REPO_ROOT)}")
    rw = json.loads(path.read_text(encoding="utf-8"))
    for k in ("thr_lat", "thr_lon", "thr_alt_m", "heading_deg"):
        if not isinstance(rw.get(k), (int, float)):
            raise TerrainError(f"{runway_id}: no numeric {k}")
    return rw


def all_runway_ids():
    return sorted(p.stem for p in RUNWAYS_DIR.glob("*.json") if p.name != "index.json")


def describe_approach(r):
    def at(c):
        return f"{c['clearance_m']:7.1f} m at {c['dist_m'] / NM_M:.2f} nm (terrain {c['terrain_m']:.0f} m)"
    lines = [f"{r['id']}  {r['name']}",
             f"  {r['angle_deg']:g} deg from {r['dist_nm']:g} nm" + (f", inbound swung {r['offset_deg']:+g} deg" if r["offset_deg"] else "")]
    if r["worst"]:
        lines.append(f"  tightest point on the flown path:    {at(r['worst'])}, needs {r['worst']['required_m']:.0f} m")
    if r["worst_short_final"]:
        lines.append(f"  inside 0.5 nm (not failed):          {at(r['worst_short_final'])}")
    if r["worst_beyond_spawn"] and r["worst_beyond_spawn"]["short_m"] > 0:
        lines.append(f"  beyond the spawn (not flown):        {at(r['worst_beyond_spawn'])}")
    if r["spawn"]:
        lines.append(f"  spawn clearance: {r['spawn']['clearance_m']:.1f} m" + ("  SPAWN_LOW" if r["spawn_low"] else ""))
    tail = f"  {r['status']}"
    if r["suggest_angle_deg"] is not None:
        tail += f"  - a {r['suggest_angle_deg']:g} deg path clears it"
        if r["custom_path_needed"]:
            tail += f" (past {APPROACH_MAX_SUGGEST_DEG:g} deg: needs a custom path, e.g. headingOffsetDeg down the valley)"
    lines.append(tail)
    return "\n".join(lines)


# --------------------------------------------------------------------------- terrain sources
def sample_key(lat, lon):
    return f"{round(lat, SAMPLE_KEY_DP)},{round(lon, SAMPLE_KEY_DP)}"


class FileSource:
    """Samples from a JSON table. Never touches the network; a miss is an error, not a pass."""

    name = "file"

    def __init__(self, path):
        p = Path(path)
        if not p.exists():
            raise TerrainError(f"--samples-file {path} does not exist")
        try:
            self.table = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise TerrainError(f"--samples-file {path} is not valid JSON: {e}")
        if not isinstance(self.table, dict):
            raise TerrainError(f"--samples-file {path} must be an object of \"lat,lon\": height")

    def heights(self, points, workers=1):
        out = {}
        missing = []
        for lat, lon in points:
            k = sample_key(lat, lon)
            if k not in self.table:
                missing.append(k)
            elif self.table[k] is None:
                out[k] = NO_DATA  # an explicit JSON null means "no coverage here", not missing
            else:
                out[k] = float(self.table[k])
        if missing:
            raise TerrainError(
                f"{len(missing)} sample(s) missing from the samples file (first: {missing[0]}). "
                "Build one with --cache against a live source, or widen --step so the points line up.")
        return out


class UsgsSource:
    """USGS 3DEP point queries. One request per point, so it fans out over a thread pool.

    Out-of-coverage points come back as HTTP 200 with a **non-JSON** body -- observed live:
    "Call failed. [Failed cloud operation: ...]", "Invalid or missing input parameters.",
    "The operation was attempted on an empty geometry." (the wording varies with *why* the
    point misses -- open ocean vs. off the raster entirely -- so none of it is matched
    specifically). A point can also come back as valid JSON with `value` null, or, per USGS's
    own docs, a large-magnitude negative sentinel (e.g. -1000000) standing in for no-data.
    All three are the source saying "no coverage here", not a broken request, so they resolve
    to NO_DATA rather than raising -- a course sample that lands on one is reported as
    UNVERIFIED, never a silent PASS. An actual network/timeout failure is kept as a hard error:
    that means the check itself couldn't run, not that the point lacks data."""

    name = "usgs"
    NO_DATA_VALUE_THRESHOLD = -1.0e5  # comfortably below any real elevation on Earth

    def __init__(self, timeout=20.0):
        self.timeout = timeout

    def _one(self, point):
        lat, lon = point
        url = f"{USGS_URL}?x={lon}&y={lat}&units=Meters&wkid=4326&includeDate=false"
        req = urllib.request.Request(url, headers={"User-Agent": "finsonly-racing-terrain-check"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = r.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return sample_key(lat, lon), None, f"{type(e).__name__}: {e}"
        try:
            value = json.loads(body).get("value")
            if value is None:
                return sample_key(lat, lon), NO_DATA, None
            f = float(value)
        except (json.JSONDecodeError, TypeError, ValueError):
            # Out-of-coverage response, not a broken one -- see the class docstring.
            return sample_key(lat, lon), NO_DATA, None
        if f <= self.NO_DATA_VALUE_THRESHOLD:
            return sample_key(lat, lon), NO_DATA, None
        return sample_key(lat, lon), f, None

    def heights(self, points, workers=DEFAULT_WORKERS):
        out, errors = {}, []
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            for key, value, err in pool.map(self._one, points):
                if err:
                    errors.append(err)
                else:
                    out[key] = value
        if errors:
            raise TerrainError(f"{len(errors)} sample(s) could not be read. First: {errors[0]}")
        return out


# ---- Cesium World Terrain (quantized-mesh). See the module docstring: this path has never run
# against a real tile. The format is the published quantized-mesh 1.0 layout:
#   88-byte header (center xyz doubles, min/max height floats, bounding sphere, horizon point),
#   uint32 vertexCount, then zigzag-delta-encoded u[], v[], height[] as uint16,
#   then uint32 triangleCount and high-water-mark-encoded indices.
QM_HEADER_BYTES = 88
QM_MAX = 32767.0


def _zigzag_decode(values):
    out, prev = [], 0
    for v in values:
        prev = (prev + ((v >> 1) ^ (-(v & 1)))) & 0xFFFF
        out.append(prev)
    return out


def decode_quantized_mesh(data):
    """Decode a quantized-mesh tile into (min_h, max_h, us, vs, heights, triangles)."""
    import struct

    if len(data) < QM_HEADER_BYTES + 4:
        raise TerrainError("quantized-mesh tile is too short to be valid")
    min_h, max_h = struct.unpack_from("<ff", data, 24)
    off = QM_HEADER_BYTES
    (vertex_count,) = struct.unpack_from("<I", data, off)
    off += 4
    need = vertex_count * 2
    us = _zigzag_decode(struct.unpack_from(f"<{vertex_count}H", data, off))
    off += need
    vs = _zigzag_decode(struct.unpack_from(f"<{vertex_count}H", data, off))
    off += need
    hs = _zigzag_decode(struct.unpack_from(f"<{vertex_count}H", data, off))
    off += need

    wide = vertex_count > 65536
    isize = 4 if wide else 2
    if off % isize:
        off += isize - (off % isize)          # index data is aligned to its own width
    (triangle_count,) = struct.unpack_from("<I", data, off)
    off += 4
    raw = struct.unpack_from(f"<{triangle_count * 3}{'I' if wide else 'H'}", data, off)
    # High-water-mark encoding: each stored value is a backwards delta from the highest index
    # used so far.
    indices, highest = [], 0
    for code in raw:
        indices.append(highest - code)
        if code == 0:
            highest += 1
    triangles = [tuple(indices[i:i + 3]) for i in range(0, len(indices), 3)]
    return min_h, max_h, us, vs, hs, triangles


def height_in_tile(u, v, decoded):
    """Barycentric height at tile coordinates u,v (both 0..32767), or None if outside every
    triangle (which happens on the tile edge and means "ask the neighbouring tile")."""
    min_h, max_h, us, vs, hs, triangles = decoded
    for (i0, i1, i2) in triangles:
        x0, y0, x1, y1, x2, y2 = us[i0], vs[i0], us[i1], vs[i1], us[i2], vs[i2]
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if den == 0:
            continue
        l0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / den
        l1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / den
        l2 = 1.0 - l0 - l1
        if l0 < -1e-9 or l1 < -1e-9 or l2 < -1e-9:
            continue
        q = l0 * hs[i0] + l1 * hs[i1] + l2 * hs[i2]
        return min_h + (max_h - min_h) * (q / QM_MAX)
    return None


def tile_xy(lat, lon, level):
    """Cesium's GeographicTilingScheme: 2x1 tiles at level 0, y counted from the north."""
    n = 2 ** level
    x = int((lon + 180.0) / 360.0 * 2 * n)
    y = int((90.0 - lat) / 180.0 * n)
    return min(max(x, 0), 2 * n - 1), min(max(y, 0), n - 1)


def tile_uv(lat, lon, level, x, y):
    n = 2 ** level
    tile_w, tile_h = 360.0 / (2 * n), 180.0 / n
    west, north = -180.0 + x * tile_w, 90.0 - y * tile_h
    u = (lon - west) / tile_w * QM_MAX
    v = (1.0 - (north - lat) / tile_h) * QM_MAX      # v runs south -> north
    return u, v


class CesiumSource:
    """Cesium World Terrain via ion. Unverified against a live tile — see the module docstring."""

    name = "cesium"

    def __init__(self, token=None, level=11, timeout=30.0):
        self.token = token or os.environ.get("CESIUM_ION_TOKEN") or ""
        if not self.token:
            raise TerrainError("--source cesium needs CESIUM_ION_TOKEN in the environment "
                               "(or use the default --source usgs)")
        self.level = level
        self.timeout = timeout
        self._tiles = {}
        self._url = None
        self._access = None

    def _endpoint(self):
        if self._url:
            return
        req = urllib.request.Request(f"{ION_ENDPOINT}?access_token={self.token}",
                                     headers={"User-Agent": "finsonly-racing-terrain-check"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = json.loads(r.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
            raise TerrainError(f"could not reach Cesium ion ({type(e).__name__}: {e}). "
                               "api.cesium.com is blocked on some networks; --source usgs needs no token.")
        self._url = str(body.get("url") or "").rstrip("/")
        self._access = body.get("accessToken") or self.token
        if not self._url:
            raise TerrainError(f"Cesium ion returned no tileset url: {str(body)[:120]}")

    def _tile(self, level, x, y):
        key = (level, x, y)
        if key in self._tiles:
            return self._tiles[key]
        self._endpoint()
        url = f"{self._url}/{level}/{x}/{y}.terrain?extensions=octvertexnormals-watermask&v=1.2.0"
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.quantized-mesh;extensions=octvertexnormals-watermask,application/octet-stream;q=0.9",
            "Authorization": f"Bearer {self._access}",
            "User-Agent": "finsonly-racing-terrain-check",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                decoded = decode_quantized_mesh(r.read())
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise TerrainError(f"tile {level}/{x}/{y} failed ({type(e).__name__}: {e})")
        self._tiles[key] = decoded
        return decoded

    def heights(self, points, workers=DEFAULT_WORKERS):
        out = {}
        for lat, lon in points:
            for level in (self.level, self.level - 1, self.level - 2):
                if level < 0:
                    break
                x, y = tile_xy(lat, lon, level)
                u, v = tile_uv(lat, lon, level, x, y)
                h = height_in_tile(u, v, self._tile(level, x, y))
                if h is not None:
                    out[sample_key(lat, lon)] = h
                    break
            else:
                raise TerrainError(f"no triangle covered {lat},{lon} at levels "
                                   f"{self.level}..{self.level - 2}")
        return out


# ---- AWS Terrain Tiles, Terrarium encoding. Web-Mercator slippy tiles, 256x256 RGB PNG.
def decode_png_rgb(data):
    """Minimal PNG decoder (stdlib only): 8-bit RGB or RGBA, non-interlaced -> list of rows of
    (r, g, b) tuples. Enough for Terrarium tiles; anything else raises TerrainError."""
    import struct
    import zlib

    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise TerrainError("not a PNG")
    off, idat, width = 8, [], None
    while off < len(data):
        (length,) = struct.unpack_from(">I", data, off)
        ctype = data[off + 4:off + 8]
        body = data[off + 8:off + 8 + length]
        off += 12 + length
        if ctype == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or color not in (2, 6) or interlace:
                raise TerrainError(f"unsupported PNG (depth {depth}, colour type {color}, interlace {interlace})")
            bpp = 3 if color == 2 else 4
        elif ctype == b"IDAT":
            idat.append(body)
        elif ctype == b"IEND":
            break
    if width is None:
        raise TerrainError("PNG has no IHDR")
    raw = zlib.decompress(b"".join(idat))
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    pos = 0
    for _ in range(height):
        ftype = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        if ftype == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif ftype != 0:
            raise TerrainError(f"bad PNG filter type {ftype}")
        rows.append([tuple(line[i:i + 3]) for i in range(0, stride, bpp)])
        prev = line
    return rows


def terrarium_height(rgb):
    r, g, b = rgb
    return r * 256.0 + g + b / 256.0 - 32768.0


def mercator_pixel(lat, lon, zoom):
    """Global Web-Mercator pixel coordinates (256 px tiles) of lat/lon at `zoom`."""
    n = 256 * 2 ** zoom
    lat = max(min(lat, 85.05112878), -85.05112878)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


class TerrariumSource:
    """Worldwide elevation from AWS Terrain Tiles (Terrarium PNG), bilinear at `zoom`.

    `fetch(z, x, y) -> bytes` is injectable (the tests pass a fixture tile); by default tiles are
    downloaded from TERRARIUM_URL and, if `tile_dir` is set, cached there as z/x/y.png."""

    name = "global"

    def __init__(self, zoom=TERRARIUM_ZOOM, tile_dir=None, fetch=None, timeout=30.0):
        self.zoom = zoom
        self.tile_dir = Path(tile_dir) if tile_dir else None
        self.timeout = timeout
        self._fetch = fetch or self._download
        self._tiles = {}

    def _download(self, z, x, y):
        if self.tile_dir:
            p = self.tile_dir / str(z) / str(x) / f"{y}.png"
            if p.exists():
                return p.read_bytes()
        url = TERRARIUM_URL.format(z=z, x=x, y=y)
        req = urllib.request.Request(url, headers={"User-Agent": "finsonly-racing-terrain-check"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = r.read()
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise TerrainError(f"terrarium tile {z}/{x}/{y} failed ({type(e).__name__}: {e})")
        if self.tile_dir:
            p = self.tile_dir / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        return data

    def _tile(self, x, y):
        key = (self.zoom, x, y)
        if key not in self._tiles:
            self._tiles[key] = decode_png_rgb(self._fetch(self.zoom, x, y))
        return self._tiles[key]

    def _pixel(self, gx, gy):
        n = 256 * 2 ** self.zoom
        gx %= n
        gy = min(max(gy, 0), n - 1)
        rows = self._tile(gx // 256, gy // 256)
        return terrarium_height(rows[gy % 256][gx % 256])

    def height(self, lat, lon):
        px, py = mercator_pixel(lat, lon, self.zoom)
        fx, fy = px - 0.5, py - 0.5          # pixel centres sit at .5
        x0, y0 = math.floor(fx), math.floor(fy)
        tx, ty = fx - x0, fy - y0
        h00, h10 = self._pixel(x0, y0), self._pixel(x0 + 1, y0)
        h01, h11 = self._pixel(x0, y0 + 1), self._pixel(x0 + 1, y0 + 1)
        return (h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty)
                + h01 * (1 - tx) * ty + h11 * tx * ty)

    def heights(self, points, workers=DEFAULT_WORKERS):
        return {sample_key(lat, lon): self.height(lat, lon) for lat, lon in points}


def in_conus(lat, lon):
    b = CONUS_BBOX
    return b["lat_min"] <= lat <= b["lat_max"] and b["lon_min"] <= lon <= b["lon_max"]


class AutoSource:
    """USGS 3DEP inside CONUS, Terrarium everywhere else. If USGS can't be reached at all, the
    CONUS points fall back to Terrarium and `name` records the fallback."""

    def __init__(self, usgs, global_source):
        self.usgs = usgs
        self.glob = global_source
        self.fell_back = False
        self.used = set()

    @property
    def name(self):
        label = "auto(" + "+".join(sorted(self.used)) + ")" if self.used else "auto"
        return label + (" [USGS unreachable: CONUS fell back to global]" if self.fell_back else "")

    def heights(self, points, workers=DEFAULT_WORKERS):
        conus = [p for p in points if in_conus(*p)]
        rest = [p for p in points if not in_conus(*p)]
        out = {}
        if conus and not self.fell_back:
            try:
                out.update(self.usgs.heights(conus, workers=workers))
                self.used.add("usgs")
            except TerrainError:
                self.fell_back = True
        if conus and self.fell_back:
            out.update(self.glob.heights(conus, workers=workers))
            self.used.add("global")
        if rest:
            out.update(self.glob.heights(rest, workers=workers))
            self.used.add("global")
        return out


class CachedSource:
    """Read-through cache around another source: fetch only what the cache is missing."""

    def __init__(self, inner, path):
        self.inner = inner
        self.path = Path(path)
        self.table = {}
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.table = {k: (NO_DATA if v is None else float(v)) for k, v in loaded.items()}
            except (json.JSONDecodeError, TypeError, ValueError):
                pass   # a corrupt cache is a cache miss, never a failure
        self.hits = 0
        self.fetched = 0

    @property
    def name(self):
        return f"{self.inner.name} (cached in {self.path})"

    def heights(self, points, workers=DEFAULT_WORKERS):
        out, todo = {}, []
        for lat, lon in points:
            k = sample_key(lat, lon)
            if k in self.table:
                out[k] = self.table[k]
                self.hits += 1
            else:
                todo.append((lat, lon))
        if todo:
            fresh = self.inner.heights(todo, workers=workers)
            self.fetched += len(fresh)
            out.update(fresh)
            self.table.update(fresh)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            serializable = {k: (None if v is NO_DATA else v) for k, v in self.table.items()}
            self.path.write_text(json.dumps(serializable, indent=0, sort_keys=True) + "\n", encoding="utf-8")
        return out


# --------------------------------------------------------------------------- --starts
def initial_bearing(a, b):
    """Initial great-circle bearing a -> b in degrees, (lat, lon) pairs: race.js's bearingDeg()."""
    f1, f2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(f2)
    x = math.cos(f1) * math.sin(f2) - math.sin(f1) * math.cos(f2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def start_corridor_samples(gate1, inbound_deg, dist_m, slots=START_SLOTS, lateral_m=START_LATERAL_M,
                           step_m=START_STEP_M):
    """Pure: every point of the grid's straight-in approach to gate 1, flown on `inbound_deg`.

    One line per grid slot (race.js gridSlot(): lateral offset (i - (n-1)/2) * lateral_m, 90 deg
    right of the inbound heading for positive offsets), each sampled every step_m from gate 1 out to
    dist_m (pace x the longest lead) behind it, spawn point included."""
    back = (inbound_deg + 180.0) % 360.0
    n = max(1, int(slots))
    center = (n - 1) / 2.0
    k_max = int(math.ceil(dist_m / step_m)) if dist_m > 0 else 0
    out = []
    for k in range(k_max + 1):
        d = min(k * step_m, dist_m)
        base = destination(gate1["lat"], gate1["lon"], back, d)
        for i in range(n):
            lateral = (i - center) * lateral_m
            perp = (inbound_deg + (90.0 if lateral >= 0 else -90.0)) % 360.0
            lat, lon = destination(base[0], base[1], perp, abs(lateral)) if lateral else base
            out.append({"kind": "corridor", "slot": i, "along_m": d, "lat": lat, "lon": lon})
    return out


def formation_local_to_latlon(origin, brg_deg, a, b):
    """race.js formationLocalToLatLon(): (a along brg, b 90 deg right of it) metres -> (lat, lon)."""
    r = math.radians(brg_deg)
    east = a * math.sin(r) + b * math.cos(r)
    north = a * math.cos(r) - b * math.sin(r)
    dist = math.hypot(east, north)
    if dist < 1e-9:
        return origin
    return destination(origin[0], origin[1], (math.degrees(math.atan2(east, north)) + 360) % 360, dist)


def formation_track(gate1, gate2, pace_ms):
    """race.js formationBuildTrack(), same defaults."""
    brg = initial_bearing((gate1["lat"], gate1["lon"]), (gate2["lat"], gate2["lon"]))
    origin = destination(gate1["lat"], gate1["lon"], (brg + 180) % 360, FORMATION_SETBACK_M)
    radius = max(1.0, pace_ms / math.radians(FORMATION_TURN_DEG_S))
    turn_len = math.pi * radius
    return {"brg": brg, "origin": origin, "legLen": FORMATION_OVAL_LEG_M, "radius": radius, "turnLen": turn_len,
            "approachLen": pace_ms * FORMATION_EXIT_S, "lapLen": 2 * FORMATION_OVAL_LEG_M + 2 * turn_len}


def formation_local_at(t, s):
    """race.js formationLocalAt(): (a, b) at arc length s behind the start line."""
    leg, r, turn, appr, lap = t["legLen"], t["radius"], t["turnLen"], t["approachLen"], t["lapLen"]
    if s <= appr:
        return -s, 0.0
    r2 = (s - appr) % lap
    a_in1 = -appr - leg
    if r2 < leg:
        return a_in1 + (leg - r2), 0.0
    if r2 < leg + turn:
        ang = math.pi / 2 + (r2 - leg) / r
        return a_in1 + r * math.cos(ang), -r + r * math.sin(ang)
    if r2 < 2 * leg + turn:
        return a_in1 + (r2 - leg - turn), -2 * r
    ang = -math.pi / 2 - (r2 - 2 * leg - turn) / r
    return a_in1 + leg + r * math.cos(ang), -r + r * math.sin(ang)


def formation_samples(gate1, gate2, pace_ms, step_m=START_STEP_M):
    """Pure: the rolling start's whole path, gate 1 back through the exit straight and one full lap
    of the oval. The slots all fly this one path (up to 12 x 3 pace-seconds apart), so a lap covers
    every slot at the room's maximum size."""
    t = formation_track(gate1, gate2, pace_ms)
    s, end, out = -FORMATION_SETBACK_M, t["approachLen"] + t["lapLen"], []
    while s <= end + 1e-6:
        a, b = formation_local_at(t, s)
        lat, lon = formation_local_to_latlon(t["origin"], t["brg"], a, b)
        out.append({"kind": "oval", "s_m": s, "lat": lat, "lon": lon})
        s += step_m
    return out


def formation_altitude_m(gate1_alt, terrain_max_m):
    """race.js formationAltitudeM() with a sampler that returns terrain_max_m everywhere."""
    floor = terrain_max_m + 300.0 if terrain_max_m is not None else gate1_alt
    return max(gate1_alt, floor) + FORMATION_ALT_MARGIN_M


def _max_terrain(points, heights):
    """(highest terrain, the point it is at, count of NO_DATA points)."""
    top, at, missing = None, None, 0
    for p in points:
        t = heights[sample_key(p["lat"], p["lon"])]
        if t is NO_DATA:
            missing += 1
        elif top is None or t > top:
            top, at = t, p
    return top, at, missing


def check_starts(course, source, pace_kt=START_PACE_KT, lead_s=START_MAX_LEAD_S, slots=START_SLOTS,
                 margin_m=START_MARGIN_M, step_m=START_STEP_M, workers=DEFAULT_WORKERS, course_hash=None):
    """Where an air start actually puts people: the grid's approach corridor (all slots, longest
    lead) and the formation oval. Clearance is measured at the altitude the LOWEST slot spawns at —
    gate 1's altitude, or the course's `start.min_alt_m` floor — and the oval at gate 1's altitude,
    or the formation altitude race.js derives from `start.corridor_terrain_max_m`. Ground-start
    courses never air-start, so they are SKIP."""
    base = {"id": course["id"], "name": course["name"], "start_type": course.get("startType") or "ground",
            "has_start": bool(course.get("start"))}
    if base["start_type"] != "air":
        return {**base, "status": "SKIP", "passed": True, "min_clearance_m": None}
    g1, g2 = course["gates"][0], course["gates"][1]
    start = course.get("start") or None
    default_inbound = initial_bearing((g1["lat"], g1["lon"]), (g2["lat"], g2["lon"]))
    inbound = float(start["bearing_deg"]) if start else default_inbound
    pace_ms = pace_kt * KT_MS
    corridor = start_corridor_samples(g1, inbound, pace_ms * lead_s, slots, START_LATERAL_M, step_m)
    oval = formation_samples(g1, g2, pace_ms, step_m)
    heights = source.heights([(p["lat"], p["lon"]) for p in corridor + oval], workers=workers)
    c_top, c_at, c_miss = _max_terrain(corridor, heights)
    o_top, o_at, o_miss = _max_terrain(oval, heights)
    floor = start.get("min_alt_m") if start else None
    spawn_alt = max(g1["alt"], floor) if floor is not None else g1["alt"]
    oval_alt = formation_altitude_m(g1["alt"], start.get("corridor_terrain_max_m")) if start else g1["alt"]
    c_clear = spawn_alt - c_top if c_top is not None else None
    o_clear = oval_alt - o_top if o_top is not None else None
    clears = [c for c in (c_clear, o_clear) if c is not None]
    min_clear = min(clears) if clears else None
    if min_clear is not None and min_clear < margin_m:
        status = "FAIL"
    elif c_miss or o_miss or min_clear is None:
        status = "UNVERIFIED"
    else:
        status = "PASS"
    stale = None
    if start and course_hash:
        checked = (start.get("checked_with") or {}).get("course_hash")
        stale = checked is not None and checked != course_hash
    return {**base, "status": status, "passed": status == "PASS",
            "inbound_deg": round(inbound, 1), "default_inbound_deg": round(default_inbound, 1),
            "gate1_alt_m": g1["alt"], "spawn_alt_m": spawn_alt, "oval_alt_m": oval_alt,
            "corridor_terrain_max_m": c_top, "corridor_clearance_m": c_clear,
            "corridor_worst": c_at, "oval_terrain_max_m": o_top, "oval_clearance_m": o_clear, "oval_worst": o_at,
            "min_clearance_m": min_clear, "unverified": c_miss + o_miss, "stale_start": stale,
            "corridor_samples": len(corridor), "oval_samples": len(oval)}


def describe_starts(r):
    if r["status"] == "SKIP":
        return f"  SKIP        {r['id']:<34} ground start"
    f = lambda v: "   n/a" if v is None else f"{v:6.0f}"  # noqa: E731
    note = " (start block)" if r["has_start"] else ""
    if r.get("stale_start"):
        note += " STALE: course geometry changed since --fix-starts"
    return (f"  {r['status']:<10}  {r['id']:<34} min {f(r['min_clearance_m'])} m | "
            f"corridor {r['inbound_deg']:5.1f} deg terrain {f(r['corridor_terrain_max_m'])} clear {f(r['corridor_clearance_m'])} | "
            f"oval terrain {f(r['oval_terrain_max_m'])} clear {f(r['oval_clearance_m'])}{note}")


def main_starts(args, ids):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import add_course  # the canonical course_hash(), for the stale-start check
    try:
        source = make_source(args)
        reports = []
        for cid in ids:
            course = load_course(cid)
            reports.append(check_starts(course, source, step_m=args.step, margin_m=args.margin, workers=args.workers,
                                        course_hash=add_course.course_hash(course)))
    except TerrainError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"source": source.name, "step_m": args.step, "margin_m": args.margin, "pace_kt": START_PACE_KT,
                          "lead_s": START_MAX_LEAD_S, "slots": START_SLOTS, "courses": reports}, indent=2, default=str))
    else:
        print(f"Start corridor check - source {source.name}, step {args.step:g} m, margin {args.margin:g} m, "
              f"{START_SLOTS} slots x {START_LATERAL_M:g} m, {START_PACE_KT:g} kt x {START_MAX_LEAD_S:g} s lead")
        for r in reports:
            print(describe_starts(r))
        failed = [r["id"] for r in reports if r["status"] == "FAIL"]
        checked = [r for r in reports if r["status"] != "SKIP"]
        print(f"\n{len(checked) - len(failed)}/{len(checked)} air starts clear"
              + (f" - failed: {', '.join(failed)}" if failed else ""))
    return 1 if any(not r["passed"] for r in reports) else 0


def tile_dir_for(cache):
    """Where Terrarium tiles are cached for a given --cache sample file (None = no tile cache)."""
    if not cache:
        return None
    p = Path(cache)
    return p.with_name(p.stem + ".tiles")


def make_source(args):
    if args.source == "file":
        if not args.samples_file:
            raise TerrainError("--source file needs --samples-file PATH")
        return FileSource(args.samples_file)
    tiles = tile_dir_for(args.cache)
    if args.source == "cesium":
        inner = CesiumSource(level=args.cesium_level)
    elif args.source == "global":
        inner = TerrariumSource(zoom=args.zoom, tile_dir=tiles)
    elif args.source == "auto":
        inner = AutoSource(UsgsSource(), TerrariumSource(zoom=args.zoom, tile_dir=tiles))
    else:
        inner = UsgsSource()
    return CachedSource(inner, args.cache) if args.cache else inner


# --------------------------------------------------------------------------- the check
def classify(sample, terrain_m, margin_m, warn_low=False):
    """Turn one sampled point into a finding, or None when it's fine.

    `terrain_m` being NO_DATA (the source has no coverage there) always produces a finding --
    UNVERIFIED, never a silent pass -- and it never fails the course by itself; a course with
    real data everywhere else still passes, it just can't vouch for the unverified point."""
    if terrain_m is NO_DATA:
        return {"level": "UNVERIFIED", "fails": False, "unverified": True,
                "clearance_m": None, "terrain_m": None, **sample}
    clearance = sample["alt"] - terrain_m
    if clearance < 0:
        level = "BURIED"
    elif sample["kind"] == "gate" and clearance < sample["radius"]:
        level = "CLIPPING"
    elif clearance < margin_m:
        level = "LOW"
    else:
        return None
    return {"level": level, "fails": level != "LOW" or not warn_low, "unverified": False,
            "clearance_m": clearance, "terrain_m": terrain_m, **sample}


def describe(f):
    where = (f"gate {f['gate'] + 1}" if f["kind"] == "gate"
             else f"leg {f['leg'][0] + 1}->{f['leg'][1] + 1} at {f['along_m'] / 1000:.1f} km")
    if f.get("unverified"):
        return f"{f['level']:<8} {where:<22} {f['lat']:.5f},{f['lon']:.5f}  no terrain data at this source"
    return (f"{f['level']:<8} {where:<22} {f['lat']:.5f},{f['lon']:.5f}  "
            f"alt {f['alt']:7.1f} m  terrain {f['terrain_m']:7.1f} m  clearance {f['clearance_m']:7.1f} m")


def check_course(course, source, step_m=DEFAULT_STEP_M, margin_m=DEFAULT_MARGIN_M,
                 workers=DEFAULT_WORKERS, warn_low=False):
    gates = course["gates"]
    samples = route_samples(gates, step_m)
    heights = source.heights([(s["lat"], s["lon"]) for s in samples], workers=workers)

    findings, worst = [], None
    unverified_count = 0
    for s in samples:
        key = sample_key(s["lat"], s["lon"])
        if key not in heights:
            raise TerrainError(f"no terrain height for {key}")
        t = heights[key]
        f = classify(s, t, margin_m, warn_low)
        if f:
            findings.append(f)
        if t is NO_DATA:
            unverified_count += 1
            continue
        clearance = s["alt"] - t
        if worst is None or clearance < worst["clearance_m"]:
            worst = {"clearance_m": clearance, "terrain_m": t, **s}

    length_m = sum(haversine_m((gates[i]["lat"], gates[i]["lon"]), (gates[i + 1]["lat"], gates[i + 1]["lon"]))
                   for i in range(len(gates) - 1))
    has_failure = any(f["fails"] for f in findings)
    status = "FAIL" if has_failure else ("UNVERIFIED" if unverified_count else "PASS")
    return {
        "id": course["id"], "name": course["name"], "gates": len(gates),
        "length_m": length_m, "samples": len(samples),
        "findings": findings, "worst": worst,
        "status": status, "unverified": unverified_count,
        "passed": status == "PASS",
    }


def load_course(course_id):
    path = COURSES_DIR / f"{course_id}.json"
    if not path.exists():
        raise TerrainError(f"no such course: {path.relative_to(REPO_ROOT)}")
    course = json.loads(path.read_text(encoding="utf-8"))
    gates = course.get("gates")
    if not isinstance(gates, list) or len(gates) < 2:
        raise TerrainError(f"{course_id}: needs at least 2 gates")
    for i, g in enumerate(gates):
        for k in ("lat", "lon", "alt"):
            if not isinstance(g.get(k), (int, float)):
                raise TerrainError(f"{course_id}: gate {i} has no numeric {k}")
        g.setdefault("radius", DEFAULT_MARGIN_M)
    course.setdefault("id", course_id)
    course.setdefault("name", course_id)
    return course


def all_course_ids():
    return sorted(p.stem for p in COURSES_DIR.glob("*.json") if p.name != "index.json")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("courses", nargs="*", help=f"Course ids (runway ids with --approach). Default: {' '.join(DEFAULT_COURSE_IDS)}")
    ap.add_argument("--all", action="store_true", help="Check every course in race/courses/.")
    ap.add_argument("--approach", action="store_true",
                    help="Check landing runways' approach glidepaths instead of courses (no ids = every runway).")
    ap.add_argument("--starts", action="store_true",
                    help="Check every air-start course's grid approach corridor and formation oval (no ids = every course).")
    ap.add_argument("--source", choices=["auto", "usgs", "global", "cesium", "file"], default="auto")
    ap.add_argument("--zoom", type=int, default=TERRARIUM_ZOOM, help="Terrarium zoom for --source global/auto.")
    ap.add_argument("--samples-file", help="JSON table of samples for --source file.")
    ap.add_argument("--cache", help="Read-through sample cache (the only file this tool writes).")
    ap.add_argument("--step", type=float, default=None,
                    help=f"Sample spacing along each leg, metres (default {DEFAULT_STEP_M:g}; {APPROACH_STEP_M:g} with --approach).")
    ap.add_argument("--margin", type=float, default=None,
                    help=f"Required clearance, metres (default {DEFAULT_MARGIN_M:g}; {APPROACH_MARGIN_M:g} with --approach).")
    ap.add_argument("--warn-low", action="store_true", help="Report LOW without failing the course.")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Parallel sample requests.")
    ap.add_argument("--cesium-level", type=int, default=11, help="Terrain tile level for --source cesium.")
    ap.add_argument("--max-findings", type=int, default=12, help="Findings listed per course (0 = all).")
    ap.add_argument("--json", action="store_true", help="Machine-readable report on stdout.")
    args = ap.parse_args(argv)

    if args.step is None:
        args.step = APPROACH_STEP_M if args.approach else START_STEP_M if args.starts else DEFAULT_STEP_M
    if args.margin is None:
        args.margin = APPROACH_MARGIN_M if args.approach else START_MARGIN_M if args.starts else DEFAULT_MARGIN_M
    if args.step <= 0:
        print("error: --step must be positive", file=sys.stderr)
        return 2
    if args.approach:
        return main_approach(args)
    if args.starts:
        return main_starts(args, args.courses if args.courses and not args.all else all_course_ids())
    ids = all_course_ids() if args.all else (args.courses or DEFAULT_COURSE_IDS)

    try:
        source = make_source(args)
        reports = [check_course(load_course(cid), source, args.step, args.margin, args.workers, args.warn_low)
                   for cid in ids]
    except TerrainError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({"source": source.name, "step_m": args.step, "margin_m": args.margin,
                          "courses": reports}, indent=2, default=str))
    else:
        print(f"Terrain check - source {source.name}, step {args.step:g} m, margin {args.margin:g} m")
        for r in reports:
            print(f"\n{r['id']}  {r['name']}")
            print(f"  {r['gates']} gates, {r['length_m'] / 1000:.1f} km route, {r['samples']} samples")
            shown = r["findings"] if args.max_findings <= 0 else r["findings"][:args.max_findings]
            for f in shown:
                print("    " + describe(f))
            if len(r["findings"]) > len(shown):
                print(f"    ... and {len(r['findings']) - len(shown)} more")
            w = r["worst"]
            unverified_note = f", {r['unverified']} sample(s) UNVERIFIED (no terrain data)" if r["unverified"] else ""
            if w is None:
                print(f"  {r['status']}  no verified samples{unverified_note}")
            else:
                where = (f"gate {w['gate'] + 1}" if w["kind"] == "gate"
                         else f"leg {w['leg'][0] + 1}->{w['leg'][1] + 1} at {w['along_m'] / 1000:.1f} km")
                print(f"  {r['status']}  worst clearance {w['clearance_m']:.1f} m "
                      f"at {where} ({w['lat']:.5f},{w['lon']:.5f}, terrain {w['terrain_m']:.1f} m)"
                      f"{unverified_note}")
        failed = [r["id"] for r in reports if r["status"] == "FAIL"]
        unverified = [r["id"] for r in reports if r["status"] == "UNVERIFIED"]
        passed_n = len(reports) - len(failed) - len(unverified)
        print(f"\n{passed_n}/{len(reports)} courses pass"
              + (f" - failed: {', '.join(failed)}" if failed else "")
              + (f" - unverified: {', '.join(unverified)}" if unverified else ""))
    return 1 if any(not r["passed"] for r in reports) else 0


def main_approach(args):
    ids = args.courses if args.courses and not args.all else all_runway_ids()
    try:
        source = make_source(args)
        reports = [check_approach(load_runway(rid), source, args.step, args.margin, args.workers) for rid in ids]
    except TerrainError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"source": source.name, "step_m": args.step, "margin_m": args.margin,
                          "runways": reports}, indent=2, default=str))
    else:
        print(f"Approach terrain check - source {source.name}, step {args.step:g} m, margin {args.margin:g} m")
        for r in reports:
            print("\n" + describe_approach(r))
        failed = [r["id"] for r in reports if r["status"] == "FAIL"]
        print(f"\n{len(reports) - len(failed)}/{len(reports)} approaches clear"
              + (f" - failed: {', '.join(failed)}" if failed else ""))
    return 1 if any(not r["passed"] for r in reports) else 0


if __name__ == "__main__":
    raise SystemExit(main())
