"""UV region maps: well-formed, consistent with their JSON, geometry sane."""
import numpy as np
import pytest

import livery_common as lc


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
