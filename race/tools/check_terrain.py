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

Exit codes: 0 every course passed, 1 at least one course failed, 2 the check couldn't be
completed (no terrain data, network error, bad arguments).

Terrain sources (--source):

  usgs    (default) USGS 3DEP point queries, epqs.nationalmap.gov. US-only, which covers all
          three Oregon courses, and at 1-10 m it is *finer* than what GeoFS renders. One HTTP
          request per sample, so it runs with a small thread pool and likes a --cache.

  cesium  Cesium World Terrain through Cesium ion (quantized-mesh), i.e. the actual terrain
          Cesium 1.96 draws. Needs CESIUM_ION_TOKEN in the environment.
          UNVERIFIED END TO END: api.cesium.com is not reachable from the machine this was
          written on, so the decoder below has only ever run against synthetic tiles built by
          race/test/test_check_terrain.py. If a real tile disagrees with it, prefer `usgs` and
          fix the decoder rather than trusting a surprising number.

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

# The hand-placed, never-flown courses this exists for (README "Shared course status").
DEFAULT_COURSE_IDS = ["gorge-run", "crater-rim", "hood-circuit"]

# Same sphere race.js's destination()/Course.length() use, so distances here and in the client
# agree to the metre.
EARTH_R_M = 6371008.8

DEFAULT_STEP_M = 250.0
DEFAULT_MARGIN_M = 150.0
DEFAULT_WORKERS = 8
SAMPLE_KEY_DP = 6          # ~0.1 m at these latitudes; also the cache key precision

USGS_URL = "https://epqs.nationalmap.gov/v1/json"
ION_ENDPOINT = "https://api.cesium.com/v1/assets/1/endpoint"


class TerrainError(RuntimeError):
    """The check could not be completed (no data, network failure, unusable source)."""


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
            v = self.table.get(k)
            if v is None:
                missing.append(k)
            else:
                out[k] = float(v)
        if missing:
            raise TerrainError(
                f"{len(missing)} sample(s) missing from the samples file (first: {missing[0]}). "
                "Build one with --cache against a live source, or widen --step so the points line up.")
        return out


class UsgsSource:
    """USGS 3DEP point queries. One request per point, so it fans out over a thread pool.

    Out-of-coverage points come back as HTTP 200 with a non-JSON body ("Call failed. ..."),
    which is why the parse failure below is reported rather than skipped: a course that leaves
    US coverage must not quietly pass."""

    name = "usgs"

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
            return sample_key(lat, lon), float(value), None
        except (json.JSONDecodeError, TypeError, ValueError):
            return sample_key(lat, lon), None, f"no elevation at {lat},{lon}: {body.strip()[:80]}"

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
    us = _zigzag_decode(struct.unpack_from(f"<{vertex_count}H", data, off)); off += need
    vs = _zigzag_decode(struct.unpack_from(f"<{vertex_count}H", data, off)); off += need
    hs = _zigzag_decode(struct.unpack_from(f"<{vertex_count}H", data, off)); off += need

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


class CachedSource:
    """Read-through cache around another source: fetch only what the cache is missing."""

    def __init__(self, inner, path):
        self.inner = inner
        self.name = f"{inner.name} (cached in {path})"
        self.path = Path(path)
        self.table = {}
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.table = {k: float(v) for k, v in loaded.items()}
            except (json.JSONDecodeError, TypeError, ValueError):
                pass   # a corrupt cache is a cache miss, never a failure
        self.hits = 0
        self.fetched = 0

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
            self.path.write_text(json.dumps(self.table, indent=0, sort_keys=True) + "\n", encoding="utf-8")
        return out


def make_source(args):
    if args.source == "file":
        if not args.samples_file:
            raise TerrainError("--source file needs --samples-file PATH")
        return FileSource(args.samples_file)
    inner = CesiumSource(level=args.cesium_level) if args.source == "cesium" else UsgsSource()
    return CachedSource(inner, args.cache) if args.cache else inner


# --------------------------------------------------------------------------- the check
def classify(sample, terrain_m, margin_m, warn_low=False):
    """Turn one sampled point into a finding, or None when it's fine."""
    clearance = sample["alt"] - terrain_m
    if clearance < 0:
        level = "BURIED"
    elif sample["kind"] == "gate" and clearance < sample["radius"]:
        level = "CLIPPING"
    elif clearance < margin_m:
        level = "LOW"
    else:
        return None
    return {"level": level, "fails": level != "LOW" or not warn_low,
            "clearance_m": clearance, "terrain_m": terrain_m, **sample}


def describe(f):
    where = (f"gate {f['gate'] + 1}" if f["kind"] == "gate"
             else f"leg {f['leg'][0] + 1}->{f['leg'][1] + 1} at {f['along_m'] / 1000:.1f} km")
    return (f"{f['level']:<8} {where:<22} {f['lat']:.5f},{f['lon']:.5f}  "
            f"alt {f['alt']:7.1f} m  terrain {f['terrain_m']:7.1f} m  clearance {f['clearance_m']:7.1f} m")


def check_course(course, source, step_m=DEFAULT_STEP_M, margin_m=DEFAULT_MARGIN_M,
                 workers=DEFAULT_WORKERS, warn_low=False):
    gates = course["gates"]
    samples = route_samples(gates, step_m)
    heights = source.heights([(s["lat"], s["lon"]) for s in samples], workers=workers)

    findings, worst = [], None
    for s in samples:
        t = heights.get(sample_key(s["lat"], s["lon"]))
        if t is None:
            raise TerrainError(f"no terrain height for {sample_key(s['lat'], s['lon'])}")
        clearance = s["alt"] - t
        if worst is None or clearance < worst["clearance_m"]:
            worst = {"clearance_m": clearance, "terrain_m": t, **s}
        f = classify(s, t, margin_m, warn_low)
        if f:
            findings.append(f)

    length_m = sum(haversine_m((gates[i]["lat"], gates[i]["lon"]), (gates[i + 1]["lat"], gates[i + 1]["lon"]))
                   for i in range(len(gates) - 1))
    return {
        "id": course["id"], "name": course["name"], "gates": len(gates),
        "length_m": length_m, "samples": len(samples),
        "findings": findings, "worst": worst,
        "passed": not any(f["fails"] for f in findings),
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
    ap.add_argument("courses", nargs="*", help=f"Course ids. Default: {' '.join(DEFAULT_COURSE_IDS)}")
    ap.add_argument("--all", action="store_true", help="Check every course in race/courses/.")
    ap.add_argument("--source", choices=["usgs", "cesium", "file"], default="usgs")
    ap.add_argument("--samples-file", help="JSON table of samples for --source file.")
    ap.add_argument("--cache", help="Read-through sample cache (the only file this tool writes).")
    ap.add_argument("--step", type=float, default=DEFAULT_STEP_M, help="Sample spacing along each leg, metres.")
    ap.add_argument("--margin", type=float, default=DEFAULT_MARGIN_M, help="Required clearance, metres.")
    ap.add_argument("--warn-low", action="store_true", help="Report LOW without failing the course.")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Parallel sample requests.")
    ap.add_argument("--cesium-level", type=int, default=11, help="Terrain tile level for --source cesium.")
    ap.add_argument("--max-findings", type=int, default=12, help="Findings listed per course (0 = all).")
    ap.add_argument("--json", action="store_true", help="Machine-readable report on stdout.")
    args = ap.parse_args(argv)

    if args.step <= 0:
        print("error: --step must be positive", file=sys.stderr)
        return 2
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
            where = (f"gate {w['gate'] + 1}" if w["kind"] == "gate"
                     else f"leg {w['leg'][0] + 1}->{w['leg'][1] + 1} at {w['along_m'] / 1000:.1f} km")
            print(f"  {'PASS' if r['passed'] else 'FAIL'}  worst clearance {w['clearance_m']:.1f} m "
                  f"at {where} ({w['lat']:.5f},{w['lon']:.5f}, terrain {w['terrain_m']:.1f} m)")
        failed = [r["id"] for r in reports if not r["passed"]]
        print(f"\n{len(reports) - len(failed)}/{len(reports)} courses pass"
              + (f" - failed: {', '.join(failed)}" if failed else ""))
    return 1 if any(not r["passed"] for r in reports) else 0


if __name__ == "__main__":
    raise SystemExit(main())
