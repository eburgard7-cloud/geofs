#!/usr/bin/env python3
"""Build race/server/airports/airports.json.gz from the OurAirports CSV dumps.

Source: OurAirports (https://ourairports.com/data/), released into the PUBLIC DOMAIN by its
maintainers -- no attribution is required, but README.md names it anyway.

    python -I race/server/airports/build_airports.py --airports airports.csv --runways runways.csv
    # writes race/server/airports/airports.json.gz next to this script (or --out PATH)

The CSVs are downloaded by hand (https://davidmegginson.github.io/ourairports-data/airports.csv
and .../runways.csv) and passed in as paths: this script never touches the network, so a build is
reproducible from the two files it was given and the output is byte-identical for the same input
(sorted keys, gzip mtime 0).

Kept: OPEN `large_airport` and `medium_airport` rows, each with its open runways. An airport's key
is its ICAO code (`icao_code`), else a 4-character `gps_code`, else its OurAirports `ident`; the
other two codes and the IATA code become search aliases. Coordinates are rounded to 5 decimals
(~1 m), which is far finer than anything the Dash boundary checks need.
"""
import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import sys

KEEP_TYPES = ("large_airport", "medium_airport")
TYPE_RANK = {"large_airport": 0, "medium_airport": 1}
ICAO_RE = re.compile(r"^[A-Z0-9]{4}$")
DATA_VERSION = 1


def _f(v, nd=5):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) else round(x, nd)


def _i(v):
    x = _f(v, 0)
    return None if x is None else int(x)


def _code(v) -> str:
    return (v or "").strip().upper()


def airport_key(row: dict) -> str:
    """The ICAO a pilot types: icao_code, else a 4-char gps_code, else the OurAirports ident."""
    for col in ("icao_code", "gps_code"):
        c = _code(row.get(col))
        if ICAO_RE.match(c):
            return c
    return _code(row.get("ident"))


def _bearing(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def runway_entry(row: dict) -> dict:
    le_lat, le_lon = _f(row.get("le_latitude_deg")), _f(row.get("le_longitude_deg"))
    he_lat, he_lon = _f(row.get("he_latitude_deg")), _f(row.get("he_longitude_deg"))
    hdg = _f(row.get("le_heading_degT"), 1)
    if hdg is None and None not in (le_lat, le_lon, he_lat, he_lon):
        hdg = round(_bearing(le_lat, le_lon, he_lat, he_lon), 1)
    return {
        "le": (row.get("le_ident") or "").strip() or None,
        "he": (row.get("he_ident") or "").strip() or None,
        "le_lat": le_lat, "le_lon": le_lon, "he_lat": he_lat, "he_lon": he_lon,
        "hdg": hdg,
        "length_ft": _i(row.get("length_ft")),
        "width_ft": _i(row.get("width_ft")),
        "elev_ft": _i(row.get("le_elevation_ft")),
        "surface": (row.get("surface") or "").strip()[:16] or None,
    }


def build(airports_csv: str, runways_csv: str) -> dict:
    """Pure apart from reading the two CSV texts: returns the dataset dict."""
    by_ref: dict[str, dict] = {}
    chosen: dict[str, tuple] = {}     # key -> (type rank, ourairports id) of the row kept
    for row in csv.DictReader(io.StringIO(airports_csv)):
        if row.get("type") not in KEEP_TYPES:
            continue
        lat, lon = _f(row.get("latitude_deg")), _f(row.get("longitude_deg"))
        key = airport_key(row)
        if lat is None or lon is None or not key:
            continue
        try:
            oid = int(row.get("id") or 0)
        except ValueError:
            oid = 0
        rank = (TYPE_RANK[row["type"]], oid)
        if key in chosen and chosen[key] <= rank:
            continue                       # a key collision keeps the larger, then older, airport
        aliases = sorted({c for c in (_code(row.get("ident")), _code(row.get("gps_code")),
                                      _code(row.get("icao_code")), _code(row.get("iata_code")))
                          if c and c != key})
        if key in chosen:
            by_ref.pop(next(r for r, a in by_ref.items() if a["icao"] == key))
        chosen[key] = rank
        by_ref[str(row.get("id"))] = {
            "icao": key,
            "iata": _code(row.get("iata_code")) or None,
            "name": (row.get("name") or "").strip()[:96],
            "city": (row.get("municipality") or "").strip()[:64] or None,
            "country": _code(row.get("iso_country")) or None,
            "type": "large" if row["type"] == "large_airport" else "medium",
            "lat": lat, "lon": lon,
            "elev_ft": _i(row.get("elevation_ft")),
            "aliases": aliases,
            "runways": [],
        }
    for row in csv.DictReader(io.StringIO(runways_csv)):
        apt = by_ref.get(str(row.get("airport_ref")))
        if apt is None or str(row.get("closed", "0")).strip() == "1":
            continue
        apt["runways"].append(runway_entry(row))
    airports = sorted(by_ref.values(), key=lambda a: a["icao"])
    for a in airports:
        a["runways"].sort(key=lambda r: (r["le"] or "", r["he"] or ""))
    return {
        "version": DATA_VERSION,
        "source": "OurAirports (https://ourairports.com/data/), public domain",
        "inputs": {"airports_csv_sha256": hashlib.sha256(airports_csv.encode("utf-8")).hexdigest(),
                   "runways_csv_sha256": hashlib.sha256(runways_csv.encode("utf-8")).hexdigest()},
        "count": len(airports),
        "airports": airports,
    }


def write_gz(data: dict, out_path: str) -> int:
    raw = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=9) as gz:
        gz.write(raw)
    blob = buf.getvalue()
    with open(out_path, "wb") as f:
        f.write(blob)
    return len(blob)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--airports", required=True, help="OurAirports airports.csv")
    ap.add_argument("--runways", required=True, help="OurAirports runways.csv")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "airports.json.gz"))
    args = ap.parse_args(argv)
    with open(args.airports, encoding="utf-8") as f:
        airports_csv = f.read()
    with open(args.runways, encoding="utf-8") as f:
        runways_csv = f.read()
    data = build(airports_csv, runways_csv)
    size = write_gz(data, args.out)
    with_rwy = sum(1 for a in data["airports"] if a["runways"])
    print(f"{data['count']} airports ({with_rwy} with runways) -> {args.out} ({size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
