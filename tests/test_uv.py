"""UV region maps: well-formed, consistent with their JSON, geometry sane."""
import json
import struct

import numpy as np
import pytest

import livery_common as lc
import uv_regions as U


@pytest.mark.parametrize("ac,size", [("f16", 2048), ("b757", 1024)])
def test_region_map_matches_json(ac, size):
    uv = lc.UV(ac)
    assert uv.reg.shape == (size, size)
    ids = [r["id"] for r in uv.meta["regions"]]
    assert ids == list(range(1, len(ids) + 1))
    assert set(np.unique(uv.reg)) <= {0, *ids}
    for r in uv.meta["regions"]:
        assert r["confidence"] in ("high", "medium", "low")
        assert r["texels"] == int((uv.reg == r["id"]).sum())
        assert r["where"]
    assert "UNVERIFIED IN-SIM" in uv.meta["in_sim"]


def test_f16_geometry_sane():
    uv = lc.UV("f16")
    rad = uv.mask("radome") & uv.covered
    fin = uv.mask("fin") & uv.covered
    assert np.median(uv.length[rad]) < 0.12            # the nose is at the front
    assert np.median(uv.height[fin]) > 0.6             # the fin is up top
    assert np.median(uv.lat[uv.mask("wing_top_l")]) < 0.4
    assert np.median(uv.lat[uv.mask("wing_top_r")]) > 0.6


def test_757_parts_placed_at_aircraft_json_positions():
    # regression: rudder/door parts are modelled in local coordinates; without the part
    # offsets the rudder's height came out ~0.2 and wrecked the height scale
    uv = lc.UV("b757")
    rud = uv.mask("rudder") & uv.covered
    assert np.median(uv.height[rud]) > 0.5
    assert np.median(uv.length[rud]) > 0.9
    assert uv.meta["geom_axes"]["bounds_m"]["lo"][1] > -3


def test_757_sides_are_separate_and_mirrored():
    uv = lc.UV("b757")
    left = uv.mask("fuselage_l") & uv.covered
    right = uv.mask("fuselage_r") & uv.covered
    assert np.median(uv.lat[left]) < 0.5 < np.median(uv.lat[right])
    # both bands run nose (x small) to tail (x large): the right band is mirrored on the jet
    for m in (left, right):
        ys, xs = np.nonzero(m)
        assert np.corrcoef(xs, uv.length[ys, xs])[0, 1] > 0.9


def test_paint_flags():
    uv = lc.UV("f16")
    assert not uv.regions["pilot"]["paint"]
    assert not uv.regions["interior"]["paint"]
    assert uv.regions["fin"]["paint"]


# ----------------------------------------------------------------------------- ladder airframes
LADDER = ["b737", "b737max", "c172", "c172retro", "cub", "paraglider", "su35", "beaver"]
NOSE = {"b737": "nose_cone", "b737max": "nose_cone", "su35": "radome", "c172": "cowling",
        "c172retro": "cowling", "cub": "cowling", "beaver": "cowling"}


@pytest.mark.parametrize("ac", LADDER)
def test_ladder_map_matches_json(ac):
    uv = lc.UV(ac)
    assert uv.reg.shape == (lc.AIRCRAFT[ac]["size"],) * 2
    ids = [r["id"] for r in uv.meta["regions"]]
    assert ids == list(range(1, len(ids) + 1))
    assert set(np.unique(uv.reg)) <= {0, *ids}
    for r in uv.meta["regions"]:
        assert r["texels"] == int((uv.reg == r["id"]).sum()) > 0     # empty regions are dropped
        assert r["paint"] == (r["name"] not in ("pilot", "mechanical", "interior"))
    assert "UNVERIFIED IN-SIM" in uv.meta["in_sim"]
    assert uv.meta["geofs_id"] and uv.meta["texture_slot"] is not None
    assert set(uv.meta["neutral"]) == {"mechanical", "interior", "pilot"}


@pytest.mark.parametrize("ac", [a for a in LADDER if a != "paraglider"])
def test_ladder_geometry_sane(ac):
    uv = lc.UV(ac)
    nose = uv.mask(NOSE[ac]) & uv.covered
    assert np.median(uv.length[nose]) < 0.2                 # the nose is at the front
    fins = uv.mask("fin*") & uv.covered
    assert np.median(uv.height[fins]) > 0.5                 # the fin is up top
    assert np.median(uv.length[fins]) > 0.7                 # ...at the back
    for side, lo, hi in (("l", 0, 0.45), ("r", 0.55, 1)):
        m = uv.mask(f"wing_top_{side}") & uv.covered
        if m.sum() > 20000:          # slivers next to a shared wing island carry its geometry
            assert lo < np.median(uv.lat[m]) < hi, side
    for side, lo, hi in (("l", 0, 0.5), ("r", 0.5, 1)):
        m = uv.mask(f"fuselage_{side}") & uv.covered
        assert lo <= np.median(uv.lat[m]) <= hi, side


def test_paraglider_tips_hang_below_the_centre():
    uv = lc.UV("paraglider")
    tips = uv.mask("canopy_tips") & uv.covered
    centre = uv.mask("canopy_centre") & uv.covered
    assert np.median(uv.height[tips]) < np.median(uv.height[centre]) - 0.3
    # regression: a few degenerate faces with UVs spanning dozens of sheets used to smear
    # 'canopy_tips' over the whole texture; the canopy really uses the top quarter only
    ys, _ = np.nonzero(uv.reg > 0)
    assert ys.max() < 0.3 * uv.size


def test_737_flap_fairing_smear_filtered():
    # regression: a 0.4 m flap-track fairing face mapped across 20 texture widths painted a
    # giant 'flaps' wedge over a quarter of the sheet
    uv = lc.UV("b737")
    assert uv.regions["flaps"]["texels"] < 0.03 * uv.size ** 2
    assert uv.regions["mechanical"]["texels"] < 0.1 * uv.size ** 2


def test_737_wings_are_wing_not_mechanical():
    # regression: the wing panels are their own parts (wingLeft0..2); they were 'mechanical'
    uv = lc.UV("b737")
    wing = sum(uv.regions[n]["texels"] for n in ("wing_both", "wing_bottom") if n in uv.regions)
    assert wing > 0.1 * uv.size ** 2


def test_737max_nose_cut_and_no_interior():
    # regression: the nose cut sat beyond the tip (5 texels); and the title-band overlay faces
    # made the visibility pass call the skin around them 'interior' (black seams)
    uv = lc.UV("b737max")
    assert uv.regions["nose_cone"]["texels"] > 5000
    assert "interior" not in uv.regions


def test_737max_slot_resolved_from_the_model():
    uv = lc.UV("b737max")
    assert uv.meta["texture_slot"] == 2 and "UNVERIFIED" in uv.meta["texture_slot_source"]


def test_classify_rules_first_match_and_placeholders():
    rules = [("fin_{ns}", dict(node="^body$", y=(1.0, None))),
             ("wing_top_{s}", dict(node="^body$", ax=(2.0, None), ny=(0, None))),
             ("wing_bottom", dict(node="^body$", ax=(2.0, None))),
             ("rudder", dict(node="(?i)^rudder$"))]
    assert U.classify_rules(rules, "body", (0.0, 1.5, 3.0), (-1, 0, 0)) == "fin_l"
    assert U.classify_rules(rules, "body", (0.0, 1.5, 3.0), (1, 0, 0)) == "fin_r"
    assert U.classify_rules(rules, "body", (-4.0, 0.0, 0.0), (0, 1, 0)) == "wing_top_l"
    assert U.classify_rules(rules, "body", (4.0, 0.0, 0.0), (0, -1, 0)) == "wing_bottom"
    assert U.classify_rules(rules, "Rudder", (0.0, 0.0, 0.0), (0, 0, 1)) == "rudder"
    assert U.classify_rules(rules, "wheel", (0.0, 0.0, 0.0), (0, 0, 1)) == "mechanical"


def _glb2(tmp_path):
    """One textured triangle in a glTF 2.0 binary, its node translated by +1 in x."""
    pos = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32)
    uv = np.array([[0, 0], [1, 0], [0, 1]], np.float32)
    idx = np.array([0, 1, 2, 0], np.uint16)                # padded to 4 bytes
    binc = pos.tobytes() + uv.tobytes() + idx.tobytes()
    g = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
         "nodes": [{"name": "skin", "mesh": 0, "translation": [1, 0, 0]}],
         "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1},
                                     "indices": 2, "material": 0}]}],
         "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}}],
         "textures": [{"source": 1}, {"source": 0}],
         "images": [{"name": "livery", "mimeType": "image/png", "bufferView": 0},
                    {"name": "other", "mimeType": "image/png", "bufferView": 0}],
         "buffers": [{"byteLength": len(binc)}],
         "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36},
                         {"buffer": 0, "byteOffset": 36, "byteLength": 24},
                         {"buffer": 0, "byteOffset": 60, "byteLength": 6}],
         "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
                       {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC2"},
                       {"bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR"}]}
    js = json.dumps(g).encode()
    js += b" " * (-len(js) % 4)
    body = (struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(binc), 0x004E4942) + binc)
    raw = b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body
    p = tmp_path / "t.glb"
    p.write_bytes(raw)
    return p


def test_gltf2_loader(tmp_path):
    g, prims = U.load_model(_glb2(tmp_path))
    assert len(prims) == 1 and prims[0]["node"] == "skin" and prims[0]["material"] == 0
    assert np.allclose(prims[0]["pos"][:, 0], [1, 2, 1])            # node translation applied
    assert prims[0]["idx"].tolist() == [[0, 1, 2]]
    assert U.material_images(g) == {0: "livery"}                     # texture 1 -> image 0
    assert U.texture_slot(g, "livery") == 1 and U.texture_slot(g, "other") == 0
