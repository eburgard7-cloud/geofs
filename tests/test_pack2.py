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


LADDER = ("b737", "b737max", "c172", "c172retro", "cub", "paraglider", "su35", "beaver")
# the recolorable pilot template of each ladder airframe
PILOT = {"b737_airliner", "b737max_airliner", "c172_speedline", "c172retro_speedline",
         "cub_classic", "paraglider_bands", "su35_speedline", "beaver_bush"}
NO_LS = {ac for ac, v in lc.AIRCRAFT.items() if v["key"] is None}   # no LiverySelector entry


# ----------------------------------------------------------------------------- templates
def test_every_template_instantiates_with_defaults():
    ts = T.all_templates()
    assert {t["id"] for t in ts} >= {"f16_gg_kit", "f16_speedline", "f16_split", "f16_checker",
                                     "f16_flames", "f16_fade", "b757_airliner", "b757_gg_kit",
                                     "rafale_chrome"} | {f"{ac}_gg_kit" for ac in LADDER} | PILOT
    for t in ts:
        F.validate_spec(T.instantiate(t, {}))


def test_instances_and_specs_in_sync():
    assert T.check() == []


def test_schema_hides_mode_kits():
    ids = {t["id"] for t in T.schema()}
    assert "f16_gg_kit" not in ids and "b757_gg_kit" not in ids
    assert "f16_speedline" in ids and "rafale_chrome" in ids
    assert not ids & {f"{ac}_gg_kit" for ac in LADDER}
    assert PILOT <= ids                       # one recolorable pilot template per airframe


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
        elif e["aircraft"] in NO_LS:
            # LiverySelector can't apply anything to an airframe it has no entry for
            assert e["listed"] is False and e["category"] == "starter"
        else:
            assert e["listed"] is True
        if e["category"] in ("starter", "classic"):
            assert e["requires"] is None
    assert len(by["starter"]) == 20               # 12 + one free starter per ladder airframe
    assert len(by["classic"]) == 11
    assert len(by["season"]) == 4


def test_every_ready_airframe_has_a_full_heat_set():
    cat = json.loads((lc.LIV / "catalog.json").read_text(encoding="utf-8"))
    ready = {a["factory"] for a in GL.load()["airframes"].values() if a["paint"] == "ready"}
    assert ready >= {"f16", "b757", "rafale", *LADDER}
    for ac in sorted(ready):
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
], ids=["rafale-template", "garbage", "over-limit"])
# explicit ids: by default pytest puts the 1.5 MB payload in the test id, and on Windows the
# PYTEST_CURRENT_TEST environment variable it lands in can't exceed 32767 characters
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


MAPPED = ["f16", "b757", *LADDER]


@pytest.mark.parametrize("ac", MAPPED)
def test_views_project_a_texture(ac):
    tex = Image.new("RGB", (64, 64), (255, 0, 0))
    for which in ("front", "top") if ac == "paraglider" else ("left", "right", "top", "bottom"):
        im = V.view(ac, tex, which, W=240)
        a = np.asarray(im)
        assert im.width == 240
        red = (a[..., 0] > 200) & (a[..., 1] < 60)
        assert red.mean() > 0.05, which          # the airframe shows up, painted
    assert V.views("rafale", tex) == []


@pytest.mark.parametrize("ac", LADDER)
def test_region_map_round_trips_through_views(ac):
    """Project the region map itself: each side view shows that side's fuselage colour, and
    every pixel is a region colour or background (nothing invented in between)."""
    uv = lc.UV(ac)
    reg = Image.open(lc.UV_DIR / f"{ac}_regions.png").convert("RGB")
    cols = {r["name"]: tuple(int(r["color"][i:i + 2], 16) for i in (1, 3, 5))
            for r in uv.meta["regions"]}
    allowed = set(cols.values()) | {V.BG, (0, 0, 0)}
    which = ("front", "top") if ac == "paraglider" else ("left", "right", "top")
    seen = {}
    for w in which:
        a = np.asarray(V.view(ac, reg, w, W=400, splat=1)).reshape(-1, 3)
        px = {tuple(c) for c in np.unique(a, axis=0)}
        assert px <= allowed, (w, sorted(px - allowed)[:3])
        seen[w] = {tuple(c): n for c, n in zip(*np.unique(a, axis=0, return_counts=True))}
    if ac != "paraglider":
        for side, view, other in (("l", "left", "right"), ("r", "right", "left")):
            c = cols[f"fuselage_{side}"]
            assert seen[view].get(c, 0) > 2 * seen[other].get(c, 0), side


@pytest.mark.parametrize("tid,ac", [("c172_speedline", "c172"), ("b737max_airliner", "b737max")])
def test_render_bytes_ladder_native_format_under_cap(tid, ac):
    parts = T.render_bytes(tid, {})
    im = Image.open(io.BytesIO(parts[0][1]))
    fmt = {"jpg": "JPEG", "png": "PNG", "webp": "WEBP"}[lc.AIRCRAFT[ac]["fmt"]]
    assert im.format == fmt and im.size == (lc.AIRCRAFT[ac]["size"],) * 2
    assert len(parts[0][1]) <= lc.MAX_BYTES
