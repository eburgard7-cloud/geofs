#!/usr/bin/env python3
"""Warm the tile proxy's disk cache for every shared course.

    python race/tools/prefetch_tiles.py                       # http://localhost:8000, zooms 8,10,12,14
    python race/tools/prefetch_tiles.py --base-url https://race.finsonly.net
    python race/tools/prefetch_tiles.py --zooms 8,12 --pad-km 5
    python race/tools/prefetch_tiles.py --dry-run              # print the tile list, fetch nothing

Reads every course's bbox from race/courses/*.json (every gate and item box's lat/lon), expands it
by --pad-km (default 3 km, per the task this was built for), and walks the Web Mercator tile range
covering that bbox at each zoom in --zooms, requesting each one from the LIVE server's own
/tiles/terrain and /tiles/imagery routes (race/server/app.py) so a race night never eats the first
pilot's connection on cold tiles.

Stdlib only (urllib), matching this directory's other tools (see check_addons.py). Never touches
api.cesium.com or opentopodata.org -- CLAUDE.md's "Feature series 0.7-1.0" rule against a runtime
or test dependency on those hosts extends in spirit to this tool too: it only ever talks to the
--base-url server, never to a third-party tile host directly.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
COURSES_DIR = REPO_ROOT / "race" / "courses"

DEFAULT_ZOOMS = [8, 10, 12, 14]
EARTH_RADIUS_M = 6_371_000.0


def course_points(course: dict) -> list[tuple[float, float]]:
    """Every lat/lon this course cares about: gates and item boxes (both hash-relevant and
    cosmetic alike -- the cache should cover what a pilot will actually fly past)."""
    pts = [(g["lat"], g["lon"]) for g in course.get("gates", []) if "lat" in g and "lon" in g]
    boxes = course.get("itemBoxes")
    if boxes is None and course.get("itemBox"):
        boxes = [course["itemBox"]]
    for b in boxes or []:
        if "lat" in b and "lon" in b:
            pts.append((b["lat"], b["lon"]))
    return pts


def expand_bbox(points: list[tuple[float, float]], pad_km: float) -> tuple[float, float, float, float]:
    """(lat_lo, lon_lo, lat_hi, lon_hi), padded by pad_km on every side. A flat-earth pad (same
    posture as app.py's _meters_between elsewhere in this codebase) -- plenty for a cache warm."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    lat_lo, lat_hi = min(lats), max(lats)
    lon_lo, lon_hi = min(lons), max(lons)
    dlat = math.degrees(pad_km * 1000 / EARTH_RADIUS_M)
    mid_lat = math.radians((lat_lo + lat_hi) / 2)
    dlon = math.degrees(pad_km * 1000 / (EARTH_RADIUS_M * max(0.01, math.cos(mid_lat))))
    return (lat_lo - dlat, lon_lo - dlon, lat_hi + dlat, lon_hi + dlon)


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    """Standard Web Mercator lon/lat -> tile x/y at zoom z."""
    lat = max(-85.0511, min(85.0511, lat))
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_range(bbox: tuple[float, float, float, float], z: int) -> list[tuple[int, int]]:
    lat_lo, lon_lo, lat_hi, lon_hi = bbox
    x0, y1 = lonlat_to_tile(lon_lo, lat_lo, z)   # SW corner -> larger y (south)
    x1, y0 = lonlat_to_tile(lon_hi, lat_hi, z)   # NE corner -> smaller y (north)
    xs = range(min(x0, x1), max(x0, x1) + 1)
    ys = range(min(y0, y1), max(y0, y1) + 1)
    return [(x, y) for x in xs for y in ys]


def load_courses(courses_dir: Path) -> list[dict]:
    index_path = courses_dir / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"could not read {index_path}: {e}", file=sys.stderr)
        return []
    out = []
    for entry in index if isinstance(index, list) else []:
        path = courses_dir / Path(entry["file"]).name
        try:
            out.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError, KeyError) as e:
            print(f"skipping {entry!r}: {e}", file=sys.stderr)
    return out


def build_urls(base_url: str, courses: list[dict], zooms: list[int], pad_km: float) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for course in courses:
        pts = course_points(course)
        if not pts:
            continue
        bbox = expand_bbox(pts, pad_km)
        for z in zooms:
            for x, y in tile_range(bbox, z):
                for path in (f"/tiles/terrain/{z}/{x}/{y}.png", f"/tiles/imagery/{z}/{y}/{x}"):
                    if path not in seen:
                        seen.add(path)
                        urls.append(base_url.rstrip("/") + path)
    return urls


def fetch(url: str, timeout: float) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return True, str(resp.status)
    except urllib.error.HTTPError as e:
        return False, str(e.code)
    except urllib.error.URLError as e:
        return False, str(e.reason)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:8000", help="the race server to warm")
    p.add_argument("--courses-dir", default=str(COURSES_DIR), help="defaults to the checkout's race/courses")
    p.add_argument("--zooms", default=",".join(str(z) for z in DEFAULT_ZOOMS),
                   help="comma-separated zoom levels, e.g. 8,10,12,14")
    p.add_argument("--pad-km", type=float, default=3.0, help="bbox padding in km (default 3)")
    p.add_argument("--sleep-ms", type=float, default=0.0, help="delay between requests, to stay under the server's rate limit")
    p.add_argument("--dry-run", action="store_true", help="print the tile URLs instead of fetching them")
    args = p.parse_args(argv)

    zooms = [int(z) for z in args.zooms.split(",") if z.strip()]
    courses = load_courses(Path(args.courses_dir))
    if not courses:
        print("no courses loaded; nothing to prefetch", file=sys.stderr)
        return 1
    urls = build_urls(args.base_url, courses, zooms, args.pad_km)
    print(f"{len(courses)} courses, {len(zooms)} zoom levels -> {len(urls)} tile requests")

    if args.dry_run:
        for u in urls:
            print(u)
        return 0

    ok = fail = 0
    for i, u in enumerate(urls, 1):
        success, detail = fetch(u, timeout=10.0)
        ok, fail = (ok + 1, fail) if success else (ok, fail + 1)
        if not success:
            print(f"  FAIL {u} ({detail})", file=sys.stderr)
        if i % 200 == 0:
            print(f"...{i}/{len(urls)} ({ok} ok, {fail} failed)")
        if args.sleep_ms > 0:
            time.sleep(args.sleep_ms / 1000.0)
    print(f"done: {ok} ok, {fail} failed")
    return 1 if fail and not ok else 0


if __name__ == "__main__":
    raise SystemExit(main())
