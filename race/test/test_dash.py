"""ROAM + Dash (proto 11): airports, the pure dash engine, run hooks, and the relay glue.

Run: cd race/server && RACE_DB=/tmp/race-test.db python -m pytest ../test/test_server.py ../test/test_dash.py -q
"""
import os, sys
import gzip
import io
import json
import uuid
os.environ.setdefault("RACE_DB", "/tmp/race-test.db")
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_GET_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_CLAIM_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_TILE_WARM", "0")
os.environ.setdefault("RACE_COURSES_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "courses"))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
sys.path.insert(0, os.path.join(HERE, "..", "server", "airports"))
import pytest
from fastapi.testclient import TestClient
import app as appmod
import airportdb
import build_airports
import diff_geofs


# =============================================================================== airports
def test_dataset_loads_with_kpdx_and_ksea_and_their_runways():
    db = appmod.AIRPORTS
    assert db is not None and len(db) > 4000, "large + medium airports worldwide"
    pdx, sea = db.get("KPDX"), db.get("ksea")
    assert pdx["name"].startswith("Portland International") and sea["iata"] == "SEA"
    assert {(r["le"], r["he"]) for r in pdx["runways"]} >= {("10L", "28R"), ("10R", "28L")}
    rwy = next(r for r in pdx["runways"] if r["le"] == "10R")
    assert airportdb.runway_has_ends(rwy) and 100 < rwy["hdg"] < 140 and rwy["length_ft"] >= 10000
    assert db.get("PDX") is pdx, "an IATA code resolves through the alias table"
    assert db.get("ZZZZ") is None


def test_search_ranks_exact_code_then_alias_then_names():
    db = appmod.AIRPORTS
    assert db.search("KSEA")[0]["icao"] == "KSEA"
    assert db.search("pdx")[0]["icao"] == "KPDX", "exact IATA beats any prefix match"
    rows = db.search("seattle")
    assert 0 < len(rows) <= 10 and "KSEA" in [r["icao"] for r in rows]
    assert rows[0]["type"] == "large", "large airports first within a tier"
    assert db.search("   ") == []
    assert len(db.search("a")) == 10, "never more than SEARCH_LIMIT"


def test_api_airports_search_and_lookup():
    with TestClient(appmod.app) as c:
        r = c.get("/api/airports", params={"q": "seattle"})
        assert r.status_code == 200
        rows = r.json()["airports"]
        assert len(rows) <= 10 and any(a["icao"] == "KSEA" for a in rows)
        assert "runways" not in rows[0], "search rows stay small"
        one = c.get("/api/airports/kpdx").json()
        assert one["icao"] == "KPDX" and len(one["runways"]) >= 3
        assert c.get("/api/airports/ZZZZ").status_code == 404
        assert c.get("/api/airports", params={"q": ""}).status_code == 422
        assert c.get("/health").json()["airports"] == len(appmod.AIRPORTS)
        assert "airports" in c.get("/version").json()["features"]


def test_api_airports_has_its_own_rate_gate(monkeypatch):
    monkeypatch.setattr(appmod, "AIRPORT_RATE_PER_S", 1)
    monkeypatch.setattr(appmod, "AIRPORT_BURST", 2)
    monkeypatch.setattr(appmod, "_airport_gates", {})
    with TestClient(appmod.app) as c:
        codes = [c.get("/api/airports", params={"q": "kp"}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_destination_boundary_is_runway_extents_plus_1km_else_3km_radius():
    sea = appmod.AIRPORTS.get("KSEA")
    rwy = sea["runways"][0]
    mid = ((rwy["le_lat"] + rwy["he_lat"]) / 2, (rwy["le_lon"] + rwy["he_lon"]) / 2)
    assert airportdb.in_destination(sea, *mid)
    assert not airportdb.in_destination(sea, 47.5, -122.0)
    # One east-west runway (KSEA's staggered parallels would blur the edge): 0.9 km past its end
    # is in, 1.3 km is out, and so is 1.3 km abeam.
    one = {"icao": "XONE", "lat": 0.0, "lon": 0.0,
           "runways": [{"le_lat": 0.0, "le_lon": -0.01, "he_lat": 0.0, "he_lon": 0.01, "width_ft": 0}]}
    deg = 1 / 111195.0
    assert airportdb.in_destination(one, 0.0, 0.01 + 900 * deg)
    assert not airportdb.in_destination(one, 0.0, 0.01 + 1300 * deg)
    assert airportdb.in_destination(one, 900 * deg, 0.0)
    assert not airportdb.in_destination(one, 1300 * deg, 0.0)
    bare = {"icao": "XXXX", "lat": 10.0, "lon": 10.0, "runways": [{"le": "09", "he": "27"}]}
    assert airportdb.destination_distance_m(bare, 10.0, 10.02)[1] == "radius"
    assert airportdb.in_destination(bare, 10.0, 10.02)          # ~2.2 km
    assert not airportdb.in_destination(bare, 10.0, 10.04)      # ~4.4 km


AIRPORTS_CSV = '''"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"
1,"KAAA","large_airport","Alpha Intl",45.0,-122.0,100,"NA","US","US-OR","Alpha","yes","KAAA","AAA","KAAA","AAA",,,
2,"X1","medium_airport","Bravo Field",46.0,-121.0,200,"NA","US","US-WA","Bravo","no",,"",KBBB,"X1",,,
3,"US-0003","medium_airport","Charlie Strip",47.0,-120.0,300,"NA","US","US-WA","Charlie","no",,,,,,,
4,"HELI","heliport","Pad",45.1,-122.1,10,"NA","US","US-OR","Alpha","no",,,,,,,
5,"SMOL","small_airport","Tiny",45.2,-122.2,10,"NA","US","US-OR","Alpha","no",,,,,,,
6,"KCLS","closed","Gone",45.3,-122.3,10,"NA","US","US-OR","Alpha","no",,,,,,,
'''
RUNWAYS_CSV = '''"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"
10,1,"KAAA",9000,150,"ASP",1,0,"09",45.0,-122.02,100,90,,"27",45.0,-121.98,100,270,
11,1,"KAAA",5000,100,"ASP",1,1,"18",45.01,-122.0,100,180,,"36",44.99,-122.0,100,0,
12,2,"X1",6000,100,"ASP",1,0,"04",46.0,-121.01,200,,,"22",46.01,-121.0,200,,
13,3,"US-0003",3000,60,"TURF",0,0,"N",,,,,,"S",,,,,
'''


def test_build_airports_keeps_open_large_and_medium_with_open_runways():
    data = build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV)
    by = {a["icao"]: a for a in data["airports"]}
    assert set(by) == {"KAAA", "KBBB", "US-0003"}, "icao_code, else 4-char gps_code, else ident"
    assert by["KAAA"]["type"] == "large" and by["KAAA"]["aliases"] == ["AAA"]
    assert by["KBBB"]["aliases"] == ["X1"]
    assert [r["le"] for r in by["KAAA"]["runways"]] == ["09"], "a closed runway is dropped"
    assert 30 < by["KBBB"]["runways"][0]["hdg"] < 40, "heading computed from the ends when missing"
    assert by["US-0003"]["runways"][0]["le_lat"] is None
    assert data["count"] == 3 and data["source"].startswith("OurAirports")


def test_build_airports_output_is_byte_identical(tmp_path):
    data = build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV)
    a, b = tmp_path / "a.gz", tmp_path / "b.gz"
    build_airports.write_gz(data, str(a))
    build_airports.write_gz(data, str(b))
    assert a.read_bytes() == b.read_bytes()
    db = airportdb.load(str(a))
    assert len(db) == 3 and db.get("AAA")["icao"] == "KAAA"
    assert airportdb.load(str(tmp_path / "missing.gz")) is None


def test_diff_geofs_reports_both_sides_aliases_and_moved_airports(tmp_path):
    db = airportdb.AirportDB(build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV))
    geofs = {"KAAA": [45.0, -122.0, 100], "X1": [46.0, -121.0], "ZZZZ": [1, 2],
             "US-0003": [47.3, -120.0]}            # ~33 km off
    d = diff_geofs.diff(geofs, db)
    assert d["only_geofs"] == ["ZZZZ"] and d["only_ours"] == []
    assert d["via_alias"] == [{"geofs": "X1", "ours": "KBBB"}]
    assert [m["icao"] for m in d["position_mismatch"]] == ["US-0003"]
    dump = tmp_path / "geofs.json"
    dump.write_text(json.dumps(geofs))
    src = tmp_path / "ours.gz"
    build_airports.write_gz(build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV), str(src))
    out = io.StringIO()
    old, sys.stdout = sys.stdout, out
    try:
        assert diff_geofs.main([str(dump), "--airports", str(src), "--json"]) == 0
    finally:
        sys.stdout = old
    assert json.loads(out.getvalue())["only_geofs"] == ["ZZZZ"]


def test_every_local_module_app_imports_ships_in_the_image():
    """The build context is an allow-list (.dockerignore) and the Dockerfile COPYs by name, so a new
    server module that is imported but not shipped would only fail on the Unraid box."""
    import re
    root = os.path.join(HERE, "..", "..")
    server = os.path.join(root, "race", "server")
    with open(os.path.join(server, "app.py"), encoding="utf-8") as f:
        src = f.read()
    local = {m for m in re.findall(r"^(?:from|import) (\w+)", src, re.M)
             if os.path.isfile(os.path.join(server, m + ".py"))}
    assert {"airportdb", "migrate_modes"} <= local
    with open(os.path.join(server, "Dockerfile"), encoding="utf-8") as f:
        docker = f.read()
    with open(os.path.join(root, ".dockerignore"), encoding="utf-8") as f:
        ignore = {ln.strip() for ln in f}
    for m in local:
        assert f"race/server/{m}.py" in docker, f"{m}.py is imported by app.py but not COPYed"
        assert f"!race/server/{m}.py" in ignore, f"{m}.py is not in the .dockerignore allow-list"
    assert "COPY race/server/airports/airports.json.gz /app/airports/airports.json.gz" in docker
    assert "!race/server/airports/airports.json.gz" in ignore
