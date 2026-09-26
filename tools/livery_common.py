"""Shared helpers for the Finsonly Air livery tools (region-ID sheets, livery factory).

Pillow + numpy only. Everything here is deterministic: no system fonts, no clocks, no
unseeded randomness.
"""
from __future__ import annotations

import hashlib
import io
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
LIV = ROOT / "liveries"
UV_DIR = LIV / "uv"
FONT_DIR = LIV / "fonts"
MAX_BYTES = 1_500_000

# Output contract per aircraft: native size and format of the LiverySelector slot.
AIRCRAFT = {
    "f16": dict(size=2048, fmt="webp", quality=88, key="7",
                name="General Dynamics F16 Fighting Falcon"),
    "b757": dict(size=1024, fmt="png", key="GXD04N_126645_238", name="Boeing b757-200"),
    "rafale": dict(size=4096, fmt="webp", quality=88, key="rafale", name="Dessault Rafale M",
                   spec_size=1024),
}


# ----------------------------------------------------------------------------------- UV data
class UV:
    """Region map + airframe geometry for one aircraft (see tools/uv_regions.py)."""

    def __init__(self, ac: str):
        self.ac = ac
        self.meta = json.loads((UV_DIR / f"{ac}.json").read_text(encoding="utf-8"))
        self.size = self.meta["texture_size"][0]
        self.reg = np.asarray(Image.open(UV_DIR / f"{ac}_regions.png"))
        g = np.asarray(Image.open(UV_DIR / f"{ac}_geom.png").convert("RGBA"), np.float32) / 255
        self.lat, self.height, self.length = g[..., 0], g[..., 1], g[..., 2]
        self.covered = g[..., 3] > 0.5
        self.regions = {r["name"]: r for r in self.meta["regions"]}
        self.ids = {r["name"]: r["id"] for r in self.meta["regions"]}
        self.paint = np.isin(self.reg, [r["id"] for r in self.meta["regions"] if r["paint"]])

    def mask(self, names) -> np.ndarray:
        """Bool mask for region names. Accepts a name, a list, '*' (every paintable region) or
        a trailing-* prefix like 'wing_*'."""
        if isinstance(names, str):
            names = [names]
        ids = set()
        for n in names:
            if n == "*":
                ids |= {r["id"] for r in self.meta["regions"] if r["paint"]}
            elif n.endswith("*"):
                ids |= {r["id"] for r in self.meta["regions"] if r["name"].startswith(n[:-1])}
            elif n in self.ids:
                ids.add(self.ids[n])
            else:
                raise KeyError(f"{self.ac}: unknown region '{n}'")
        return np.isin(self.reg, sorted(ids))

    def region_names(self):
        return [r["name"] for r in self.meta["regions"]]


# ----------------------------------------------------------------------------------- fonts
@lru_cache(maxsize=64)
def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    """Only fonts bundled in liveries/fonts/ (OFL). Never a system font."""
    path = FONT_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"font {name} is not bundled in liveries/fonts/")
    return ImageFont.truetype(str(path), max(int(size), 4))


def text_image(text, font_name, size, fill, stroke=0, stroke_fill=(0, 0, 0, 255)):
    """RGBA image of `text`, tightly cropped."""
    f = font(font_name, size)
    x0, y0, x1, y1 = f.getbbox(text, stroke_width=stroke)
    im = Image.new("RGBA", (x1 - x0 + 2, y1 - y0 + 2), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((1 - x0, 1 - y0), text, font=f, fill=fill, stroke_width=stroke,
                            stroke_fill=stroke_fill)
    return im


def fit_text(text, font_name, box_w, box_h, fill, stroke_frac=0.0, stroke_fill=(0, 0, 0, 255),
             max_size=2000):
    """Largest text image that fits box_w x box_h (binary search on font size)."""
    lo, hi, best = 4, max_size, None
    while lo <= hi:
        mid = (lo + hi) // 2
        im = text_image(text, font_name, mid, fill, int(mid * stroke_frac), stroke_fill)
        if im.width <= box_w and im.height <= box_h:
            best, lo = im, mid + 1
        else:
            hi = mid - 1
    return best


# ----------------------------------------------------------------------------------- masks
def shift(a, dy, dx, fill=0):
    out = np.full_like(a, fill)
    H, W = a.shape[:2]
    ys, yd = (slice(0, H - dy), slice(dy, H)) if dy >= 0 else (slice(-dy, H), slice(0, H + dy))
    xs, xd = (slice(0, W - dx), slice(dx, W)) if dx >= 0 else (slice(-dx, W), slice(0, W + dx))
    out[yd, xd] = a[ys, xs]
    return out


def erode(m, n=1):
    for _ in range(n):
        m = m & shift(m, 1, 0) & shift(m, -1, 0) & shift(m, 0, 1) & shift(m, 0, -1)
    return m


def dilate(m, n=1):
    for _ in range(n):
        m = m | shift(m, 1, 0) | shift(m, -1, 0) | shift(m, 0, 1) | shift(m, 0, -1)
    return m


def box_blur(a, r):
    if r <= 0:
        return a.astype(np.float32)
    p = np.pad(a.astype(np.float32), ((r + 1, r + 1), (r + 1, r + 1)) + ((0, 0),) * (a.ndim - 2),
               mode="edge")
    c = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s[: a.shape[0], : a.shape[1]] / (k * k)


def blur(a, r):
    """~Gaussian: three box passes."""
    for _ in range(3):
        a = box_blur(a, r)
    return a


def components(mask, min_area=1):
    """Connected components (4-neighbour) of a small bool mask via flood fill.
    -> list of (area, bool mask), largest first."""
    work = Image.fromarray(mask.astype(np.uint8) * 255)
    arr = np.asarray(work).copy()
    out = []
    marker = 1
    ys, xs = np.nonzero(arr == 255)
    for y, x in zip(ys, xs):
        if arr[y, x] != 255:
            continue
        marker = marker % 254 + 1
        im = Image.fromarray(arr).copy()        # fromarray images are read-only views
        ImageDraw.floodfill(im, (int(x), int(y)), marker)
        arr = np.asarray(im).copy()
        m = arr == marker
        arr[m] = 0
        if m.sum() >= min_area:
            out.append((int(m.sum()), m))
    out.sort(key=lambda t: -t[0])
    return out


def inscribed(m):
    """Chamfer-ish distance to the mask edge by repeated erosion. -> (dist array, (y, x), r)."""
    d = np.zeros(m.shape, np.int32)
    cur = m.copy()
    k = 0
    while cur.any():
        d[cur] += 1
        cur = erode(cur)
        k += 1
    y, x = np.unravel_index(np.argmax(d), d.shape)
    return d, (int(y), int(x)), int(d[y, x])


def run_lengths(m, y, x):
    """Horizontal and vertical extent of mask m through (y, x)."""
    row, col = m[y], m[:, x]
    x0 = x
    while x0 > 0 and row[x0 - 1]:
        x0 -= 1
    x1 = x
    while x1 < len(row) - 1 and row[x1 + 1]:
        x1 += 1
    y0 = y
    while y0 > 0 and col[y0 - 1]:
        y0 -= 1
    y1 = y
    while y1 < len(col) - 1 and col[y1 + 1]:
        y1 += 1
    return (x0, x1), (y0, y1)


def bleed(rgb, covered, n=12):
    """Push colours from covered texels outward into the unused gutter, so mipmaps and
    bilinear filtering never pull the gutter colour into a seam."""
    rgb = rgb.astype(np.float32).copy()
    cov = covered.copy()
    for _ in range(n):
        acc = np.zeros_like(rgb)
        cnt = np.zeros(cov.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            c = shift(cov, dy, dx)
            acc += shift(rgb, dy, dx) * c[..., None]
            cnt += c
        grow = (~cov) & (cnt > 0)
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        cov = cov | grow
    return rgb


# ----------------------------------------------------------------------------------- output
def pixel_hash(img: Image.Image) -> str:
    """sha256 of the decoded RGB pixels: stable across encoders, used by the tests."""
    return hashlib.sha256(np.asarray(img.convert("RGB")).tobytes()).hexdigest()


def encode(img: Image.Image, fmt: str, quality: int = 88, cap: int = MAX_BYTES):
    """Encode under the size cap. WebP steps quality down from `quality` in 4s (never below
    60); PNG tries lossless optimize, then an adaptive 256-colour palette. -> (bytes, note)."""
    img = img.convert("RGB")
    if fmt == "webp":
        q = quality
        while True:
            b = io.BytesIO()
            img.save(b, "WEBP", quality=q, method=6)
            if b.tell() <= cap or q <= 60:
                return b.getvalue(), f"webp q{q}"
            q -= 4
    b = io.BytesIO()
    img.save(b, "PNG", optimize=True)
    if b.tell() <= cap:
        return b.getvalue(), "png"
    b = io.BytesIO()
    img.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(
        b, "PNG", optimize=True)
    return b.getvalue(), "png (256-colour palette to fit the cap)"


def save(img: Image.Image, path: Path, fmt: str, quality: int = 88):
    data, note = encode(img, fmt, quality)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data), note
