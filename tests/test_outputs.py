"""Outputs: native size and format, under the 1.5 MB cap, deterministic, reproducible."""
import io

import numpy as np
import pytest
from PIL import Image

import livery_common as lc
import livery_factory as F

SPECS = [s for _, s in F.load_specs()]


def _expect(path):
    name = path.name
    if name.startswith("rafale_"):
        return ((1024, 1024) if name.endswith("_spec.webp") else (4096, 4096)), "WEBP"
    if name.startswith("f16_"):
        return (2048, 2048), "WEBP"
    return (1024, 1024), "PNG"


@pytest.mark.parametrize("spec", SPECS, ids=[s["id"] for s in SPECS])
def test_output_native_size_format_and_cap(spec):
    for path in F.out_paths(spec):
        assert path.is_file(), f"{path} not built (python tools/livery_factory.py --all)"
        assert path.stat().st_size <= lc.MAX_BYTES, f"{path.name} over 1.5 MB"
        im = Image.open(path)
        size, fmt = _expect(path)
        assert im.size == size and im.format == fmt, (path.name, im.size, im.format)


@pytest.mark.parametrize("path,size,fmt", [
    (lc.LIV / "test" / "f16_region_id.webp", (2048, 2048), "WEBP"),
    (lc.LIV / "test" / "b757_region_id.png", (1024, 1024), "PNG"),
])
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
