#!/usr/bin/env python3
"""Render race/models/preview.png: a headless contact sheet of every model in models/index.json,
three orthographic views each (front = looking aft from the nose (+X), side = from +Z, top = from +Y).

Usage: python render_models_preview.py [models_dir] [out.png]
Requires: pip install pygltflib numpy matplotlib
"""
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402
from pygltflib import GLTF2  # noqa: E402

DTYPES = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
NCOMP = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}


def read_accessor(g, blob, idx):
    acc = g.accessors[idx]
    bv = g.bufferViews[acc.bufferView]
    dt = DTYPES[acc.componentType]
    n = NCOMP[acc.type]
    start = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    arr = np.frombuffer(blob, dtype=dt, count=acc.count * n, offset=start)
    return arr.reshape(acc.count, n) if n > 1 else arr


def load_tris(path):
    g = GLTF2().load_binary(path)
    blob = g.binary_blob()
    prim = g.meshes[0].primitives[0]
    pos = read_accessor(g, blob, prim.attributes.POSITION)
    col = read_accessor(g, blob, prim.attributes.COLOR_0) if prim.attributes.COLOR_0 is not None else np.ones((len(pos), 4))
    idx = read_accessor(g, blob, prim.indices).astype(int).reshape(-1, 3)
    return pos[idx], col[idx[:, 0]]


VIEWS = [("front", 0, 0), ("side", 0, -90), ("top", 90, -90)]


def draw(ax, tris, cols, elev, azim, lim):
    # glTF (x fwd, y up, z right) -> matplotlib (X=x, Y=-z, Z=y up)
    p = np.stack([tris[..., 0], -tris[..., 2], tris[..., 1]], axis=-1)
    n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    e, a = np.radians(elev), np.radians(azim)
    view = np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)])
    light = view + np.array([0.3, 0.3, 0.6])
    light /= np.linalg.norm(light)
    shade = 0.45 + 0.55 * np.abs(n @ light)
    fc = np.clip(cols[:, :3] * shade[:, None], 0, 1)
    ax.add_collection3d(Poly3DCollection(p, facecolors=fc, edgecolors="none"))
    ax.set_xlim(-lim, lim)
    ax.set_ylim(-lim, lim)
    ax.set_zlim(-lim, lim)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=elev, azim=azim)
    ax.set_proj_type("ortho")
    ax.set_axis_off()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    models_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "models")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(models_dir, "preview.png")
    with open(os.path.join(models_dir, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    cols_per_row = 2
    rows = (len(index) + cols_per_row - 1) // cols_per_row
    fig = plt.figure(figsize=(3 * cols_per_row * 2.0, rows * 2.2), dpi=72)
    fig.patch.set_facecolor("#dde3ea")
    for i, entry in enumerate(index):
        tris, cols = load_tris(os.path.join(models_dir, entry["file"]))
        lim = float(np.abs(tris).max()) * 1.05
        for v, (label, elev, azim) in enumerate(VIEWS):
            ax = fig.add_subplot(rows, cols_per_row * 3, i * 3 + v + 1, projection="3d")
            ax.set_facecolor("#dde3ea")
            draw(ax, tris, cols, elev, azim, lim)
            ax.set_title(f"{entry['id']} — {label}" if v == 0 else label, fontsize=8)
    fig.suptitle("FINSONLY joke planes — nose +X (front view looks aft from the nose)", fontsize=10)
    fig.tight_layout()
    fig.savefig(out, facecolor=fig.get_facecolor())
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
