"""Offline tests for check_terrain.py's --source global (Terrarium PNG) and --source auto.

No network: tiles come from a fixture PNG built here with zlib, injected via the source's
`fetch` hook, or pre-seeded into the on-disk tile cache.
"""
import json
import math
import os
import struct
import sys
import zlib

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import check_terrain as ct  # noqa: E402


def encode_height(h):
    v = h + 32768.0
    r = int(v // 256)
    g = int(v - r * 256)
    b = int(round((v - r * 256 - g) * 256))
    return r, g, b


def make_png(pixel_fn, size=256, filters=(0, 1, 2, 3, 4), rgba=False):
    """PNG whose pixel (col, row) encodes pixel_fn(col, row) metres, cycling every filter type."""
    bpp = 4 if rgba else 3
    raw = bytearray()
    prev = bytearray(size * bpp)
    for row in range(size):
        line = bytearray()
        for col in range(size):
            line += bytes(encode_height(pixel_fn(col, row))) + (b"\xff" if rgba else b"")
        ft = filters[row % len(filters)]
        out = bytearray(len(line))
        for i in range(len(line)):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if ft == 0:
                pred = 0
            elif ft == 1:
                pred = a
            elif ft == 2:
                pred = b
            elif ft == 3:
                pred = (a + b) >> 1
            else:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
            out[i] = (line[i] - pred) & 0xFF
        raw += bytes([ft]) + out
        prev = line

    def chunk(t, body):
        return struct.pack(">I", len(body)) + t + body + struct.pack(">I", zlib.crc32(t + body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6 if rgba else 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b"")


def ramp(col, row):
    return 100.0 + col * 2.0 + row * 0.5   # linear, so bilinear sampling is exact


def test_terrarium_formula():
    assert ct.terrarium_height((128, 0, 0)) == 0.0
    assert ct.terrarium_height((0, 0, 0)) == -32768.0
    assert ct.terrarium_height((129, 44, 128)) == pytest.approx(256 + 44 + 0.5)
    for h in (-420.5, 0.0, 12.25, 8848.0):
        assert ct.terrarium_height(encode_height(h)) == pytest.approx(h, abs=1 / 256)


@pytest.mark.parametrize("rgba", [False, True])
def test_png_decoder_all_filter_types(rgba):
    rows = ct.decode_png_rgb(make_png(ramp, size=16, rgba=rgba))
    assert len(rows) == 16 and len(rows[0]) == 16
    for row in range(16):
        for col in range(16):
            assert ct.terrarium_height(rows[row][col]) == pytest.approx(ramp(col, row), abs=0.01)


def test_png_decoder_rejects_non_png_and_unsupported():
    with pytest.raises(ct.TerrainError):
        ct.decode_png_rgb(b"not a png at all")
    png = bytearray(make_png(ramp, size=4))
    png[24] = 16   # IHDR bit depth -> 16 (CRC now wrong, but the decoder doesn't check CRCs)
    with pytest.raises(ct.TerrainError):
        ct.decode_png_rgb(bytes(png))


def test_mercator_pixel_known_values():
    x, y = ct.mercator_pixel(0.0, 0.0, 0)
    assert (x, y) == pytest.approx((128.0, 128.0))
    x, y = ct.mercator_pixel(0.0, -180.0, 1)
    assert x == pytest.approx(0.0)
    # Cross-check against the OSM wiki's slippy-map formula (asinh(tan) form, not the one used).
    lat, lon, z = 45.3735, -121.6959, 12
    x, y = ct.mercator_pixel(lat, lon, z)
    n = 2 ** z
    xt = int((lon + 180.0) / 360.0 * n)
    yt = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    assert (int(x // 256), int(y // 256)) == (xt, yt) == (663, 1467)


def fixture_source(tile_fn=ramp, zoom=12):
    calls = []

    def fetch(z, x, y):
        calls.append((z, x, y))
        # Every tile is the same ramp, offset by its tile index so edges are continuous in x.
        return make_png(lambda c, r: tile_fn(c + 256 * (x % 4), r), size=256, filters=(0,))
    src = ct.TerrariumSource(zoom=zoom, fetch=fetch)
    return src, calls


def test_bilinear_is_exact_on_a_linear_ramp():
    src, calls = fixture_source()
    lat, lon = 45.3735, -121.6959
    px, py = ct.mercator_pixel(lat, lon, 12)
    col = (px - 0.5) % 256 + 256 * ((int(px // 256)) % 4)
    row = (py - 0.5) % 256
    assert src.height(lat, lon) == pytest.approx(ramp(col, row), abs=0.02)
    assert calls and all(c[0] == 12 for c in calls)


def test_tiles_are_decoded_once():
    src, calls = fixture_source()
    src.heights([(45.37, -121.69), (45.3701, -121.6901), (45.3702, -121.6902)])
    assert len(calls) == len(set(calls))


def test_bilinear_crosses_tile_edges():
    # A point on the very first pixel column needs the tile to its west.
    src, calls = fixture_source(lambda c, r: 500.0)
    n = 256 * 2 ** 12
    lon = (655 * 256 + 0.1) / n * 360.0 - 180.0
    assert src.height(45.37, lon) == pytest.approx(500.0, abs=0.01)
    assert len({(c[1]) for c in calls}) == 2


def test_tile_cache_on_disk(tmp_path):
    lat, lon = 46.0, 7.9
    px, py = ct.mercator_pixel(lat, lon, 12)
    tx, ty = int(px // 256), int(py // 256)
    tiles = tmp_path / "cache.tiles"
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            p = tiles / "12" / str(tx + dx) / f"{ty + dy}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(make_png(lambda c, r: 1234.0, size=256, filters=(0,)))
    src = ct.TerrariumSource(zoom=12, tile_dir=tiles)
    src.timeout = 0.001  # any network attempt would fail loudly
    assert src.height(lat, lon) == pytest.approx(1234.0, abs=0.01)
    assert ct.tile_dir_for(str(tmp_path / "cache.json")) == tiles
    assert ct.tile_dir_for(None) is None


def test_in_conus():
    assert ct.in_conus(45.37, -121.69)        # Mt Hood
    assert ct.in_conus(43.07, -89.40)         # Madison
    assert not ct.in_conus(22.88, -109.91)    # Cabo
    assert not ct.in_conus(46.6, 7.9)         # Lauterbrunnen
    assert not ct.in_conus(61.2, -149.9)      # Anchorage


class FakeUsgs:
    name = "usgs"

    def __init__(self, fail=False):
        self.fail = fail
        self.asked = []

    def heights(self, points, workers=1):
        self.asked.extend(points)
        if self.fail:
            raise ct.TerrainError("blocked")
        return {ct.sample_key(la, lo): 10.0 for la, lo in points}


class FakeGlobal:
    name = "global"

    def __init__(self):
        self.asked = []

    def heights(self, points, workers=1):
        self.asked.extend(points)
        return {ct.sample_key(la, lo): 20.0 for la, lo in points}


def test_auto_routes_conus_to_usgs_and_rest_to_global():
    u, g = FakeUsgs(), FakeGlobal()
    src = ct.AutoSource(u, g)
    out = src.heights([(45.37, -121.69), (46.6, 7.9)])
    assert out[ct.sample_key(45.37, -121.69)] == 10.0
    assert out[ct.sample_key(46.6, 7.9)] == 20.0
    assert u.asked == [(45.37, -121.69)] and g.asked == [(46.6, 7.9)]
    assert src.name == "auto(global+usgs)" and not src.fell_back
    assert ct.AutoSource(u, g).name == "auto"


def test_auto_falls_back_loudly_when_usgs_unreachable():
    u, g = FakeUsgs(fail=True), FakeGlobal()
    src = ct.AutoSource(u, g)
    out = src.heights([(45.37, -121.69)])
    assert out[ct.sample_key(45.37, -121.69)] == 20.0
    assert src.fell_back and "fell back" in src.name
    src.heights([(45.38, -121.69)])
    assert len(u.asked) == 1, "after one failure USGS is not retried for every course"


def test_auto_is_the_default_source_and_global_is_selectable():
    import argparse
    ns = argparse.Namespace(source="auto", cache=None, zoom=12, cesium_level=11, samples_file=None)
    assert isinstance(ct.make_source(ns), ct.AutoSource)
    ns.source = "global"
    assert isinstance(ct.make_source(ns), ct.TerrariumSource)
    ns.cache = "/tmp/x/cache.json"
    cached = ct.make_source(ns)
    assert isinstance(cached, ct.CachedSource) and cached.inner.tile_dir.name == "cache.tiles"


def test_check_course_end_to_end_with_global_fixture():
    src, _ = fixture_source(lambda c, r: 300.0)
    course = {"id": "t", "name": "t", "gates": [
        {"lat": 46.60, "lon": 7.90, "alt": 600.0, "radius": 100.0},
        {"lat": 46.62, "lon": 7.92, "alt": 600.0, "radius": 100.0}]}
    r = ct.check_course(course, src)
    assert r["status"] == "PASS" and r["worst"]["clearance_m"] == pytest.approx(300.0, abs=0.5)  # minus chord sag
    course["gates"][1]["alt"] = 350.0
    r = ct.check_course(course, src)
    assert r["status"] == "FAIL"


def test_cli_json_with_seeded_tile_cache(tmp_path, capsys, monkeypatch):
    # Run the CLI against a real course id with --source global and a pre-seeded tile cache,
    # blocking urlopen so a cache miss would error rather than hit the network.
    course = json.loads((ct.COURSES_DIR / "gorge-run.json").read_text())
    tiles = tmp_path / "c.tiles"
    need = set()
    for s in ct.route_samples(course["gates"], 250.0):
        px, py = ct.mercator_pixel(s["lat"], s["lon"], 12)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                need.add((int(px // 256) + dx, int(py // 256) + dy))
    flat = make_png(lambda c, r: 0.0, size=256, filters=(0,))
    for x, y in need:
        p = tiles / "12" / str(x) / f"{y}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(flat)

    def no_net(*a, **k):
        raise OSError("network disabled in tests")
    monkeypatch.setattr(ct.urllib.request, "urlopen", no_net)
    code = ct.main(["gorge-run", "--source", "global", "--cache", str(tmp_path / "c.json"), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert payload["source"].startswith("global")
    assert payload["courses"][0]["status"] in ("PASS", "FAIL")
    assert code in (0, 1)
    assert math.isfinite(payload["courses"][0]["worst"]["clearance_m"])
