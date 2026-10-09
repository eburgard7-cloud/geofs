"""Pack 2: templates (recolor), catalog, Gun Game ladder paint, uploads, paint kits, views."""
import io
import json

import numpy as np
import pytest
from PIL import Image

import gungame_ladder as GL
import livery_catalog as C
import livery_common as lc
import livery_factory as F
import livery_manifest as M
import livery_templates as T
import livery_upload as U
import livery_views as V


# ----------------------------------------------------------------------------- templates
def test_every_template_instantiates_with_defaults():
    ts = T.all_templates()
    assert {t["id"] for t in ts} >= {"f16_gg_kit", "f16_speedline", "f16_split", "f16_checker",
                                     "f16_flames", "f16_fade", "b757_airliner", "b757_gg_kit",
                                     "rafale_chrome"}
    for t in ts:
        F.validate_spec(T.instantiate(t, {}))


def test_instances_and_specs_in_sync():
    assert T.check() == []


def test_schema_hides_mode_kits():
    ids = {t["id"] for t in T.schema()}
    assert "f16_gg_kit" not in ids and "b757_gg_kit" not in ids
    assert "f16_speedline" in ids and "rafale_chrome" in ids


@pytest.mark.parametrize("params,msg", [
    ({"base": "red"}, "colour"),
    ({"base": "#12345"}, "colour"),
    ({"title": "x" * 11}, "at most"),
    ({"title": "<script>"}, "letters"),
    ({"title": "   "}, "empty"),
    ({"tail": "-ABC"}, "1-7"),
    ({"tail": "N12345678"}, "1-7"),
    ({"nope": "#ffffff"}, "unknown"),
])
def test_bad_params_rejected(params, msg):
    with pytest.raises(T.ParamError, match=msg):
        T.clean_params(T.load_template("f16_speedline"), params)


def test_int_param_bounds():
    t = T.load_template("rafale_chrome")
    assert T.clean_params(t, {"rough": 6})["rough"] == 6
    for bad in (5, 161, 12.5, True, "12"):
        with pytest.raises(T.ParamError):
            T.clean_params(t, {"rough": bad})


def test_text_is_uppercased_and_squeezed():
    p = T.clean_params(T.load_template("f16_speedline"), {"title": "  steve   go ", "tail": "n42f"})
    assert p["title"] == "STEVE GO" and p["tail"] == "N42F"


def test_colour_filters():
    assert T._mix("#808080", 0, 0.5) == "#404040"
    assert T._mix("#000000", 255, 1.0) == "#ffffff"
    tpl = {"id": "x", "aircraft": "b757", "params": {"c": {"type": "color", "default": "#ff0000"}},
           "spec": {"base": {"*": "{{c|dark:0.5}}"}, "layers": [
               {"type": "fill", "color": "{{c|alpha:0.5}}"},
               {"type": "fill", "color": "{{c|light:1.0}}"}]}}
    s = T.instantiate(tpl, {})
    assert s["base"]["*"] == "#800000"
    assert s["layers"][0]["color"] == "#ff000080"
    assert s["layers"][1]["color"] == "#ffffff"


def test_unknown_hole_is_an_error():
    tpl = {"id": "x", "aircraft": "b757", "params": {}, "spec": {"base": {"*": "{{nope}}"}}}
    with pytest.raises(T.ParamError):
        T.instantiate(tpl, {})


def test_same_choices_same_seed_same_pixels():
    t = T.load_template("b757_airliner")
    a = T.instantiate(t, {"body": "#112233"})
    b = T.instantiate(t, {"body": "#112233"})
    c = T.instantiate(t, {"body": "#112234"})
    assert a["seed"] == b["seed"] != c["seed"]


def test_render_bytes_757_native_png_under_cap():
    parts = T.render_bytes("b757_airliner", {"title": "TEST AIR", "tail": "N1F"})
    assert len(parts) == 1 and parts[0][0] == ""
    data = parts[0][1]
    im = Image.open(io.BytesIO(data))
    assert im.format == "PNG" and im.size == (1024, 1024) and len(data) <= lc.MAX_BYTES


# ----------------------------------------------------------------------------- catalog
def test_catalog_valid_and_current():
    cat = C.build()
    assert C.validate(cat) == []
    assert (lc.LIV / "catalog.json").read_text(encoding="utf-8") == C.dump(cat)


def test_catalog_categories_and_rules():
    cat = json.loads((lc.LIV / "catalog.json").read_text(encoding="utf-8"))
    by = {}
    for e in cat["liveries"]:
        by.setdefault(e["category"], []).append(e)
        if e["category"] == "gungame":
            assert e["listed"] is False
        else:
            assert e["listed"] is True
        if e["category"] in ("starter", "classic"):
            assert e["requires"] is None
    assert len(by["starter"]) == 12
    assert len(by["classic"]) == 11
    assert len(by["season"]) == 4


def test_every_mapped_airframe_has_a_full_heat_set():
    cat = json.loads((lc.LIV / "catalog.json").read_text(encoding="utf-8"))
    for ac in ("f16", "b757", "rafale"):
        heats = {e["gungame"]["heat"] for e in cat["liveries"]
                 if e["category"] == "gungame" and e["aircraft"] == ac}
        assert heats == set(range(1, 9)) | {"final"}, ac


def test_every_cup_has_an_f16_livery():
    idx = json.loads((lc.ROOT / "race" / "courses" / "index.json").read_text(encoding="utf-8"))
    cups = {c.get("cup") for c in idx if isinstance(c, dict) and c.get("cup")}
    cat = json.loads((lc.LIV / "catalog.json").read_text(encoding="utf-8"))
    rewards = json.loads((lc.ROOT / "race" / "campaign" / "rewards.json").read_text(encoding="utf-8"))
    have = {(e["requires"] or {}).get("cup") for e in cat["liveries"] if e["aircraft"] == "f16"}
    have |= {lv["requires"].get("cup") for lv in rewards["liveries"] if lv["requires"]}
    assert cups <= have, sorted(cups - have)


def test_unlisted_paints_stay_out_of_liveryselector():
    main = json.loads(M._read(M.MAIN)[0])
    names = {lv["name"] for ac in main["aircrafts"].values() for lv in ac["liveries"]}
    for _, s in F.load_specs():
        if s.get("listed") is False:
            assert s["name"] not in names, s["id"]


# ----------------------------------------------------------------------------- ladder
def test_ladder_examples_match():
    assert GL.check() == []


@pytest.mark.parametrize("n", range(2, 17))
def test_heat_spread(n):
    hs = [GL.heat_for(t, n) for t in range(1, n + 1)]
    assert hs[-1] == "final" and hs[0] == 1
    nums = hs[:-1]
    assert nums == sorted(nums) and all(1 <= h <= 8 for h in nums)
    if n >= 3:
        assert nums[-1] == 8


@pytest.mark.parametrize("t,n", [(0, 6), (7, 6), (1, 1), ("1", 6)])
def test_heat_for_rejects_bad_input(t, n):
    with pytest.raises(ValueError):
        GL.heat_for(t, n)


def test_presets_resolve_paint_for_mapped_airframes_only():
    data = GL.load()
    for r in GL.ladder(data["presets"]["long"]["tiers"], data):
        ready = data["airframes"][r["airframe"]]["paint"] == "ready"
        assert (r["paint"] is not None) == ready, r


# ----------------------------------------------------------------------------- uploads
def _png(size, color=(200, 40, 40), fmt="PNG"):
    b = io.BytesIO()
    Image.new("RGB", (size, size), color).save(b, fmt)
    return b.getvalue()


def test_upload_normalizes_to_native_format():
    data, info = U.normalize("f16", _png(2048))
    im = Image.open(io.BytesIO(data))
    assert im.format == "WEBP" and im.size == (2048, 2048) and info["bytes"] <= lc.MAX_BYTES
    data, info = U.normalize("b757", _png(1024, fmt="JPEG"))
    assert Image.open(io.BytesIO(data)).format == "PNG"


def test_upload_rescales_half_and_double_size_only():
    assert Image.open(io.BytesIO(U.normalize("b757", _png(512))[0])).size == (1024, 1024)
    with pytest.raises(U.UploadError, match="1024x1024"):
        U.normalize("b757", _png(700))


@pytest.mark.parametrize("ac,data,msg", [
    ("rafale", _png(1024), "template"),
    ("f16", b"not an image at all", "couldn't read"),
    ("f16", b"\0" * (U.MAX_UPLOAD_BYTES + 1), "limit"),
])
def test_upload_rejections(ac, data, msg):
    with pytest.raises(U.UploadError, match=msg):
        U.normalize(ac, data)


def test_upload_rejects_gif():
    b = io.BytesIO()
    Image.new("RGB", (1024, 1024)).save(b, "GIF")
    with pytest.raises(U.UploadError, match="aren't accepted"):
        U.normalize("b757", b.getvalue())


# ----------------------------------------------------------------------------- kits + views
@pytest.mark.parametrize("ac", ["f16", "b757"])
def test_paint_kit_files(ac):
    size = lc.AIRCRAFT[ac]["size"]
    blank = Image.open(lc.LIV / "kit" / f"{ac}_kit_blank.{lc.AIRCRAFT[ac]['fmt']}")
    guides = Image.open(lc.LIV / "kit" / f"{ac}_kit_guides.png")
    assert blank.size == guides.size == (size, size)
    assert guides.mode == "RGBA"
    a = np.asarray(guides)[..., 3]
    assert 0.001 < (a > 0).mean() < 0.6        # an overlay, not a filled image


@pytest.mark.parametrize("ac", ["f16", "b757"])
def test_views_project_a_texture(ac):
    tex = Image.new("RGB", (64, 64), (255, 0, 0))
    for which in ("left", "right", "top", "bottom"):
        im = V.view(ac, tex, which, W=240)
        a = np.asarray(im)
        assert im.width == 240
        red = (a[..., 0] > 200) & (a[..., 1] < 60)
        assert red.mean() > 0.05, which          # the airframe shows up, painted
    assert V.views("rafale", tex) == []
