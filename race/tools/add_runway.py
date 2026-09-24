#!/usr/bin/env python3
"""Add one runway END to race/runways/ from OurAirports data, keeping race/runways/index.json
in sync. The server's load_runways() (race/server/app.py) validates the same shape.

    python race/tools/add_runway.py TNCM 10 --notes "Maho Beach approach"
    python race/tools/add_runway.py LOWI 26 --name "Innsbruck 26 (Inn valley)"
    python race/tools/add_runway.py LFLJ 04 --derive-missing-end      # see below
    python race/tools/add_runway.py KEUG 16R --csv-dir /tmp/oa         # use local CSVs

Data: runways.csv + airports.csv from
raw.githubusercontent.com/davidmegginson/ourairports-data/main/, downloaded into --csv-dir
(default ~/.cache/finsonly-ourairports) on first use and reused after (--refresh re-downloads).

What gets written for the requested END (e.g. "10" of runway 10/28):
    thr_lat/thr_lon  that end's lat/lon, moved down the runway by its displaced threshold (if
                     any) — the point a landing is scored from
    thr_alt_m        that end's elevation (ft -> m); if OurAirports has none, the AIRPORT
                     elevation, and the notes say so
    heading_deg      that end's true heading; if blank, the bearing from this end to the other
    length_m         runway length minus the displaced threshold (landing distance available)
    width_m          runway width (ft -> m)
    zone             10-30 % of length_m clamped to 60-450 m, >= 60 m deep (physics_lab.js's
                     defaultZone(), same rule)
Nothing is invented: a missing coordinate for the requested end is an error, unless
--derive-missing-end is given, in which case that end is computed from the OTHER end's
coordinates plus the runway length along the reciprocal heading (and the notes say so).

Validation mirrors app.py's validate_runway() (id shape, ranges, zone inside the runway).
An existing file with different geometry is refused unless --force (a changed runway should
normally get a new `version`, which starts a fresh board — pass --version N).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNWAYS_DIR = REPO_ROOT / "race" / "runways"
INDEX_PATH = RUNWAYS_DIR / "index.json"
OA_BASE = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/"
DEFAULT_CSV_DIR = Path.home() / ".cache" / "finsonly-ourairports"
FT = 0.3048
EARTH_R_M = 6371008.8
ID_RE = re.compile(r"^[a-z0-9-]{1,64}$")
MAX_NAME_LEN = 64


class RunwayError(ValueError):
    pass


def default_zone(length_m: float) -> dict:
    L = length_m if length_m and length_m > 0 else 0.0
    min_m = min(max(L * 0.10, 60.0), 390.0)
    max_m = min(max(L * 0.30, min_m + 60.0), 450.0)
    return {"min_m": round(min_m, 1), "max_m": round(max_m, 1)}


def _num(s):
    if s is None or str(s).strip() == "":
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def destination(lat, lon, heading_deg, dist_m):
    """Great-circle destination (same sphere as check_terrain.py / race.js)."""
    d = dist_m / EARTH_R_M
    h = math.radians(heading_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(h))
    l2 = l1 + math.atan2(math.sin(h) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def fetch_csvs(csv_dir: Path, refresh: bool = False) -> None:
    csv_dir.mkdir(parents=True, exist_ok=True)
    for name in ("runways.csv", "airports.csv"):
        p = csv_dir / name
        if p.exists() and not refresh:
            continue
        req = urllib.request.Request(OA_BASE + name, headers={"User-Agent": "finsonly-add-runway"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                p.write_bytes(r.read())
        except OSError as e:
            raise RunwayError(f"could not download {name} from OurAirports ({e}); pass --csv-dir with local copies")


def find_airport(csv_dir: Path, icao: str) -> dict:
    with open(csv_dir / "airports.csv", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if icao in (row["ident"], row.get("icao_code"), row.get("gps_code"), row.get("local_code")):
                return row
    raise RunwayError(f"airport {icao} not found in airports.csv")


def _end_key(s: str) -> str:
    """'01' and '1' are the same end; '09L' == '9L'."""
    s = (s or "").strip().upper()
    return s.lstrip("0") or s


def find_runway(csv_dir: Path, airport_ident: str, end: str):
    """(row, prefix, other_prefix) for the runway row that has `end` as its le_ or he_ ident."""
    ends = []
    with open(csv_dir / "runways.csv", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row["airport_ident"] != airport_ident:
                continue
            ends += [row["le_ident"], row["he_ident"]]
            for p, o in (("le_", "he_"), ("he_", "le_")):
                if _end_key(row[p + "ident"]) == _end_key(end):
                    if row.get("closed") == "1":
                        raise RunwayError(f"{airport_ident} runway {end} is marked closed in OurAirports")
                    return row, p, o
    raise RunwayError(f"{airport_ident} has no runway end {end!r} (ends: {', '.join(e for e in ends if e) or 'none'})")


def build_runway(airport: dict, row: dict, p: str, o: str, end: str, *, derive_missing_end=False,
                 name=None, notes=None, version=1, rid=None) -> dict:
    icao = airport.get("icao_code") or airport["ident"]
    length_ft, width_ft = _num(row["length_ft"]), _num(row["width_ft"])
    if not length_ft or length_ft <= 0:
        raise RunwayError(f"{icao} {end}: no runway length in OurAirports")
    if not width_ft or width_ft <= 0:
        raise RunwayError(f"{icao} {end}: no runway width in OurAirports")
    derived = []
    lat, lon = _num(row[p + "latitude_deg"]), _num(row[p + "longitude_deg"])
    olat, olon = _num(row[o + "latitude_deg"]), _num(row[o + "longitude_deg"])
    heading = _num(row[p + "heading_degT"])
    if lat is None or lon is None:
        if not derive_missing_end:
            raise RunwayError(f"{icao} {end}: OurAirports has no coordinates for this end "
                              "(--derive-missing-end computes it from the other end)")
        ohdg = _num(row[o + "heading_degT"])
        if olat is None or olon is None or (ohdg is None and heading is None):
            raise RunwayError(f"{icao} {end}: cannot derive this end — the other end lacks coordinates/heading")
        back = (ohdg if ohdg is not None else (heading + 180.0) % 360.0)
        lat, lon = destination(olat, olon, back, length_ft * FT)
        derived.append(f"{end} end coordinates derived from the {row[o + 'ident']} end + length along {back:g}°")
    if heading is not None and olat is not None and olon is not None and not derived:
        computed = bearing_deg(lat, lon, olat, olon)
        if abs(((heading - computed) + 540.0) % 360.0 - 180.0) > 20.0:
            derived.append(f"OurAirports heading {heading:g}° disagrees with the end-to-end bearing "
                           f"{computed:.1f}°; using the bearing")
            heading = computed
    if heading is None:
        if olat is None or olon is None:
            raise RunwayError(f"{icao} {end}: no true heading and no opposite end to compute one from")
        heading = bearing_deg(lat, lon, olat, olon)
        derived.append("heading computed from the two end coordinates")
    elev_ft = _num(row[p + "elevation_ft"])
    if elev_ft is None:
        elev_ft = _num(airport.get("elevation_ft"))
        if elev_ft is None:
            raise RunwayError(f"{icao} {end}: no elevation for this end or the airport")
        derived.append("threshold elevation is the airport elevation (no end elevation in OurAirports)")
    disp_ft = _num(row[p + "displaced_threshold_ft"]) or 0.0
    if disp_ft >= length_ft:
        raise RunwayError(f"{icao} {end}: displaced threshold {disp_ft} ft >= length {length_ft} ft")
    if disp_ft > 0:
        lat, lon = destination(lat, lon, heading, disp_ft * FT)
        derived.append(f"threshold displaced {disp_ft:g} ft")
    length_m = (length_ft - disp_ft) * FT
    rid = rid or f"{icao.lower()}-{end.lower()}"
    name = name or f"{airport['name']} {end.upper()}"
    if len(name) > MAX_NAME_LEN:
        name = name[:MAX_NAME_LEN].rstrip()
    note_parts = [notes] if notes else []
    note_parts.append(f"OurAirports {icao} {row['le_ident']}/{row['he_ident']}, {row['surface'] or 'surface ?'}, "
                      f"{length_ft:g}x{width_ft:g} ft")
    note_parts += derived
    rw = {
        "id": rid,
        "name": name,
        "version": int(version),
        "thr_lat": round(lat, 6),
        "thr_lon": round(lon, 6),
        "thr_alt_m": round(elev_ft * FT, 1),
        "heading_deg": round(heading % 360.0, 1),
        "length_m": round(length_m, 1),
        "width_m": round(width_ft * FT, 1),
        "zone": default_zone(length_m),
        "notes": ". ".join(note_parts) + ".",
    }
    return validate(rw)


def validate(rw: dict) -> dict:
    """Same rules as app.py validate_runway()."""
    if not isinstance(rw.get("id"), str) or not ID_RE.match(rw["id"]):
        raise RunwayError(f"bad id {rw.get('id')!r}")
    if not isinstance(rw.get("name"), str) or not rw["name"].strip():
        raise RunwayError("name must be a non-empty string")
    if not isinstance(rw.get("version"), int) or isinstance(rw.get("version"), bool) or rw["version"] < 1:
        raise RunwayError("version must be an integer >= 1")
    for key, lo, hi in (("thr_lat", -90, 90), ("thr_lon", -180, 180), ("thr_alt_m", -500, 9000),
                        ("heading_deg", 0, 360), ("length_m", 50, 10000), ("width_m", 5, 200)):
        v = rw.get(key)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi:
            raise RunwayError(f"{key}={v!r} must be a number in [{lo}, {hi}]")
    z = rw.get("zone") or {}
    if not (isinstance(z.get("min_m"), (int, float)) and isinstance(z.get("max_m"), (int, float))
            and 0 <= z["min_m"] < z["max_m"] <= rw["length_m"]):
        raise RunwayError("zone needs 0 <= min_m < max_m <= length_m")
    return rw


def _geometry(rw):
    return tuple(rw.get(k) for k in ("thr_lat", "thr_lon", "thr_alt_m", "heading_deg", "length_m", "width_m")) + (
        json.dumps(rw.get("zone"), sort_keys=True), rw.get("version"))


def load_index(index_path=None) -> list:
    index_path = index_path or INDEX_PATH
    return json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []


def write_runway(rw: dict, runways_dir: Path = None, force: bool = False) -> Path:
    runways_dir = runways_dir or RUNWAYS_DIR
    path = runways_dir / f"{rw['id']}.json"
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        if _geometry(old) != _geometry(rw) and not force:
            raise RunwayError(f"{path.name} exists with different geometry/version; bump --version or pass --force")
    runways_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    index_path = runways_dir / "index.json"
    entries = [e for e in load_index(index_path) if e.get("id") != rw["id"]]
    entries.append({"id": rw["id"], "name": rw["name"], "file": f"{rw['id']}.json"})
    entries.sort(key=lambda e: e["id"])
    index_path.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("icao")
    ap.add_argument("end", help="runway end ident, e.g. 10, 16R, 04")
    ap.add_argument("--name", help="display name (default: '<airport name> <END>')")
    ap.add_argument("--id", dest="rid", help="runway id (default: <icao>-<end>, lowercase)")
    ap.add_argument("--notes", help="free-text notes, prepended to the data-provenance note")
    ap.add_argument("--version", type=int, default=1)
    ap.add_argument("--csv-dir", type=Path, default=DEFAULT_CSV_DIR)
    ap.add_argument("--refresh", action="store_true", help="re-download the OurAirports CSVs")
    ap.add_argument("--derive-missing-end", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="print the JSON, write nothing")
    args = ap.parse_args(argv)
    try:
        fetch_csvs(args.csv_dir, args.refresh)
        airport = find_airport(args.csv_dir, args.icao.upper())
        row, p, o = find_runway(args.csv_dir, airport["ident"], args.end)
        rw = build_runway(airport, row, p, o, args.end, derive_missing_end=args.derive_missing_end,
                          name=args.name, notes=args.notes, version=args.version, rid=args.rid)
        if args.dry_run:
            print(json.dumps(rw, indent=2, ensure_ascii=False))
            return 0
        path = write_runway(rw, force=args.force)
    except RunwayError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"Wrote {path.relative_to(REPO_ROOT)}  ({rw['name']}, hdg {rw['heading_deg']}, {rw['length_m']} m)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
