#!/usr/bin/env python3
"""Diff GeoFS's own airport list against our Dash dataset.

The client searches `geofs.mainAirportList` (~6.9k ICAO -> [lat, lon, ...]); the server resolves
Dash airports from airports.json.gz (OurAirports large + medium). An ICAO the client can offer but
the server does not know is refused by `dash_create` -- this tool says how many there are.

Get the dump on geo-fs.com, in the browser console:

    copy(JSON.stringify(geofs.mainAirportList))

paste it into a file, then:

    python -I race/server/airports/diff_geofs.py geofs_airports.json [--json] [--limit 50]

Reports ICAOs only GeoFS has, ICAOs only we have, codes that match only through one of our aliases
(gps/local/IATA code), and positions more than MISMATCH_KM apart.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import airportdb  # noqa: E402

MISMATCH_KM = 5.0


def _latlon(v):
    """GeoFS stores [lat, lon, ...]; be tolerant of {lat, lon} too. None when unusable."""
    try:
        if isinstance(v, (list, tuple)) and len(v) >= 2:
            lat, lon = float(v[0]), float(v[1])
        elif isinstance(v, dict):
            lat, lon = float(v.get("lat")), float(v.get("lon", v.get("lng")))
        else:
            return None
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def diff(geofs: dict, db: "airportdb.AirportDB") -> dict:
    """Pure: the comparison as a dict of sorted lists."""
    geofs_keys = {str(k).strip().upper(): v for k, v in (geofs or {}).items() if str(k).strip()}
    only_geofs, via_alias, mismatched = [], [], []
    matched = set()
    for code, val in sorted(geofs_keys.items()):
        apt = db.by_icao.get(code)
        if apt is None:
            apt = db.by_alias.get(code)
            if apt is None:
                only_geofs.append(code)
                continue
            via_alias.append({"geofs": code, "ours": apt["icao"]})
        matched.add(apt["icao"])
        pos = _latlon(val)
        if pos is not None:
            km = airportdb.distance_m(pos[0], pos[1], apt["lat"], apt["lon"]) / 1000.0
            if km > MISMATCH_KM:
                mismatched.append({"icao": code, "km": round(km, 1)})
    only_ours = sorted(a["icao"] for a in db.airports if a["icao"] not in matched)
    return {"geofs_count": len(geofs_keys), "ours_count": len(db), "matched": len(matched),
            "only_geofs": only_geofs, "only_ours": only_ours, "via_alias": via_alias,
            "position_mismatch": sorted(mismatched, key=lambda m: -m["km"])}


def report(d: dict, limit: int) -> str:
    def cut(xs):
        xs = [x if isinstance(x, str) else json.dumps(x) for x in xs]
        more = len(xs) - limit
        return ", ".join(xs[:limit]) + (f", ... (+{more} more)" if more > 0 else "")
    return "\n".join([
        f"GeoFS: {d['geofs_count']}   ours: {d['ours_count']}   matched: {d['matched']}",
        f"only in GeoFS ({len(d['only_geofs'])}) -- a Dash to these is refused: {cut(d['only_geofs'])}",
        f"only in ours ({len(d['only_ours'])}): {cut(d['only_ours'])}",
        f"matched through an alias ({len(d['via_alias'])}): {cut(d['via_alias'])}",
        f"position differs by > {MISMATCH_KM:g} km ({len(d['position_mismatch'])}): {cut(d['position_mismatch'])}",
    ])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Diff geofs.mainAirportList against airports.json.gz")
    ap.add_argument("dump", help="file holding JSON.stringify(geofs.mainAirportList), or - for stdin")
    ap.add_argument("--airports", default=None, help="airports.json.gz (default: the server's)")
    ap.add_argument("--json", action="store_true", help="print the full comparison as JSON")
    ap.add_argument("--limit", type=int, default=40, help="codes listed per line in the text report")
    args = ap.parse_args(argv)
    raw = sys.stdin.read() if args.dump == "-" else open(args.dump, encoding="utf-8").read()
    geofs = json.loads(raw)
    if not isinstance(geofs, dict):
        print("expected a JSON object of ICAO -> [lat, lon, ...]", file=sys.stderr)
        return 2
    db = airportdb.load(args.airports)
    if db is None:
        print("could not load the airport dataset", file=sys.stderr)
        return 2
    d = diff(geofs, db)
    print(json.dumps(d, indent=1) if args.json else report(d, args.limit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
