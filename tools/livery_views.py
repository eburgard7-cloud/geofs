"""
Mesh-free airframe views: projects a livery texture through liveries/uv/<ac>_geom.png (each
texel's airframe position) into left / right / top / bottom orthographic views with a z-buffer.

No GeoFS model files needed, so it works anywhere the repo is checked out (the 3D wrap in
tools/livery_preview.py needs the gitignored model cache). The geometry map is 8-bit per axis,
so these are coarse silhouettes: good for "is the paint where I meant it", not for beauty shots.
Mirrored islands show up correctly: each texel lands where it really sits on the jet.

  python tools/livery_views.py f16 liveries/out/f16_gg_heat_01.webp out.png
"""
from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

BG = (232, 235, 240)
# (label, x axis, y axis (up on screen), depth axis, depth sign: +1 = larger value nearer,
#  flip x)
VIEWS = {
    "left": ("left side", "length", "height", "lat", -1, False),
    "right": ("right side", "length", "height", "lat", +1, True),
    "top": ("top", "length", "lat", "height", +1, False),
    "bottom": ("bottom", "length", "lat", "height", -1, False),
}


@lru_cache(maxsize=4)
def _points(ac):
    """-> (lat, height, length in metres, texel flat index) for every covered texel."""
    uv = lc.UV(ac)
    b = uv.meta["geom_axes"]["bounds_m"]
    lo, hi = np.array(b["lo"]), np.array(b["hi"])
    ext = hi - lo
    m = uv.covered
    idx = np.flatnonzero(m)
    return (uv.lat.ravel()[idx] * ext[0], uv.height.ravel()[idx] * ext[1],
            uv.length.ravel()[idx] * ext[2], idx, ext)


def view(ac, tex: Image.Image, which="left", W=480, splat=2) -> Image.Image:
    lat, hgt, lng, idx, ext = _points(ac)
    axes = {"lat": lat, "height": hgt, "length": lng}
    ext_of = {"lat": ext[0], "height": ext[1], "length": ext[2]}
    _, xa, ya, da, dsign, flip = VIEWS[which]
    S = lc.UV(ac).size
    t = np.asarray(tex.convert("RGB").resize((S, S)), np.uint8).reshape(-1, 3)[idx]
    pad = 8
    scale = (W - 2 * pad) / ext_of[xa]
    H = int(ext_of[ya] * scale) + 2 * pad
    x = axes[xa] * scale + pad
    if flip:
        x = W - x
    y = H - (axes[ya] * scale + pad)
    depth = axes[da] * dsign
    order = np.argsort(depth)          # far first, near last: later writes win
    x, y, c = x[order].astype(int), y[order].astype(int), t[order]
    img = np.zeros((H, W, 3), np.uint8)
    img[:] = BG
    for dy in range(splat):
        for dx in range(splat):
            xx, yy = np.clip(x + dx, 0, W - 1), np.clip(y + dy, 0, H - 1)
            img[yy, xx] = c
    return Image.fromarray(img)


def views(ac, tex, W=480, which=("left", "right", "top")):
    """-> list of (label, image)."""
    if ac not in ("f16", "b757"):
        return []
    return [(VIEWS[w][0], view(ac, tex, w, W)) for w in which]


def sheet(ac, tex, W=480, which=("left", "right", "top", "bottom")) -> Image.Image:
    vs = views(ac, tex, W, which)
    H = sum(im.height for _, im in vs) + 6 * len(vs)
    out = Image.new("RGB", (W, H), (255, 255, 255))
    y = 0
    for _, im in vs:
        out.paste(im, (0, y))
        y += im.height + 6
    return out


if __name__ == "__main__":
    ac, src, dst = sys.argv[1:4]
    sheet(ac, Image.open(src)).save(dst)
