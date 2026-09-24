"""Tests for race/tools/add_runway.py (offline: fixture OurAirports CSVs) and for the committed
race/runways/*.json set (every file loads through app.py and hashes stably)."""
import csv
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
import add_runway as ar  # noqa: E402

RUNWAY_COLS = ["id", "airport_ref", "airport_ident", "length_ft", "width_ft", "surface", "lighted", "closed",
               "le_ident", "le_latitude_deg", "le_longitude_deg", "le_elevation_ft", "le_heading_degT",
               "le_displaced_threshold_ft", "he_ident", "he_latitude_deg", "he_longitude_deg", "he_elevation_ft",
               "he_heading_degT", "he_displaced_threshold_ft"]
AIRPORT_COLS = ["id", "ident", "type", "name", "latitude_deg", "longitude_deg", "elevation_ft", "continent",
                "iso_country", "iso_region", "municipality", "scheduled_service", "icao_code", "iata_code",
                "gps_code", "local_code", "home_link", "wikipedia_link", "keywords"]


@pytest.fixture
def csv_dir(tmp_path):
    rows = [
        # A normal runway with a displaced threshold on the 10 end.
        dict(airport_ident="TEST", length_ft="8000", width_ft="150", surface="ASP", closed="0",
             le_ident="10", le_latitude_deg="45.0", le_longitude_deg="-122.0", le_elevation_ft="100",
             le_heading_degT="90", le_displaced_threshold_ft="1000",
             he_ident="28", he_latitude_deg="45.0", he_longitude_deg="-121.969", he_elevation_ft="110",
             he_heading_degT="270", he_displaced_threshold_ft=""),
        # Missing coordinates + elevation + heading on one end.
        dict(airport_ident="TEST", length_ft="2000", width_ft="60", surface="GRS", closed="0",
             le_ident="04", le_latitude_deg="", le_longitude_deg="", le_elevation_ft="",
             le_heading_degT="", le_displaced_threshold_ft="",
             he_ident="22", he_latitude_deg="45.01", he_longitude_deg="-122.0", he_elevation_ft="",
             he_heading_degT="225", he_displaced_threshold_ft=""),
        dict(airport_ident="TEST", length_ft="3000", width_ft="75", surface="ASP", closed="1",
             le_ident="18", le_latitude_deg="45.02", le_longitude_deg="-122.0", le_elevation_ft="100",
             le_heading_degT="180", le_displaced_threshold_ft="",
             he_ident="36", he_latitude_deg="45.01", he_longitude_deg="-122.0", he_elevation_ft="100",
             he_heading_degT="0", he_displaced_threshold_ft=""),
    ]
    with open(tmp_path / "runways.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, RUNWAY_COLS)
        w.writeheader()
        for i, r in enumerate(rows):
            w.writerow({**{c: "" for c in RUNWAY_COLS}, **r, "id": i})
    with open(tmp_path / "airports.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, AIRPORT_COLS)
        w.writeheader()
        w.writerow({**{c: "" for c in AIRPORT_COLS}, "ident": "TEST", "name": "Test Field", "elevation_ft": "105",
                    "icao_code": "TEST", "type": "small_airport"})
    return tmp_path


def build(csv_dir, end, **kw):
    ap = ar.find_airport(csv_dir, "TEST")
    row, p, o = ar.find_runway(csv_dir, "TEST", end)
    return ar.build_runway(ap, row, p, o, end, **kw)


def test_normal_end_with_displaced_threshold(csv_dir):
    rw = build(csv_dir, "10")
    assert rw["id"] == "test-10" and rw["version"] == 1
    assert rw["heading_deg"] == 90.0
    assert rw["thr_alt_m"] == pytest.approx(100 * 0.3048, abs=0.1)
    assert rw["length_m"] == pytest.approx(7000 * 0.3048, abs=0.1)     # landing distance available
    assert rw["width_m"] == pytest.approx(150 * 0.3048, abs=0.1)
    # Threshold moved ~305 m east of the runway end.
    assert rw["thr_lat"] == pytest.approx(45.0, abs=1e-5)
    east_m = (rw["thr_lon"] + 122.0) * 111320 * 0.7071
    assert east_m == pytest.approx(304.8, abs=2)
    assert "displaced 1000 ft" in rw["notes"]
    assert rw["zone"] == ar.default_zone(rw["length_m"])


def test_other_end_and_names_and_notes(csv_dir):
    rw = build(csv_dir, "28", name="Custom 28", notes="Hello")
    assert rw["name"] == "Custom 28" and rw["notes"].startswith("Hello.")
    assert rw["heading_deg"] == 270.0 and rw["length_m"] == pytest.approx(8000 * 0.3048, abs=0.1)


def test_missing_end_is_an_error_unless_derived(csv_dir):
    with pytest.raises(ar.RunwayError, match="no coordinates"):
        build(csv_dir, "04")
    rw = build(csv_dir, "04", derive_missing_end=True)
    assert "derived" in rw["notes"] and "airport elevation" in rw["notes"]
    assert rw["thr_alt_m"] == pytest.approx(105 * 0.3048, abs=0.1)
    # Derived end is length_ft back along 225 deg from the 22 end: south-west of it.
    assert rw["thr_lat"] < 45.01 and rw["thr_lon"] < -122.0
    assert rw["heading_deg"] == pytest.approx(45.0, abs=0.5)   # computed from the two ends


def test_heading_that_contradicts_the_end_coordinates_is_replaced(csv_dir):
    ap = ar.find_airport(csv_dir, "TEST")
    row, p, o = ar.find_runway(csv_dir, "TEST", "10")
    row = dict(row, le_heading_degT="270")          # reciprocal typo, like OurAirports' PATK 1
    rw = ar.build_runway(ap, row, p, o, "10")
    assert rw["heading_deg"] == pytest.approx(90.0, abs=0.5) and "disagrees" in rw["notes"]


def test_missing_elevation_falls_back_to_airport(csv_dir):
    rw = build(csv_dir, "22")
    assert rw["thr_alt_m"] == pytest.approx(105 * 0.3048, abs=0.1)
    assert "airport elevation" in rw["notes"]


def test_end_idents_ignore_leading_zeros_and_local_codes_resolve(csv_dir):
    ap = ar.find_airport(csv_dir, "TEST")
    row, p, _ = ar.find_runway(csv_dir, "TEST", "4")
    assert row[p + "ident"] == "04"
    import csv as _csv
    rows = list(_csv.DictReader(open(csv_dir / "airports.csv", encoding="utf-8")))
    rows[0]["local_code"] = "T3S"
    with open(csv_dir / "airports.csv", "w", newline="", encoding="utf-8") as f:
        w = _csv.DictWriter(f, AIRPORT_COLS)
        w.writeheader()
        w.writerows(rows)
    assert ar.find_airport(csv_dir, "T3S")["ident"] == ap["ident"]


def test_closed_and_unknown_ends_are_errors(csv_dir):
    with pytest.raises(ar.RunwayError, match="closed"):
        build(csv_dir, "18")
    with pytest.raises(ar.RunwayError, match="no runway end"):
        build(csv_dir, "99")
    with pytest.raises(ar.RunwayError, match="not found"):
        ar.find_airport(csv_dir, "NOPE")


def test_default_zone_rule():
    assert ar.default_zone(3627) == {"min_m": 362.7, "max_m": 450.0}
    assert ar.default_zone(100) == {"min_m": 60.0, "max_m": 120.0}
    assert ar.default_zone(8000) == {"min_m": 390.0, "max_m": 450.0}
    z = ar.default_zone(1000)
    assert z == {"min_m": 100.0, "max_m": 300.0}


def test_write_runway_updates_sorted_index_and_refuses_geometry_change(csv_dir, tmp_path):
    out = tmp_path / "runways"
    out.mkdir()
    (out / "index.json").write_text(json.dumps([{"id": "zzz", "name": "Z", "file": "zzz.json"}]))
    rw = build(csv_dir, "10")
    ar.write_runway(rw, out)
    idx = json.loads((out / "index.json").read_text())
    assert [e["id"] for e in idx] == ["test-10", "zzz"]
    ar.write_runway(dict(rw, notes="notes only"), out)            # notes-only change is fine
    moved = dict(rw, thr_lat=rw["thr_lat"] + 0.001)
    with pytest.raises(ar.RunwayError, match="different geometry"):
        ar.write_runway(moved, out)
    ar.write_runway(moved, out, force=True)
    assert json.loads((out / "test-10.json").read_text())["thr_lat"] == moved["thr_lat"]
    assert len(json.loads((out / "index.json").read_text())) == 2


def test_validate_rejects_bad_runways(csv_dir):
    rw = build(csv_dir, "10")
    for bad in (dict(rw, id="Bad"), dict(rw, version=0), dict(rw, heading_deg=-1),
                dict(rw, zone={"min_m": 10, "max_m": 5}), dict(rw, width_m=1)):
        with pytest.raises(ar.RunwayError):
            ar.validate(bad)


def test_cli_dry_run_writes_nothing(csv_dir, capsys, monkeypatch, tmp_path):
    monkeypatch.setattr(ar, "RUNWAYS_DIR", tmp_path / "rw")
    assert ar.main(["TEST", "10", "--csv-dir", str(csv_dir), "--dry-run"]) == 0
    assert json.loads(capsys.readouterr().out)["id"] == "test-10"
    assert not (tmp_path / "rw").exists()
    assert ar.main(["TEST", "04", "--csv-dir", str(csv_dir), "--dry-run"]) == 1


# ------------------------------------------------------------ the committed runway pack
RUNWAYS_DIR = os.path.join(HERE, "..", "runways")

# Board keys (runway_hash = id+version). If one of these changes, that runway's landing board
# silently resets — change it only on purpose (a version bump) and update this table.
PINNED_HASHES = {
    "friday-harbor-16": "d6821741", "kase-15": "faeeb0f2", "keug-16r": "56a4cce7", "kmsn-36": "e31278f5",
    "kpdx-10r": "498e8c2d", "ktex-09": "e7d9ad31", "lflj-22": "7c774965", "lowi-26": "9a9fc594",
    "lpma-05": "958c06bb", "lxgb-09": "32af9b32", "mmsd-34": "2f011cd7", "nzqn-05": "09397321",
    "sea-tac-16c": "5d1e5d16", "sisters-eagle-air-34": "5e8783ab", "tffj-10": "195da6c7",
    "tncm-10": "0e949a1a", "tncs-12": "5aa26d38", "vnlk-06": "4e220fe6", "vqpr-15": "04235005",
    "3u2-17": "f6eeeceb", "3u2-35": "5b63ae0a", "pamr-26": "688fa2bc", "patk-01": "13d167ef", "s10-02": "75ff3810",
    "s81-04": "8e84e1f3", "s81-22": "34d43343",
}


def test_every_committed_runway_loads_and_hashes_stably():
    import app as appmod
    loaded = appmod.load_runways(RUNWAYS_DIR)
    assert set(loaded) == set(PINNED_HASHES)
    for rid, rw in loaded.items():
        assert appmod.runway_hash(rw) == PINNED_HASHES[rid], rid
        assert ar.validate(dict(rw)) == rw
        assert appmod.validate_runway(rw) is rw
    with open(os.path.join(RUNWAYS_DIR, "index.json"), encoding="utf-8") as f:
        idx = json.load(f)
    ids = [e["id"] for e in idx]
    assert ids == sorted(ids) and len(ids) == len(set(ids))
    on_disk = {f[:-5] for f in os.listdir(RUNWAYS_DIR) if f.endswith(".json") and f != "index.json"}
    assert on_disk == set(ids)


def test_landing_cups_doc_lists_every_new_runway():
    with open(os.path.join(RUNWAYS_DIR, "LANDING_CUPS.md"), encoding="utf-8") as f:
        doc = f.read()
    for rid in PINNED_HASHES:
        if rid not in ("friday-harbor-16", "sea-tac-16c", "sisters-eagle-air-34"):
            assert f"`{rid}`" in doc, rid
