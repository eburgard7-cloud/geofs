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
import math
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


# --------------------------------------------------------------------------- no-data / UNVERIFIED
def test_classify_reports_no_data_as_unverified_never_pass():
    g = ct.route_samples([gate(45, -122, 1000), gate(45, -121, 1000)], 100_000)[0]
    f = ct.classify(g, ct.NO_DATA, 150.0)
    assert f["level"] == "UNVERIFIED"
    assert f["fails"] is False        # a lone unverified sample must not fail the course...
    assert f["unverified"] is True    # ...but it must be reported, not silently dropped


def test_file_source_null_means_no_data_not_missing(tmp_path):
    """A samples file can assert 'no coverage here' with a JSON null, distinct from a key
    that's simply absent (still a hard error -- see test_missing_sample_is_an_error_not_a_pass)."""
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 1000)]
    table = {ct.sample_key(s["lat"], s["lon"]): None for s in ct.route_samples(gates)}
    path = tmp_path / "null_samples.json"
    path.write_text(json.dumps(table), encoding="utf-8")
    heights = ct.FileSource(str(path)).heights([(g["lat"], g["lon"]) for g in gates])
    assert all(v is ct.NO_DATA for v in heights.values())


def test_check_course_with_a_no_data_sample_is_unverified_not_passed(tmp_path):
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 1000)]
    samples = ct.route_samples(gates)
    table = {ct.sample_key(s["lat"], s["lon"]): 0.0 for s in samples}
    # Knock out one interior leg sample -- everything else clears easily.
    knocked = samples[len(samples) // 2]
    table[ct.sample_key(knocked["lat"], knocked["lon"])] = None
    path = tmp_path / "partial.json"
    path.write_text(json.dumps(table), encoding="utf-8")

    r = ct.check_course({"id": "t", "name": "t", "gates": gates}, ct.FileSource(str(path)))
    assert r["status"] == "UNVERIFIED"
    assert r["passed"] is False                     # never reported as a silent PASS
    assert r["unverified"] == 1
    assert any(f["level"] == "UNVERIFIED" for f in r["findings"])
    assert not any(f["fails"] for f in r["findings"])  # nothing else actually failed
    assert r["worst"] is not None                    # still computed from the real samples


def test_a_course_entirely_without_data_has_no_worst_and_still_reports(tmp_path):
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.9, 1000)]
    table = {ct.sample_key(s["lat"], s["lon"]): None for s in ct.route_samples(gates)}
    path = tmp_path / "all_null.json"
    path.write_text(json.dumps(table), encoding="utf-8")

    r = ct.check_course({"id": "t", "name": "t", "gates": gates}, ct.FileSource(str(path)))
    assert r["status"] == "UNVERIFIED"
    assert r["passed"] is False
    assert r["worst"] is None
    assert r["unverified"] == len(ct.route_samples(gates))


def test_unverified_never_masks_a_real_failure(tmp_path):
    """A genuine BURIED finding must still fail the course even if some other sample on the
    same route has no data -- FAIL outranks UNVERIFIED."""
    gates = [gate(45.0, -122.0, 1000), gate(45.0, -121.5, 1000)]
    mid_lon = ct.interpolate((45.0, -122.0), (45.0, -121.5), 0.5)[1]

    def height(lat, lon):
        return 1500.0 if abs(lon - mid_lon) < 0.01 else 0.0

    samples = ct.route_samples(gates)
    table = {ct.sample_key(s["lat"], s["lon"]): height(s["lat"], s["lon"]) for s in samples}
    table[ct.sample_key(samples[-1]["lat"], samples[-1]["lon"])] = None
    path = tmp_path / "mixed.json"
    path.write_text(json.dumps(table), encoding="utf-8")

    r = ct.check_course({"id": "t", "name": "t", "gates": gates}, ct.FileSource(str(path)))
    assert r["status"] == "FAIL"
    assert r["passed"] is False
    assert any(f["level"] == "UNVERIFIED" for f in r["findings"])
    assert any(f["level"] == "BURIED" and f["fails"] for f in r["findings"])


def test_cached_source_round_trips_no_data_through_the_json_cache(tmp_path):
    class Fake:
        name = "fake"

        def heights(self, points, workers=1):
            return {ct.sample_key(la, lo): ct.NO_DATA for la, lo in points}

    cache = tmp_path / "cache.json"
    src = ct.CachedSource(Fake(), str(cache))
    pt = (45.0, -122.0)
    assert src.heights([pt]) == {ct.sample_key(*pt): ct.NO_DATA}
    assert json.loads(cache.read_text()) == {ct.sample_key(*pt): None}

    src2 = ct.CachedSource(Fake(), str(cache))
    assert src2.table[ct.sample_key(*pt)] is ct.NO_DATA
    assert src2.heights([pt]) == {ct.sample_key(*pt): ct.NO_DATA}


def test_usgs_source_treats_out_of_coverage_responses_as_no_data(monkeypatch):
    """Live USGS epqs responses for out-of-coverage points, observed by hand: a non-JSON
    plain-text body with an HTTP 200 (wording varies -- open ocean vs. off the raster
    entirely), or valid JSON with `value` null, or (per USGS's own docs) a large-magnitude
    negative sentinel. None of these are a network failure, so none should raise or be
    treated as an error -- only an actual URLError/timeout should be."""
    bodies = {
        "call-failed": b"Call failed.  [Failed cloud operation: Open, Path: /vsimem/x.aux.xml]",
        "invalid-params": b"Invalid or missing input parameters.",
        "empty-geometry": b"The operation was attempted on an empty geometry.",
        "json-null": json.dumps({"value": None}).encode(),
        "json-sentinel": json.dumps({"value": "-1000000.000000000"}).encode(),
    }

    class FakeResponse:
        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    src = ct.UsgsSource()
    for label, body in bodies.items():
        monkeypatch.setattr(ct.urllib.request, "urlopen", lambda req, timeout=None, b=body: FakeResponse(b))
        key, value, err = src._one((22.876, -109.92))
        assert err is None, f"{label}: should not be a hard error"
        assert value is ct.NO_DATA, f"{label}: should resolve to NO_DATA"

    # A real elevation still comes through untouched.
    monkeypatch.setattr(ct.urllib.request, "urlopen",
                         lambda req, timeout=None: FakeResponse(json.dumps({"value": "271.5"}).encode()))
    key, value, err = src._one((43.6, -89.79))
    assert err is None and value == pytest.approx(271.5)

    # An actual network failure is still a hard error, not "no data".
    def raise_it(req, timeout=None):
        raise ct.urllib.error.URLError("boom")
    monkeypatch.setattr(ct.urllib.request, "urlopen", raise_it)
    key, value, err = src._one((45.0, -122.0))
    assert value is None and err is not None


def test_cli_reports_unverified_without_crashing_or_a_bad_exit_code(tmp_path, capsys):
    gates = ct.load_course("gorge-run")["gates"]
    table = {ct.sample_key(s["lat"], s["lon"]): 0.0 for s in ct.route_samples(gates)}
    some_key = next(iter(table))
    table[some_key] = None
    path = tmp_path / "partial.json"
    path.write_text(json.dumps(table), encoding="utf-8")

    exit_code = run(["gorge-run", "--source", "file", "--samples-file", str(path)])
    assert exit_code == 1                         # not-fully-verified, but not a crash (2)
    out = capsys.readouterr().out
    assert "UNVERIFIED" in out
    assert "unverified: gorge-run" in out


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


# --------------------------------------------------------------------------- --approach (runways)
RWY = {"id": "test-rwy", "name": "Test 16", "thr_lat": 47.0, "thr_lon": -122.0, "thr_alt_m": 100.0,
       "heading_deg": 160.0, "length_m": 2000.0, "width_m": 45.0}


def approach_file(tmp_path, runway, height, step=ct.APPROACH_STEP_M):
    table = {}
    for s in ct.approach_samples(runway, step):
        table[ct.sample_key(s["lat"], s["lon"])] = height(s) if callable(height) else height
    p = tmp_path / "appr.json"
    p.write_text(json.dumps(table), encoding="utf-8")
    return ct.FileSource(str(p))


def test_destination_round_trips_haversine():
    lat, lon = ct.destination(47.0, -122.0, 90.0, 5000.0)
    assert abs(ct.haversine_m((47.0, -122.0), (lat, lon)) - 5000.0) < 0.01


def test_approach_samples_follow_the_glidepath_out_to_the_spawn_and_beyond():
    s = ct.approach_samples(RWY)
    path = [x for x in s if x["kind"] == "path"]
    spawn = [x for x in s if x["kind"] == "spawn"]
    beyond = [x for x in s if x["kind"] == "beyond"]
    assert len(spawn) == 1 and abs(spawn[0]["dist_m"] - 5556.0) < 1e-9
    assert max(x["dist_m"] for x in path) <= 5556.0 < min(x["dist_m"] for x in beyond)
    assert max(x["dist_m"] for x in beyond) <= 5 * 1852.0 + 1e-6
    p = path[9]   # 1000 m out
    assert abs(p["alt"] - (100 + 15 + 1000 * math.tan(math.radians(3)))) < 1e-9
    # Behind the threshold: bearing from the point to the threshold is the runway heading.
    assert abs(ct.haversine_m((RWY["thr_lat"], RWY["thr_lon"]), (p["lat"], p["lon"])) - 1000.0) < 0.01


def test_approach_geometry_applies_the_override_the_same_way_race_js_does():
    rw = {**RWY, "approach": {"distNm": 1.5, "angleDeg": 5, "headingOffsetDeg": -20, "altOffsetM": 40}}
    assert ct.approach_geometry(rw) == (1.5 * 1852.0, 5, -20, 40)
    s = ct.approach_samples(rw)
    spawn = next(x for x in s if x["kind"] == "spawn")
    assert abs(spawn["alt"] - (115 + 1.5 * 1852 * math.tan(math.radians(5)) + 40)) < 1e-9
    # Swung -20 deg: the spawn lies on bearing heading+offset+180 from the threshold.
    lat, lon = ct.destination(RWY["thr_lat"], RWY["thr_lon"], (160 - 20 + 180) % 360, 1.5 * 1852)
    assert abs(lat - spawn["lat"]) < 1e-12 and abs(lon - spawn["lon"]) < 1e-12


def test_required_clearance_is_the_margin_or_half_the_path_height():
    assert ct.required_clearance_m(5000, 3, 60) == 60
    h = 15 + 1000 * math.tan(math.radians(3))
    assert abs(ct.required_clearance_m(1000, 3, 60) - h / 2) < 1e-9


def test_a_flat_field_passes(tmp_path):
    r = ct.check_approach(RWY, approach_file(tmp_path, RWY, 100.0))
    assert r["status"] == "PASS" and not r["findings"] and r["suggest_angle_deg"] is None
    assert r["spawn"]["clearance_m"] > 300


def test_a_ridge_on_the_flown_path_fails_and_suggests_the_angle_that_clears_it(tmp_path):
    ridge = lambda s: 300.0 if 2900 < s["dist_m"] < 3200 else 100.0  # noqa: E731
    r = ct.check_approach(RWY, approach_file(tmp_path, RWY, ridge))
    assert r["status"] == "FAIL" and r["findings"]
    assert 2900 < r["worst"]["dist_m"] < 3200
    a = r["suggest_angle_deg"]
    assert a > 3 and not r["custom_path_needed"]
    # That angle really does clear it by the margin everywhere.
    steep = {**RWY, "approach": {"angleDeg": a}}
    assert ct.check_approach(steep, approach_file(tmp_path, steep, ridge))["status"] == "PASS"


def test_terrain_beyond_the_spawn_or_inside_short_final_never_fails(tmp_path):
    def h(s):
        if s["dist_m"] > 5556 and s["kind"] == "beyond":
            return 2000.0   # a mountain past the spawn: nobody flies there
        if s["dist_m"] <= 900:
            return 140.0    # a cliff at the threshold (Lukla): the runway environment
        return 100.0
    r = ct.check_approach(RWY, approach_file(tmp_path, RWY, h))
    assert r["status"] == "PASS"
    assert r["worst_beyond_spawn"]["short_m"] > 0 and r["worst_short_final"]["clearance_m"] < 0


def test_a_buried_spawn_is_spawn_low(tmp_path):
    r = ct.check_approach(RWY, approach_file(tmp_path, RWY, lambda s: 500.0 if s["kind"] == "spawn" else 100.0))
    assert r["status"] == "FAIL" and r["spawn_low"]


def test_min_clearing_angle_needs_a_custom_path_past_the_cap():
    pts = [(1500.0, 100.0 + 400.0)]
    a = ct.min_clearing_angle_deg(RWY, pts, 60.0)
    assert a > ct.APPROACH_MAX_SUGGEST_DEG
    assert ct.min_clearing_angle_deg(RWY, [(500.0, 5000.0)], 60.0) == 3.0, "short-final points are ignored"


def test_every_checked_in_runway_has_a_well_formed_approach_block():
    for rid in ct.all_runway_ids():
        rw = ct.load_runway(rid)
        ap = rw.get("approach")
        if ap is not None:
            dist, angle, off, alt = ct.approach_geometry(rw)
            assert 0.5 * 1852 <= dist <= 10 * 1852 and 2 <= angle <= 8 and -90 <= off <= 90, rid
            assert "PROVISIONAL" in rw["notes"] or "confirmed" in rw["notes"].lower(), rid


def test_approach_cli_on_named_runways_with_a_file_source(tmp_path, capsys):
    rw_ids = ["sea-tac-16c"]
    rw = ct.load_runway("sea-tac-16c")
    table = {ct.sample_key(s["lat"], s["lon"]): rw["thr_alt_m"] for s in ct.approach_samples(rw)}
    p = tmp_path / "t.json"
    p.write_text(json.dumps(table), encoding="utf-8")
    assert ct.main(["--approach", *rw_ids, "--source", "file", "--samples-file", str(p)]) == 0
    out = capsys.readouterr().out
    assert "sea-tac-16c" in out and "1/1 approaches clear" in out
    assert ct.main(["--approach", "sea-tac-16c", "--source", "file", "--samples-file", str(p), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["runways"][0]["status"] == "PASS" and data["margin_m"] == ct.APPROACH_MARGIN_M
    assert ct.main(["--approach", "no-such-runway", "--source", "file", "--samples-file", str(p)]) == 2
