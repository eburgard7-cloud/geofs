"""Outputs: native size and format, under the 1.5 MB cap, deterministic, reproducible."""
import io

import numpy as np
import pytest
from PIL import Image

import livery_common as lc
import livery_factory as F

SPECS = [s for _, s in F.load_specs()]


PIL_FORMAT = {"webp": "WEBP", "png": "PNG", "jpg": "JPEG"}


def _expect(spec, path):
    """Native size and format of the aircraft's LiverySelector slot (lc.AIRCRAFT)."""
    ac = lc.AIRCRAFT[spec["aircraft"]]
    if spec["aircraft"] == "rafale" and path.name.endswith("_spec.webp"):
        return (ac["spec_size"],) * 2, "WEBP"
    return (ac["size"],) * 2, PIL_FORMAT[ac["fmt"]]


@pytest.mark.parametrize("spec", SPECS, ids=[s["id"] for s in SPECS])
def test_output_native_size_format_and_cap(spec):
    for path in F.out_paths(spec):
        assert path.is_file(), f"{path} not built (python tools/livery_factory.py --all)"
        assert path.stat().st_size <= lc.MAX_BYTES, f"{path.name} over 1.5 MB"
        im = Image.open(path)
        size, fmt = _expect(spec, path)
        assert im.size == size and im.format == fmt, (path.name, im.size, im.format)


MAPPED = [ac for ac in lc.AIRCRAFT if (lc.UV_DIR / f"{ac}.json").exists()]


@pytest.mark.parametrize("path,size,fmt", [
    (lc.LIV / "test" / f"{ac}_region_id.{lc.AIRCRAFT[ac]['fmt']}", (lc.AIRCRAFT[ac]["size"],) * 2,
     PIL_FORMAT[lc.AIRCRAFT[ac]["fmt"]]) for ac in MAPPED], ids=MAPPED)
def test_region_id_sheets(path, size, fmt):
    im = Image.open(path)
    assert (im.size, im.format) == (size, fmt)
    assert path.stat().st_size <= lc.MAX_BYTES


@pytest.mark.parametrize("sid", ["b757_team_transport", "b757_night_freight"])
def test_757_deterministic_and_reproduces_committed_png(sid):
    spec = next(s for s in SPECS if s["id"] == sid)
    a = F.build(spec, write=False)[0]
    b = F.build(spec, write=False)[0]
    assert a["hash"] == b["hash"]
    committed = lc.pixel_hash(Image.open(F.out_paths(spec)[0]))
    assert a["hash"] == committed, "committed PNG is stale: rebuild with --only " + sid


def test_f16_deterministic():
    spec = next(s for s in SPECS if s["id"] == "f16_rival_moo")
    a = F.build(spec, write=False)[0]
    b = F.build(spec, write=False)[0]
    assert a["hash"] == b["hash"]


def test_seed_changes_output():
    spec = dict(next(s for s in SPECS if s["id"] == "b757_night_freight"))
    a = F.build(spec, write=False)[0]["hash"]
    spec["seed"] = spec["seed"] + 1
    b = F.build(spec, write=False)[0]["hash"]
    assert a != b


def test_rafale_spec_map_is_build_spec_packing():
    for sid, rough in (("rafale_gold_chrome", 14), ("rafale_dawg_black_chrome", 14)):
        spec = next(s for s in SPECS if s["id"] == sid)
        sp = np.asarray(Image.open(F.out_paths(spec)[1]).convert("RGB"))
        base = np.asarray(Image.open(lc.ROOT / "rafale" / "stock_specular.png").convert("RGB"))
        used = base.sum(2) > 0
        assert (sp[~used] == 0).all(), "stock black gutters must stay black"
        assert set(np.unique(sp[used][:, 1])) == {rough}
        assert set(np.unique(sp[used][:, 2])) == {255}
        assert (sp[..., 0] == 0).all()


def test_encode_respects_cap_webp():
    rng = np.random.default_rng(0)
    noise = Image.fromarray(rng.integers(0, 255, (1024, 1024, 3), dtype=np.uint8))
    data, note = lc.encode(noise, "webp", 88, cap=400_000)
    assert len(data) <= 400_000 or note == "webp q60"
    Image.open(io.BytesIO(data)).verify()


def test_encode_png_falls_back_to_palette():
    rng = np.random.default_rng(1)
    noise = Image.fromarray(rng.integers(0, 255, (512, 512, 3), dtype=np.uint8))
    data, note = lc.encode(noise, "png", cap=300_000)
    assert "palette" in note and len(data) <= 300_000


def test_no_paint_regions_keep_the_stock_underlay():
    spec = next(s for s in SPECS if s["id"] == "f16_rival_dawg")
    img = np.asarray(Image.open(F.out_paths(spec)[0]).convert("RGB")).astype(int)
    uv = lc.UV("f16")
    keep = uv.covered & ~uv.paint & lc.erode(uv.covered & ~uv.paint, 3)
    under = F.underlay("f16").astype(int)
    # lossy WebP: close, not exact
    assert np.abs(img[keep] - under[keep]).mean() < 6


def test_encode_jpeg_steps_quality_under_the_cap():
    rng = np.random.default_rng(2)
    noise = Image.fromarray(rng.integers(0, 255, (1024, 1024, 3), dtype=np.uint8))
    data, note = lc.encode(noise, "jpg", 90, cap=500_000)
    assert note.startswith("jpeg q") and (len(data) <= 500_000 or note == "jpeg q60")
    assert Image.open(io.BytesIO(data)).format == "JPEG"


def test_ladder_airframes_neutral_non_paint_regions():
    # no shipped liveries to take an underlay from: pilot/gear/interior texels are flat neutrals
    spec = next(s for s in SPECS if s["id"] == "c172_gg_heat_5")
    img = np.asarray(Image.open(F.out_paths(spec)[0]).convert("RGB")).astype(int)
    uv = lc.UV("c172")
    for name, col in uv.meta["neutral"].items():
        if name not in uv.ids:
            continue
        m = lc.erode(uv.mask(name) & uv.covered, 3)
        want = np.array([int(col[i:i + 2], 16) for i in (1, 3, 5)])
        assert np.abs(img[m] - want).mean() < 8, name          # lossy JPEG: close, not exact


def test_737_windows_painted_where_the_map_says():
    spec = next(s for s in SPECS if s["id"] == "b737_gg_heat_4")
    img = np.asarray(Image.open(F.out_paths(spec)[0]).convert("RGB")).astype(int)
    wins = lc.UV("b737").meta["cabin"]["windows"]
    assert len(wins) > 40
    want = np.array([0x0d, 0x0e, 0x11])
    centres = np.array([img[y + h // 2, x + w // 2] for x, y, w, h in wins])
    assert np.abs(centres - want).max(1).mean() < 16
