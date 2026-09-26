"""
Crude 3D preview: wraps a livery texture onto the real GeoFS mesh (the same model and UVs the
region maps come from) with a numpy z-buffer rasterizer and flat Lambert shading.

Needs the model cache that tools/uv_regions.py fills (liveries/.cache/, gitignored). Without it,
render() returns None and the contact sheet falls back to flat thumbnails only.
"""
from __future__ import annotations

import json
import math
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

CACHE = lc.LIV / ".cache"

# (azimuth deg around the up axis from the nose, elevation deg, label)
# az 0 = seen from dead ahead, -90 = from the left, 180 = from behind
VIEWS = {"f16": [(-40, 25, "front-left, above"), (140, -20, "rear-right, below")],
         "b757": [(-70, 12, "left side"), (110, 12, "right side")]}


@lru_cache(maxsize=4)
def mesh(ac):
    """-> list of (tris (n,3,3), uv (n,3,2) or None, flat rgb or None) in model space."""
    import uv_regions as U
    d = CACHE / ac
    spec = U.AIRCRAFT[ac]
    files = spec["parts"] or [f for f in spec["files"] if f.endswith((".glb", ".gltf"))]
    if not all((d / f).exists() for f in files):
        return None
    offsets = {}
    if (d / "aircraft.json").exists():
        for part in json.loads((d / "aircraft.json").read_text())[0]["parts"]:
            if part.get("model") and part.get("position"):
                px, py, pz = part["position"]
                offsets[part["model"]] = np.array([px, pz, -py], float)
    out = []
    for f in files:
        g, prims = U.load_gltf1(d / f)
        for p in prims:
            vals = g["materials"][p["material"]].get("values", {})
            dif = vals.get("diffuse")
            P = (p["pos"] + offsets.get(f, 0.0))[p["idx"]]
            if isinstance(dif, str) and "texture" in dif and "reflection" not in dif:
                uv = p["uv"][p["idx"]]
                uv = uv - np.floor(uv.mean(1))[:, None, :]
                out.append((P, uv, None))
            else:
                c = np.array(dif[:3]) * 255 if isinstance(dif, list) else np.array([90, 95, 100])
                if "glass" in g["materials"][p["material"]].get("name", ""):
                    c = np.array([40, 50, 60])
                out.append((P, None, c))
    # untextured primitives without positions-only (e.g. b757 non-livery parts) are included
    return out


def render(ac, tex: Image.Image, az, el, W=560, H=360, bg=(236, 238, 242)):
    m = mesh(ac)
    if m is None:
        return None
    T = np.asarray(tex.convert("RGB"), np.float32)
    TS = T.shape[0]
    allP = np.concatenate([p for p, _, _ in m]).reshape(-1, 3)
    ctr = (allP.min(0) + allP.max(0)) / 2
    a, e = math.radians(az), math.radians(el)
    # camera looks at the centre from direction (az around up, from the nose at -z)
    fwd = -np.array([math.sin(a) * math.cos(e), math.sin(e), -math.cos(a) * math.cos(e)])
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    light = -fwd * 0.6 + up * 0.6 + right * 0.3
    light /= np.linalg.norm(light)
    Qa = allP - ctr
    px_, py_ = Qa @ right, Qa @ up
    scale = 0.92 * min(W / (px_.max() - px_.min()), H / (py_.max() - py_.min()))
    ctr = ctr + right * (px_.max() + px_.min()) / 2 + up * (py_.max() + py_.min()) / 2
    img = np.empty((H, W, 3), np.float32)
    img[:] = bg
    zb = np.full((H, W), np.inf, np.float32)
    for P, UV, col in m:
        Q = P - ctr
        sx = (Q @ right) * scale + W / 2
        sy = -(Q @ up) * scale + H / 2
        sz = Q @ fwd
        N = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
        N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
        lam = np.abs(N @ light) * 0.75 + 0.3
        for t in range(len(P)):
            xs, ys = sx[t], sy[t]
            x0, x1 = max(int(xs.min()), 0), min(int(math.ceil(xs.max())), W - 1)
            y0, y1 = max(int(ys.min()), 0), min(int(math.ceil(ys.max())), H - 1)
            if x1 < x0 or y1 < y0:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            (ax, bx, cx), (ay, by, cy) = xs, ys
            d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(d) < 1e-9:
                continue
            l1 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / d
            l2 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / d
            l3 = 1 - l1 - l2
            ins = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
            if not ins.any():
                continue
            z = l1 * sz[t, 0] + l2 * sz[t, 1] + l3 * sz[t, 2]
            sl = (slice(y0, y1 + 1), slice(x0, x1 + 1))
            w = ins & (z < zb[sl])
            if not w.any():
                continue
            zb[sl][w] = z[w]
            if UV is not None:
                u = l1 * UV[t, 0, 0] + l2 * UV[t, 1, 0] + l3 * UV[t, 2, 0]
                v = l1 * UV[t, 0, 1] + l2 * UV[t, 1, 1] + l3 * UV[t, 2, 1]
                px = (np.mod(u[w], 1.0) * TS).astype(int).clip(0, TS - 1)
                py = (np.mod(v[w], 1.0) * TS).astype(int).clip(0, TS - 1)
                c = T[py, px]
            else:
                c = col
            img[sl][w] = c * lam[t]
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def views(ac, tex, W=560, H=360):
    """-> list of (label, image) or [] without the model cache."""
    out = []
    for az, el, label in VIEWS.get(ac, []):
        im = render(ac, tex, az, el, W, H)
        if im is None:
            return []
        out.append((label, im))
    return out


if __name__ == "__main__":
    # python tools/livery_preview.py f16 liveries/out/x.webp out.png
    ac, src, dst = sys.argv[1:4]
    vs = views(ac, Image.open(src))
    sheet = Image.new("RGB", (560 * len(vs), 360), (255, 255, 255))
    for i, (_, im) in enumerate(vs):
        sheet.paste(im, (560 * i, 0))
    sheet.save(dst)
