"""Tests for race/tools/check_terrain.py.

Everything here is offline: the terrain comes from `--source file` sample tables built in the
test, and the quantized-mesh decoder is exercised against tiles this file encodes itself (the
live Cesium ion endpoint is unreachable from the machine this was written on — see the tool's
module docstring).

Run: cd race/test && python -m pytest test_check_terrain.py -q
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS = REPO_ROOT / "race" / "tools"
COURSES_DIR = REPO_ROOT / "race" / "courses"
sys.path.insert(0, str(TOOLS))

import check_terrain as ct  # noqa: E402


# --------------------------------------------------------------------------- helpers
def gate(lat, lon, alt, radius=150.0):
    return {"lat": lat, "lon": lon, "alt": alt, "radius": radius}


def samples_file(tmp_path, gates, height, step=ct.DEFAULT_STEP_M):
    """A samples table covering exactly the points the tool will ask for.

    `height` is either a number (flat terrain) or a callable (lat, lon) -> height."""
    table = {}
    for s in ct.route_samples(gates, step):
        h = height(s["lat"], s["lon"]) if callable(height) else height
        table[ct.sample_key(s["lat"], s["lon"])] = h
    p = tmp_path / "samples.json"
    p.write_text(json.dumps(table), encoding="utf-8")
    return str(p)


def run(argv):
    return ct.main(argv)


# --------------------------------------------------------------------------- geometry
def test_haversine_matches_known_distance():
    # One degree of latitude on the sphere race.js uses.
    d = ct.haversine_m((45.0, -122.0), (46.0, -122.0))
    assert abs(d - 111195) < 60


def test_interpolate_midpoint_is_halfway():
    a, b = (45.0, -122.0), (45.0, -121.0)
    mid = ct.interpolate(a, b, 0.5)
    assert abs(ct.haversine_m(a, mid) - ct.haversine_m(mid, b)) < 1.0
    assert abs(mid[0] - 45.0) < 0.01  # a great circle at this latitude bulges only slightly


def test_interpolate_coincident_points_do_not_blow_up():
    assert ct.interpolate((45.0, -122.0), (45.0, -122.0), 0.5) == (45.0, -122.0)


def test_chord_sag_is_zero_at_the_gates_and_peaks_in_the_middle():
    assert ct.chord_sag_m(40000, 0.0) == 0
    assert ct.chord_sag_m(40000, 1.0) == 0
    peak = ct.chord_sag_m(40000, 0.5)
    assert 25 < peak < 40                      # 40 km leg: d^2/8R is about 31 m
    assert ct.chord_sag_m(10000, 0.5) < 3      # and negligible over a short one


def test_route_samples_covers_every_gate_and_spaces_the_legs():
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 1000)]
    out = ct.route_samples(gates, step_m=1000)
    assert [s["gate"] for s in out if s["kind"] == "gate"] == [0, 1]
    legs = [s for s in out if s["kind"] == "leg"]
    assert legs, "a 7 km leg sampled every 1000 m should produce interior points"
    assert all(s["leg"] == (0, 1) for s in legs)
    spacing = [legs[i + 1]["along_m"] - legs[i]["along_m"] for i in range(len(legs) - 1)]
    assert all(abs(s - 1000) < 1e-6 for s in spacing)
    # Interior points never coincide with a gate, so a leg can't mask a buried gate.
    assert all(0 < s["along_m"] < ct.haversine_m((45.0, -122.0), (45.0, -121.9)) for s in legs)


def test_route_samples_leg_altitude_interpolates_between_gates():
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.5, 2000)]
    legs = [s for s in ct.route_samples(gates, step_m=5000) if s["kind"] == "leg"]
    alts = [s["alt"] for s in legs]
    assert alts == sorted(alts), "altitude should climb monotonically from gate 1 to gate 2"
    assert 1000 < alts[0] < 2000


def test_short_leg_gets_no_interior_samples():
    gates = [gate(45.0, -122.0, 1000), gate(45.0005, -122.0, 1000)]
    assert [s for s in ct.route_samples(gates, step_m=1000) if s["kind"] == "leg"] == []


# --------------------------------------------------------------------------- classification
def test_classify_levels():
    # A gate at 1000 m with a 150 m radius.
    g = dict(ct.route_samples([gate(45, -122, 1000), gate(45, -121, 1000)], 100_000)[0])
    assert ct.classify(g, 1100.0, 150.0)["level"] == "BURIED"       # under the ground
    assert ct.classify(g, 900.0, 150.0)["level"] == "CLIPPING"      # 100 m < the 150 m radius
    assert ct.classify(g, 500.0, 150.0) is None                     # fine
    # With margin == radius, CLIPPING absorbs LOW on a gate (it's the stronger statement), so
    # gate-LOW only exists when the margin you asked for is wider than the gate itself.
    assert ct.classify(g, 800.0, 300.0)["level"] == "LOW"           # clears the radius, under margin
    assert ct.classify(g, 800.0, 150.0) is None


def test_clipping_only_applies_to_gates():
    leg = [s for s in ct.route_samples([gate(45, -122, 1000), gate(45, -121.5, 1000)], 5000)
           if s["kind"] == "leg"][0]
    f = ct.classify(leg, leg["alt"] - 100, 150.0)
    assert f["level"] == "LOW", "a point between gates has no sphere to clip"


def test_low_fails_by_default_and_only_warns_with_warn_low():
    g = ct.route_samples([gate(45, -122, 1000), gate(45, -121, 1000)], 100_000)[0]
    assert ct.classify(g, 800.0, 300.0)["level"] == "LOW"
    assert ct.classify(g, 800.0, 300.0)["fails"] is True
    assert ct.classify(g, 800.0, 300.0, warn_low=True)["fails"] is False
    # BURIED and CLIPPING always fail, --warn-low or not.
    assert ct.classify(g, 1100.0, 300.0, warn_low=True)["fails"] is True
    assert ct.classify(g, 900.0, 300.0, warn_low=True)["fails"] is True


# --------------------------------------------------------------------------- the check itself
def test_flat_terrain_far_below_passes(tmp_path):
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 1000)]
    src = ct.FileSource(samples_file(tmp_path, gates, 0.0))
    r = ct.check_course({"id": "t", "name": "t", "gates": gates}, src)
    assert r["passed"] is True
    assert r["findings"] == []
    assert r["worst"]["clearance_m"] == pytest.approx(1000, abs=5)
    assert r["samples"] == len(ct.route_samples(gates))


def test_a_ridge_between_two_gates_fails_even_though_both_gates_clear(tmp_path):
    """The reason this samples legs at all: two gates can be fine with a ridge in between."""
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.5, 1000)]
    mid_lon = ct.interpolate((45.0, -122.0), (45.0, -121.5), 0.5)[1]

    def height(lat, lon):
        return 1500.0 if abs(lon - mid_lon) < 0.01 else 0.0

    src = ct.FileSource(samples_file(tmp_path, gates, height))
    r = ct.check_course({"id": "t", "name": "t", "gates": gates}, src)
    assert r["passed"] is False
    assert r["findings"], "the ridge has to show up somewhere"
    assert all(f["kind"] == "leg" for f in r["findings"]), "both gates themselves are clear"
    assert all(f["level"] == "BURIED" and f["clearance_m"] < 0 for f in r["findings"])
    # 1000 m gates under 1500 m of ridge is -500, plus the ~30 m of chord sag a 39 km leg
    # carries at its midpoint — the sag is part of the answer, not noise.
    assert r["worst"]["clearance_m"] == pytest.approx(-530, abs=5)


def test_buried_gate_is_reported_as_a_gate_with_its_number(tmp_path):
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 100), gate(45.0, -121.8, 1000)]

    def height(lat, lon):
        return 800.0 if abs(lon + 121.9) < 1e-9 else 0.0

    src = ct.FileSource(samples_file(tmp_path, gates, height))
    r = ct.check_course({"id": "t", "name": "t", "gates": gates}, src)
    buried = [f for f in r["findings"] if f["kind"] == "gate"]
    assert len(buried) == 1 and buried[0]["gate"] == 1
    assert "gate 2" in ct.describe(buried[0])          # reported 1-based, as the panel numbers them


def test_margin_is_what_decides_a_low_pass(tmp_path):
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 1000)]
    src = ct.FileSource(samples_file(tmp_path, gates, 800.0))   # 200 m of clearance
    course = {"id": "t", "name": "t", "gates": gates}
    assert ct.check_course(course, src, margin_m=150.0)["passed"] is True
    assert ct.check_course(course, src, margin_m=300.0)["passed"] is False


def test_missing_sample_is_an_error_not_a_pass(tmp_path):
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 1000)]
    path = tmp_path / "sparse.json"
    path.write_text(json.dumps({ct.sample_key(45.0, -122.0): 0.0}), encoding="utf-8")
    with pytest.raises(ct.TerrainError, match="missing"):
        ct.check_course({"id": "t", "name": "t", "gates": gates}, ct.FileSource(str(path)))


def test_file_source_rejects_junk(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    with pytest.raises(ct.TerrainError, match="not valid JSON"):
        ct.FileSource(str(bad))
    listy = tmp_path / "list.json"
    listy.write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(ct.TerrainError, match="must be an object"):
        ct.FileSource(str(listy))
    with pytest.raises(ct.TerrainError, match="does not exist"):
        ct.FileSource(str(tmp_path / "nope.json"))


# --------------------------------------------------------------------------- real courses / CLI
def test_the_three_hand_authored_courses_load_and_sample(tmp_path):
    """No network: just that the real course files parse and produce a sane sample route."""
    for cid in ct.DEFAULT_COURSE_IDS:
        course = ct.load_course(cid)
        assert len(course["gates"]) >= 2
        samples = ct.route_samples(course["gates"])
        assert len(samples) > len(course["gates"]), f"{cid} should have interior leg samples"
        assert all(-90 <= s["lat"] <= 90 and -180 <= s["lon"] <= 180 for s in samples)


def test_load_course_rejects_a_missing_or_malformed_course(tmp_path):
    with pytest.raises(ct.TerrainError, match="no such course"):
        ct.load_course("not-a-course")


def test_the_tool_never_writes_the_course_files(tmp_path, capsys):
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in COURSES_DIR.glob("*.json")}
    gates = ct.load_course("gorge-run")["gates"]
    argv = ["gorge-run", "--source", "file", "--samples-file", samples_file(tmp_path, gates, 0.0)]
    assert run(argv) == 0
    after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in COURSES_DIR.glob("*.json")}
    assert before == after, "check_terrain.py must be read-only with respect to race/courses/"


def test_cli_exit_codes_and_report(tmp_path, capsys):
    gates = ct.load_course("gorge-run")["gates"]
    ok_file = samples_file(tmp_path, gates, 0.0)
    assert run(["gorge-run", "--source", "file", "--samples-file", ok_file]) == 0
    out = capsys.readouterr().out
    assert "PASS" in out and "1/1 courses pass" in out

    # Terrain above the whole route: every sample buried, exit 1.
    high = samples_file(tmp_path, gates, 9000.0)
    assert run(["gorge-run", "--source", "file", "--samples-file", high]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out and "BURIED" in out and "failed: gorge-run" in out

    # A source that can't answer: exit 2, with a reason.
    assert run(["gorge-run", "--source", "file", "--samples-file", str(tmp_path / "nope.json")]) == 2
    assert "error:" in capsys.readouterr().err

    assert run(["gorge-run", "--source", "file", "--samples-file", ok_file, "--step", "0"]) == 2
    assert "--step must be positive" in capsys.readouterr().err


def test_cli_json_output_is_machine_readable(tmp_path, capsys):
    gates = ct.load_course("crater-rim")["gates"]
    argv = ["crater-rim", "--source", "file", "--samples-file", samples_file(tmp_path, gates, 0.0), "--json"]
    assert run(argv) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["source"] == "file"
    assert payload["margin_m"] == ct.DEFAULT_MARGIN_M
    assert len(payload["courses"]) == 1
    c = payload["courses"][0]
    assert c["id"] == "crater-rim" and c["passed"] is True and c["findings"] == []
    assert c["length_m"] > 0 and c["samples"] > c["gates"]


def test_max_findings_truncates_the_listing(tmp_path, capsys):
    gates = ct.load_course("gorge-run")["gates"]
    high = samples_file(tmp_path, gates, 9000.0)
    run(["gorge-run", "--source", "file", "--samples-file", high, "--max-findings", "3"])
    out = capsys.readouterr().out
    assert out.count("BURIED") == 3 and "more" in out


def test_cached_source_only_fetches_what_it_is_missing(tmp_path):
    """The cache is the one file this tool writes, so it gets its own test."""
    class Counting:
        name = "counting"

        def __init__(self):
            self.calls = []

        def heights(self, points, workers=1):
            self.calls.append(len(points))
            return {ct.sample_key(la, lo): 0.0 for la, lo in points}

    inner = Counting()
    cache = tmp_path / "cache.json"
    src = ct.CachedSource(inner, str(cache))
    pts = [(45.0, -122.0), (45.1, -122.1)]
    assert src.heights(pts) == {ct.sample_key(*p): 0.0 for p in pts}
    assert inner.calls == [2] and cache.exists()

    src2 = ct.CachedSource(inner, str(cache))
    assert src2.heights(pts)          # served entirely from the file written above
    assert inner.calls == [2], "a warm cache must not re-fetch"
    assert src2.hits == 2 and src2.fetched == 0

    src2.heights(pts + [(46.0, -123.0)])
    assert inner.calls == [2, 1], "only the new point is fetched"

    cache.write_text("{ corrupt", encoding="utf-8")
    assert ct.CachedSource(inner, str(cache)).table == {}, "a corrupt cache is a miss, not a crash"


def test_cesium_source_without_a_token_says_so(monkeypatch):
    monkeypatch.delenv("CESIUM_ION_TOKEN", raising=False)
    with pytest.raises(ct.TerrainError, match="CESIUM_ION_TOKEN"):
        ct.CesiumSource()


# --------------------------------------------------------------------------- quantized mesh
def _zigzag(values):
    """Encode absolute values as the zigzag deltas a quantized-mesh tile stores."""
    out, prev = [], 0
    for v in values:
        d = v - prev
        out.append((d << 1) ^ (d >> 15) if d >= 0 else ((-d) << 1) - 1)
        prev = v
    return out


def _tile(us, vs, hs, triangles, min_h, max_h):
    """Build a quantized-mesh 1.0 tile: 88-byte header, zigzag vertices, high-water indices."""
    body = bytearray()
    body += struct.pack("<3d", 0.0, 0.0, 0.0)            # center
    body += struct.pack("<ff", min_h, max_h)             # min/max height
    body += struct.pack("<4d", 0.0, 0.0, 0.0, 1.0)       # bounding sphere
    body += struct.pack("<3d", 0.0, 0.0, 0.0)            # horizon occlusion point
    assert len(body) == ct.QM_HEADER_BYTES
    body += struct.pack("<I", len(us))
    for arr in (us, vs, hs):
        body += struct.pack(f"<{len(arr)}H", *_zigzag(arr))
    # High-water-mark encode the indices.
    codes, highest = [], 0
    for tri in triangles:
        for idx in tri:
            codes.append(highest - idx)
            if highest - idx == 0:
                highest += 1
    if len(body) % 2:
        body += b"\x00"
    body += struct.pack("<I", len(triangles))
    body += struct.pack(f"<{len(codes)}H", *codes)
    return bytes(body)


def test_decode_quantized_mesh_round_trips_a_synthetic_tile():
    us, vs, hs = [0, 32767, 0, 32767], [0, 0, 32767, 32767], [0, 16383, 16383, 32767]
    tile = _tile(us, vs, hs, [(0, 1, 2), (1, 3, 2)], 0.0, 1000.0)
    min_h, max_h, dus, dvs, dhs, tris = ct.decode_quantized_mesh(tile)
    assert (min_h, max_h) == (0.0, 1000.0)
    assert dus == us and dvs == vs and dhs == hs
    assert tris == [(0, 1, 2), (1, 3, 2)]


def test_height_in_tile_interpolates_and_reports_outside():
    us, vs, hs = [0, 32767, 0, 32767], [0, 0, 32767, 32767], [0, 16383, 16383, 32767]
    decoded = ct.decode_quantized_mesh(_tile(us, vs, hs, [(0, 1, 2), (1, 3, 2)], 0.0, 1000.0))
    assert ct.height_in_tile(0, 0, decoded) == pytest.approx(0.0, abs=1)
    assert ct.height_in_tile(32767, 32767, decoded) == pytest.approx(1000.0, abs=1)
    assert ct.height_in_tile(16383, 16383, decoded) == pytest.approx(500.0, abs=2)
    assert ct.height_in_tile(-5000, -5000, decoded) is None     # off the tile


def test_decode_rejects_a_truncated_tile():
    with pytest.raises(ct.TerrainError, match="too short"):
        ct.decode_quantized_mesh(b"\x00" * 40)


def test_tile_xy_matches_cesiums_geographic_tiling_scheme():
    # Level 0 is 2x1 tiles: west hemisphere is x=0, east is x=1, single row.
    assert ct.tile_xy(0.0, -90.0, 0) == (0, 0)
    assert ct.tile_xy(0.0, 90.0, 0) == (1, 0)
    # y counts from the north pole down.
    assert ct.tile_xy(80.0, 0.0, 2)[1] < ct.tile_xy(-80.0, 0.0, 2)[1]


def test_tile_uv_spans_the_tile_south_to_north():
    level = 8
    lat, lon = 45.5, -122.0
    x, y = ct.tile_xy(lat, lon, level)
    u, v = ct.tile_uv(lat, lon, level, x, y)
    assert 0 <= u <= ct.QM_MAX and 0 <= v <= ct.QM_MAX
    # A point further north in the same tile has a larger v.
    u2, v2 = ct.tile_uv(lat + 0.1, lon, level, x, y)
    assert v2 > v
