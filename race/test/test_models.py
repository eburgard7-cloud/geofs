"""Tests for race/tools/build_models.py output.

Run: cd race/test && python -m pytest test_models.py -q
(requires: pip install pygltflib numpy)
"""
import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build_models  # noqa: E402
from pygltflib import GLTF2  # noqa: E402

SIZE_CAP_BYTES = build_models.SIZE_CAP_BYTES
EXPECTED_IDS = {"goldfish", "bratwurst", "traffic-cone", "toilet", "parcel-box", "cow",
                "rubber-duck", "cheese-wedge", "beer-stein", "pizza-slice", "flying-couch", "shopping-cart"}


@pytest.fixture(scope="module")
def out_dir():
    with tempfile.TemporaryDirectory() as d:
        old_argv = sys.argv
        sys.argv = ["build_models.py", d]
        try:
            build_models.main()
        finally:
            sys.argv = old_argv
        yield d


def test_index_json_has_all_models(out_dir):
    with open(os.path.join(out_dir, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    ids = {m["id"] for m in index}
    assert ids == EXPECTED_IDS
    for m in index:
        assert m["file"] == m["id"] + ".glb"
        assert os.path.isfile(os.path.join(out_dir, m["file"]))
        assert m["scale"] > 0
        offset = m["offset"]
        assert set(offset) == {"headingDeg", "pitchDeg", "rollDeg"}


@pytest.mark.parametrize("model_id", sorted(EXPECTED_IDS))
def test_glb_is_valid_and_within_size_cap(out_dir, model_id):
    path = os.path.join(out_dir, model_id + ".glb")
    size = os.path.getsize(path)
    assert size <= SIZE_CAP_BYTES, f"{model_id}.glb is {size} bytes, over the {SIZE_CAP_BYTES} byte cap"
    with open(path, "rb") as f:
        magic = f.read(4)
    assert magic == b"glTF", f"{model_id}.glb does not start with the glTF magic header"
    gltf = GLTF2().load_binary(path)
    assert gltf.asset.version == "2.0"
    assert len(gltf.meshes) == 1
    prim = gltf.meshes[0].primitives[0]
    assert prim.attributes.POSITION is not None
    assert prim.indices is not None


@pytest.mark.parametrize("model_id", sorted(EXPECTED_IDS))
def test_bounding_box_length_matches_target(out_dir, model_id):
    path = os.path.join(out_dir, model_id + ".glb")
    gltf = GLTF2().load_binary(path)
    acc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION]
    length = acc.max[0] - acc.min[0]
    assert length == pytest.approx(build_models.TARGET_LENGTH_M, abs=0.01)


def test_no_model_exceeds_a_generous_triangle_budget(out_dir):
    # Sanity check against runaway tessellation blowing past the size cap on a future edit.
    for model_id in EXPECTED_IDS:
        path = os.path.join(out_dir, model_id + ".glb")
        gltf = GLTF2().load_binary(path)
        idx_acc = gltf.accessors[gltf.meshes[0].primitives[0].indices]
        assert idx_acc.count // 3 < 5000
