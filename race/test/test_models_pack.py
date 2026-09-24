"""Checks on the COMMITTED race/models/*.glb + index.json (not a fresh build): every model is a
valid glTF 2.0 binary within the joke-pack budget, sized like the goldfish, and every index
entry resolves. Complements test_models.py, which checks build_models.py's output.

Run: cd race/test && python -m pytest test_models_pack.py -q   (requires: pip install pygltflib numpy)
"""
import json
import os
import struct

import numpy as np
import pytest
from pygltflib import GLTF2

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")
MAX_TRIS = 5000
MAX_BYTES = 120 * 1024
NEW_IDS = ["rubber-duck", "cheese-wedge", "beer-stein", "pizza-slice", "flying-couch", "shopping-cart"]


def load_index():
    with open(os.path.join(MODELS_DIR, "index.json"), encoding="utf-8") as f:
        return json.load(f)


def positions(path):
    g = GLTF2().load_binary(path)
    acc = g.accessors[g.meshes[0].primitives[0].attributes.POSITION]
    bv = g.bufferViews[acc.bufferView]
    blob = g.binary_blob()
    arr = np.frombuffer(blob, dtype=np.float32, count=acc.count * 3, offset=(bv.byteOffset or 0) + (acc.byteOffset or 0))
    return g, acc, arr.reshape(-1, 3)


def extents(path):
    _, acc, _ = positions(path)
    return np.array(acc.max) - np.array(acc.min)


INDEX = load_index()
IDS = [m["id"] for m in INDEX]


def test_index_has_twelve_unique_entries_that_resolve():
    assert len(IDS) == 12 and len(set(IDS)) == 12
    for nid in NEW_IDS:
        assert nid in IDS
    for m in INDEX:
        assert set(m) == {"id", "name", "file", "scale", "offset"}
        assert m["file"] == m["id"] + ".glb"
        assert os.path.isfile(os.path.join(MODELS_DIR, m["file"])), m["file"]
        assert m["scale"] == 1
        assert m["offset"] == {"headingDeg": 0, "pitchDeg": 0, "rollDeg": 0}


def test_every_glb_on_disk_is_indexed():
    on_disk = {f[:-4] for f in os.listdir(MODELS_DIR) if f.endswith(".glb")}
    assert on_disk == set(IDS)


def test_assignments_only_reference_known_models():
    with open(os.path.join(MODELS_DIR, "assignments.json"), encoding="utf-8") as f:
        assignments = json.load(f)
    for k, v in assignments.items():
        if not k.startswith("_"):
            assert v in IDS, v


@pytest.mark.parametrize("model_id", IDS)
def test_valid_gltf2_binary_within_budget(model_id):
    path = os.path.join(MODELS_DIR, model_id + ".glb")
    size = os.path.getsize(path)
    assert size < MAX_BYTES, f"{model_id}: {size} bytes"
    with open(path, "rb") as f:
        magic, version, length = struct.unpack("<4sII", f.read(12))
    assert magic == b"glTF" and version == 2 and length == size
    g, acc, pos = positions(path)
    assert g.asset.version == "2.0"
    prim = g.meshes[0].primitives[0]
    assert prim.mode in (None, 4)  # TRIANGLES
    idx = g.accessors[prim.indices]
    assert idx.count % 3 == 0 and idx.count // 3 < MAX_TRIS
    assert not g.textures and not g.images, "flat colors only, no textures"
    assert np.isfinite(pos).all()
    assert np.allclose(pos.min(axis=0), acc.min, atol=1e-4) and np.allclose(pos.max(axis=0), acc.max, atol=1e-4)


@pytest.mark.parametrize("model_id", IDS)
def test_nose_axis_and_size_match_goldfish(model_id):
    gold = extents(os.path.join(MODELS_DIR, "goldfish.glb"))
    ext = extents(os.path.join(MODELS_DIR, model_id + ".glb"))
    # Nose along +X, +X extent is the longest, scaled like the goldfish (15 m).
    assert ext[0] == pytest.approx(gold[0], abs=0.01)
    assert ext.max() <= 2 * gold.max() + 1e-6
    assert ext.max() >= 0.5 * gold.max()


@pytest.mark.parametrize("model_id", NEW_IDS)
def test_new_models_are_centered_on_their_centroid(model_id):
    _, _, pos = positions(os.path.join(MODELS_DIR, model_id + ".glb"))
    tris = pos.reshape(-1, 3, 3)
    areas = 0.5 * np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1)
    c = (tris.mean(axis=1) * areas[:, None]).sum(axis=0) / areas.sum()
    assert np.abs(c).max() < 0.05, c


def test_preview_contact_sheet_exists():
    path = os.path.join(MODELS_DIR, "preview.png")
    with open(path, "rb") as f:
        assert f.read(8) == b"\x89PNG\r\n\x1a\n"
    assert os.path.getsize(path) > 10_000
