#!/usr/bin/env python3
"""
Finsonly Air livery factory: layered JSON specs in, LiverySelector-ready textures out.

  python tools/livery_factory.py --all                 build every liveries/specs/*.json
  python tools/livery_factory.py --only f16_rival_steve
  python tools/livery_factory.py --all --contact-sheet also write liveries/out/CONTACT_SHEET.png
  python tools/livery_factory.py --sheets              liveries/out/sheets/<category>.png (pack 2+)
  python tools/livery_factory.py --manifest preview    write liveries/airline.preview.json
  python tools/livery_factory.py --manifest main       append new entries to airline.json

Pillow + numpy only, deterministic (every random draw comes from the spec's seed).

A spec (liveries/specs/<id>.json) is:
  {
    "id": "f16_rival_steve",              must match the file name
    "aircraft": "f16" | "b757" | "rafale",
    "name": "FINSONLY - Rival: STEVE",     LiverySelector list name
    "credits": "FINSONLY Livery Factory",
    "seed": 7,
    "base": {"*": "#f47a20", "wing_bottom": "#fff4e0"},   colour per region, "*" = default
    "layers": [ {"type": ..., ...}, ... ],                 painted in order
    "finish": {"panel_lines": 0.6, "wear": 0.25, "soot": 0.5}
  }

Every layer takes "regions" (name, list, "*" or "prefix*"; default "*") and optional "where",
limits in airframe space: {"length": [a, b], "height": [a, b], "lat": [a, b], "side": "l"|"r"}.
length 0 = nose .. 1 = tail, height 0 = lowest .. 1 = top of the fin, lat 0 = left wingtip ..
1 = right wingtip (see liveries/uv/<ac>.json geom_axes). "opacity" (0..1) on any layer.

Layer types (see liveries/README.md for every field):
  fill       colour
  gradient   kind linear|radial; axis length|height|lat|u|v; stops [[t, colour], ...];
             normalize "airframe" (default) or "region" (0..1 within each region)
  stripe     axis (default height) center, width, slant (axis += slant * length), colour,
             optional outline_color/outline_width, period (repeat every `period`)
  checker    cells (along length), colours [a, b], plane "side" (length x height) or "top"
             (length x lat)
  spots      colour, scale, threshold: 3D value noise in airframe space (cow, camo, grime)
  flames     colours [tip .. root], reach, tongues, outline
  halftone   colour, spacing (texels), axis, from, to (dot size 0..1 along the axis)
  scatter    shape bubble|dot|star|ring, count, size [min, max] (texels), colour
  chrome     tint, streaks: painted-environment fake chrome
  text       text, font (bundled OFL file) or "block", size (texels), colour, stroke
  decal      file (liveries/decals/*.png), size (texels, width)
text and decal are placed with "anchor" {"length", "height", "lat", "side", "facing": "side" or
"top"} (the nearest texel in airframe space, optionally inside "region"), with "region" (+ "component", "at" [fx, fy] in
that island's bbox) or with "pos" [x, y] in texels, oriented with "baseline"/"up" airframe directions such as "+length"
and "+height" (mirrored islands are handled: the art comes out readable on the side you name),
or with a plain "rotate" in degrees.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

SPEC_DIR = lc.LIV / "specs"
OUT_DIR = lc.LIV / "out"
DECAL_DIR = lc.LIV / "decals"
LAYER_TYPES = {"fill", "gradient", "stripe", "checker", "spots", "flames", "halftone", "scatter",
               "chrome", "text", "decal"}
CONF_RANK = {"low": 0, "medium": 1, "high": 2}


class SpecError(ValueError):
    pass


# ----------------------------------------------------------------------------------- colours
def rgba(c):
    """'#rrggbb', '#rrggbbaa' or [r, g, b(, a)] -> float array (4,) in 0..255."""
    if isinstance(c, str):
        m = re.fullmatch(r"#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?", c)
        if not m:
            raise SpecError(f"bad colour {c!r}")
        v = [int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4)]
        v.append(int(m.group(2), 16) if m.group(2) else 255)
        return np.array(v, np.float32)
    if isinstance(c, (list, tuple)) and len(c) in (3, 4) and all(
            isinstance(x, (int, float)) and 0 <= x <= 255 for x in c):
        return np.array(list(c) + ([255] if len(c) == 3 else []), np.float32)
    raise SpecError(f"bad colour {c!r}")


# ----------------------------------------------------------------------------------- validation
def validate_spec(spec: dict, path: Path | None = None) -> dict:
    """Raise SpecError on anything the factory can't build. Returns the spec."""
    where = f"{path.name}: " if path else ""
    for k in ("id", "aircraft", "name", "seed"):
        if k not in spec:
            raise SpecError(f"{where}missing '{k}'")
    if path and spec["id"] != path.stem:
        raise SpecError(f"{where}id '{spec['id']}' must match the file name")
    if not re.fullmatch(r"[a-z0-9_]+", spec["id"]):
        raise SpecError(f"{where}id must be lowercase letters, digits, underscores")
    ac = spec["aircraft"]
    if ac not in lc.AIRCRAFT:
        raise SpecError(f"{where}unknown aircraft '{ac}'")
    if not isinstance(spec["seed"], int):
        raise SpecError(f"{where}seed must be an integer")
    if "listed" in spec and not isinstance(spec["listed"], bool):
        raise SpecError(f"{where}listed must be true or false")
    if "catalog" in spec and not isinstance(spec["catalog"], dict):
        raise SpecError(f"{where}catalog must be an object")
    if ac == "rafale":
        if "rafale" not in spec:
            raise SpecError(f"{where}rafale specs need a 'rafale' block")
        r = spec["rafale"]
        if r.get("finish") not in ("chrome",):
            raise SpecError(f"{where}rafale.finish must be 'chrome'")
        rgba(r.get("tint", "#000000"))
        return spec
    uv = lc.UV(ac)
    names = set(uv.region_names())

    def check_regions(sel, ctx):
        sel = [sel] if isinstance(sel, str) else sel
        if not isinstance(sel, list) or not sel:
            raise SpecError(f"{where}{ctx}: regions must be a name or a list")
        for n in sel:
            if n == "*" or (n.endswith("*") and any(x.startswith(n[:-1]) for x in names)):
                continue
            if n not in names:
                raise SpecError(f"{where}{ctx}: unknown region '{n}' for {ac}")

    base = spec.get("base", {})
    if not isinstance(base, dict):
        raise SpecError(f"{where}base must be an object")
    for k, v in base.items():
        check_regions(k, "base")
        rgba(v)
    for i, L in enumerate(spec.get("layers", [])):
        ctx = f"layer {i}"
        t = L.get("type")
        if t not in LAYER_TYPES:
            raise SpecError(f"{where}{ctx}: unknown type {t!r}")
        check_regions(L.get("regions", "*"), ctx)
        for k in ("color", "outline_color", "stroke_color", "tint"):
            if k in L:
                rgba(L[k])
        for k in ("colors",):
            if k in L:
                for c in L[k]:
                    rgba(c)
        if "stops" in L:
            for s in L["stops"]:
                if len(s) != 2 or not 0 <= float(s[0]) <= 1:
                    raise SpecError(f"{where}{ctx}: stops are [t 0..1, colour]")
                rgba(s[1])
        w = L.get("where", {})
        for k, v in w.items():
            if k == "side":
                if v not in ("l", "r"):
                    raise SpecError(f"{where}{ctx}: where.side is 'l' or 'r'")
            elif k in ("length", "height", "lat"):
                if len(v) != 2:
                    raise SpecError(f"{where}{ctx}: where.{k} is [min, max]")
            else:
                raise SpecError(f"{where}{ctx}: unknown where key '{k}'")
        if t == "text":
            if not L.get("text"):
                raise SpecError(f"{where}{ctx}: text layer needs 'text'")
            f = L.get("font", "Anton-Regular.ttf")
            if f != "block" and not (lc.FONT_DIR / f).exists():
                raise SpecError(f"{where}{ctx}: font {f} is not in liveries/fonts/")
        if t == "decal":
            if not (DECAL_DIR / L.get("file", "")).is_file():
                raise SpecError(f"{where}{ctx}: decal {L.get('file')} not in liveries/decals/")
        if t in ("text", "decal"):
            if "region" in L:
                check_regions(L["region"], ctx)
            elif "pos" not in L and "anchor" not in L:
                raise SpecError(f"{where}{ctx}: {t} needs 'region', 'anchor' or 'pos'")
            for k in L.get("anchor", {}):
                if k not in ("length", "height", "lat", "side", "facing"):
                    raise SpecError(f"{where}{ctx}: unknown anchor key '{k}'")
    return spec


def load_specs(only=None):
    specs = []
    for p in sorted(SPEC_DIR.glob("*.json")):
        if only and p.stem not in only:
            continue
        specs.append((p, validate_spec(json.loads(p.read_text(encoding="utf-8")), p)))
    if only and len(specs) != len(set(only)):
        missing = set(only) - {p.stem for p, _ in specs}
        raise SpecError(f"no spec named {sorted(missing)}")
    return specs


# ----------------------------------------------------------------------------------- noise
def value_noise3(x, y, z, scale, seed, octaves=4):
    """Smooth 3D value noise in 0..1, sampled at airframe coordinates (so it is continuous
    across UV seams). numpy only, seeded."""
    rng = np.random.default_rng(seed)
    N = 64
    grid = rng.random((N, N, N)).astype(np.float32)
    out = np.zeros_like(x, np.float32)
    amp, tot, f = 1.0, 0.0, scale
    for o in range(octaves):
        off = rng.random(3) * N
        gx, gy, gz = x * f + off[0], y * f + off[1], z * f + off[2]
        ix, iy, iz = np.floor(gx).astype(int), np.floor(gy).astype(int), np.floor(gz).astype(int)
        fx, fy, fz = gx - ix, gy - iy, gz - iz
        sx, sy, sz = (t * t * (3 - 2 * t) for t in (fx, fy, fz))
        v = 0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = ((sx if dx else 1 - sx) * (sy if dy else 1 - sy) * (sz if dz else 1 - sz))
                    v = v + w * grid[(ix + dx) % N, (iy + dy) % N, (iz + dz) % N]
        out += amp * v
        tot += amp
        amp *= 0.5
        f *= 2
    return out / tot


# ----------------------------------------------------------------------------------- painter
class Painter:
    def __init__(self, spec):
        self.spec = spec
        self.ac = spec["aircraft"]
        self.uv = lc.UV(self.ac)
        S = self.uv.size
        self.S = S
        self.img = np.zeros((S, S, 3), np.float32)
        self.rng = np.random.default_rng(spec["seed"])
        uv = self.uv
        yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
        self.u, self.v = (xx + 0.5) / S, (yy + 0.5) / S
        # airframe coordinates with real proportions (metres) for isotropic patterns
        b = uv.meta["geom_axes"]["bounds_m"]
        ext = np.array(b["hi"]) - np.array(b["lo"])
        self.m_lat, self.m_h, self.m_len = uv.lat * ext[0], uv.height * ext[1], uv.length * ext[2]
        self.ext = ext
        self.touched = set()

    # --- selection
    def sel(self, L):
        m = self.uv.mask(L.get("regions", "*"))
        self.touched |= {n for n in self.uv.region_names() if (m & (self.uv.reg ==
                         self.uv.ids[n])).any()}
        m = m.astype(np.float32)
        for k, (a, b) in ((k, v) for k, v in L.get("where", {}).items() if k != "side"):
            c = getattr(self.uv, k)
            m *= (c >= a) & (c <= b)
        side = L.get("where", {}).get("side")
        if side == "l":
            m *= self.uv.lat < 0.5
        elif side == "r":
            m *= self.uv.lat >= 0.5
        return m * float(L.get("opacity", 1.0))

    def comp(self, color, alpha):
        c = rgba(color)
        a = (alpha * c[3] / 255)[..., None]
        self.img = self.img * (1 - a) + c[:3] * a

    def comp_rgb(self, rgb, alpha):
        a = alpha[..., None]
        self.img = self.img * (1 - a) + rgb * a

    def axis(self, name):
        if name in ("u", "v"):
            return getattr(self, name)
        if name not in ("length", "height", "lat"):
            raise SpecError(f"bad axis {name}")
        return getattr(self.uv, name)

    @staticmethod
    def aa_band(t, lo, hi, px):
        """Anti-aliased 0..1 membership of t in [lo, hi]; px = t-units per texel."""
        px = np.maximum(px, 1e-6)
        return np.clip((t - lo) / px + 0.5, 0, 1) * np.clip((hi - t) / px + 0.5, 0, 1)

    def texel_step(self, t):
        gy, gx = np.gradient(t)
        g = np.hypot(gx, gy)
        g[~self.uv.covered] = 0
        return np.minimum(g, 0.05)

    # --- layers
    def base(self):
        base = self.spec.get("base", {"*": "#c8c8c8"})
        default = base.get("*", "#c8c8c8")
        self.comp(default, self.uv.mask("*").astype(np.float32))
        for k, v in base.items():
            if k != "*":
                self.comp(v, self.uv.mask(k).astype(np.float32))
                self.touched.add(k)
        self.touched |= {n for n in self.uv.region_names() if self.uv.regions[n]["paint"]}

    def L_fill(self, L):
        self.comp(L["color"], self.sel(L))

    def ramp(self, t, stops):
        stops = sorted(stops, key=lambda s: s[0])
        ts = np.array([s[0] for s in stops], np.float32)
        cs = np.array([rgba(s[1]) for s in stops], np.float32)
        out = np.empty(t.shape + (4,), np.float32)
        for ch in range(4):
            out[..., ch] = np.interp(t, ts, cs[:, ch])
        return out

    def L_gradient(self, L):
        m = self.sel(L)
        if L.get("kind", "linear") == "radial":
            cx, cy = L.get("center", [0.5, 0.5])
            ax = L.get("axes", ["length", "height"])
            a, b = self.axis(ax[0]), self.axis(ax[1])
            t = np.hypot(a - cx, b - cy) / float(L.get("radius", 0.5))
        else:
            t = self.axis(L.get("axis", "length")).copy()
            if L.get("normalize", "airframe") == "region":
                for n in self.uv.region_names():
                    rm = self.uv.reg == self.uv.ids[n]
                    if rm.any():
                        lo, hi = t[rm].min(), t[rm].max()
                        t[rm] = (t[rm] - lo) / max(hi - lo, 1e-6)
            fr = L.get("range", [0, 1])
            t = (t - fr[0]) / max(fr[1] - fr[0], 1e-6)
            if L.get("reverse"):
                t = 1 - t
        col = self.ramp(np.clip(t, 0, 1), L["stops"])
        self.comp_rgb(col[..., :3], m * col[..., 3] / 255)

    def L_stripe(self, L):
        m = self.sel(L)
        t = self.axis(L.get("axis", "height")) + float(L.get("slant", 0)) * self.uv.length
        c, w = float(L["center"]), float(L["width"])
        px = self.texel_step(t)
        if "period" in L:                      # repeating bars (grill marks, racing stripes)
            per = float(L["period"])
            t = (t - c + per / 2) % per - per / 2 + c
        ow = float(L.get("outline_width", 0))
        if ow and "outline_color" in L:
            self.comp(L["outline_color"], m * self.aa_band(t, c - w / 2 - ow, c + w / 2 + ow, px))
        self.comp(L["color"], m * self.aa_band(t, c - w / 2, c + w / 2, px))

    def L_checker(self, L):
        m = self.sel(L)
        n = float(L.get("cells", 40))
        cell = self.ext[2] / n
        a = self.m_len / cell
        b = (self.m_h if L.get("plane", "side") == "side" else self.m_lat) / cell
        k = (np.floor(a) + np.floor(b)) % 2
        ca, cb = L.get("colors", ["#000000", "#ffffff"])
        self.comp(ca, m * (k == 0))
        self.comp(cb, m * (k == 1))

    def noise(self, scale, seed_off=0, octaves=4):
        seed = self.spec["seed"] * 1000 + seed_off
        return value_noise3(self.m_len, self.m_h, self.m_lat, scale, seed, octaves)

    def L_spots(self, L):
        m = self.sel(L)
        n = self.noise(float(L.get("scale", 0.35)), int(L.get("salt", 1)),
                       int(L.get("octaves", 3)))
        th = float(L.get("threshold", 0.55))
        px = self.texel_step(n) + 1e-4
        self.comp(L["color"], m * np.clip((n - th) / px + 0.5, 0, 1))

    def L_flames(self, L):
        """Hot-rod flames licking aft from the nose along the fuselage sides."""
        m = self.sel(L)
        reach = float(L.get("reach", 0.35))            # how far aft the longest tongue gets
        tongues = float(L.get("tongues", 5))
        h0, h1 = L.get("band", [0.2, 0.5])
        hn = (self.uv.height - h0) / max(h1 - h0, 1e-6)
        wob = self.noise(1.2, 77, 2) - 0.5
        ph = hn * tongues + wob * 0.6
        tri = 1 - np.abs(2 * (ph % 1.0) - 1)          # pointed tongues, concave flanks
        edge = reach * (0.3 + 0.7 * tri ** 1.8) + wob * 0.03
        inside = (hn >= -0.1) & (hn <= 1.1)
        t = self.uv.length / np.maximum(edge, 1e-3)
        px = self.texel_step(t) + 1e-4
        body = m * inside * np.clip((1 - t) / px + 0.5, 0, 1)
        cols = L.get("colors", ["#fff36b", "#ff9a1f", "#e8241c"])
        stops = [[i / (len(cols) - 1), c] for i, c in enumerate(cols)]
        if "outline_color" in L:
            ow = float(L.get("outline_width", 0.08))
            self.comp(L["outline_color"], m * inside * np.clip((1 + ow - t) / px + 0.5, 0, 1))
        col = self.ramp(np.clip(t, 0, 1), [[s[0], s[1]] for s in stops])
        self.comp_rgb(col[..., :3], body)

    def L_halftone(self, L):
        m = self.sel(L)
        sp = float(L.get("spacing", 24))
        ang = math.radians(float(L.get("angle", 45)))
        X = (self.u * self.S) * math.cos(ang) + (self.v * self.S) * math.sin(ang)
        Y = -(self.u * self.S) * math.sin(ang) + (self.v * self.S) * math.cos(ang)
        dx = (X / sp) % 1 - 0.5
        dy = (Y / sp) % 1 - 0.5
        d = np.hypot(dx, dy) * sp                      # texels from dot centre
        t = self.axis(L.get("axis", "length"))
        a, b = L.get("from", 1.0), L.get("to", 0.0)
        r = (a + (b - a) * np.clip(t, 0, 1)) * sp * 0.5
        self.comp(L["color"], m * np.clip(r - d + 0.5, 0, 1))

    def L_scatter(self, L):
        m = self.sel(L)
        region_mask = m > 0
        if not region_mask.any():
            return
        ys, xs = np.nonzero(region_mask)
        n = int(L.get("count", 40))
        smin, smax = L.get("size", [10, 40])
        idx = self.rng.integers(0, len(xs), n)
        sizes = self.rng.uniform(smin, smax, n)
        shape = L.get("shape", "bubble")
        col = rgba(L.get("color", "#ffffff"))
        layer = Image.new("RGBA", (self.S, self.S), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        c = tuple(int(x) for x in col)
        for x, y, s in zip(xs[idx], ys[idx], sizes):
            r = s / 2
            box = [x - r, y - r, x + r, y + r]
            if shape == "dot":
                d.ellipse(box, fill=c)
            elif shape in ("bubble", "ring"):
                d.ellipse(box, outline=c, width=max(int(s * 0.09), 2))
                if shape == "bubble":
                    hr = r * 0.28
                    d.ellipse([x - r * 0.45 - hr, y - r * 0.45 - hr, x - r * 0.45 + hr,
                               y - r * 0.45 + hr], fill=c)
            elif shape == "star":
                pts = []
                for k in range(10):
                    a = -math.pi / 2 + k * math.pi / 5
                    rr = r if k % 2 == 0 else r * 0.42
                    pts.append((x + rr * math.cos(a), y + rr * math.sin(a)))
                d.polygon(pts, fill=c)
        a = np.asarray(layer, np.float32)
        self.comp_rgb(a[..., :3], (a[..., 3] / 255) * m)

    def L_chrome(self, L):
        """Painted-environment chrome: a reflection coordinate built from airframe height,
        length and side, run through a sky / horizon / ground ramp, then tinted."""
        m = self.sel(L)
        side = np.where(self.uv.lat < 0.5, -1.0, 1.0)
        n = self.noise(0.25, 5, 2) - 0.5
        t = (self.uv.height * 1.6 + 0.22 * np.sin(self.uv.length * 9.0 + side)
             + 0.18 * np.abs(self.uv.lat - 0.5) * 2 + n * 0.25)
        t = (t * float(L.get("bands", 1.4))) % 1.0
        stops = L.get("stops") or [
            [0.00, "#20242aff"], [0.18, "#5a6068ff"], [0.40, "#e8ecf0ff"], [0.46, "#ffffffff"],
            [0.50, "#3a3a3cff"], [0.56, "#8a8e94ff"], [0.78, "#d8e0e8ff"], [1.00, "#20242aff"]]
        g = self.ramp(t, stops)[..., :3] / 255
        tint = rgba(L.get("tint", "#ffffff"))[:3] / 255
        # metal tint: shadows take the tint's depth, highlights go toward white
        lum = g.mean(-1, keepdims=True)
        col = tint * lum * 1.15 + (lum ** 4) * (1 - tint) * 0.9
        # streak highlights, diagonal in texture space
        k = int(L.get("streaks", 6))
        if k:
            s = (self.u * 0.7 + self.v) * k + (n * 2)
            streak = np.clip(1 - np.abs((s % 1.0) - 0.5) * 18, 0, 1) ** 2
            col = col + streak[..., None] * 0.35
        self.comp_rgb(np.clip(col, 0, 1) * 255, m)

    # --- placed art (text / decals)
    def orient(self, L, cmask):
        """2x2 matrix mapping art (x right, y down) to texture pixels, from the airframe
        directions in L ("baseline", "up") measured on this island. Handles mirroring."""
        if "rotate" in L and "baseline" not in L:
            a = math.radians(-float(L["rotate"]))
            return np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])

        # least-squares plane over the island's interior: robust to the 8-bit geometry steps
        # and to seams (per-texel gradients are mostly 0 with spikes at level boundaries)
        inner = lc.erode(cmask, 2) if lc.erode(cmask, 2).sum() > 50 else cmask
        ys, xs = np.nonzero(inner)
        if len(xs) > 20000:
            pick = np.linspace(0, len(xs) - 1, 20000).astype(int)
            ys, xs = ys[pick], xs[pick]
        A = np.column_stack([xs, ys, np.ones(len(xs))]).astype(np.float64)

        def dirvec(spec):
            sign = -1.0 if spec.startswith("-") else 1.0
            ch = self.axis(spec.lstrip("+-"))
            coef = np.linalg.lstsq(A, ch[ys, xs].astype(np.float64), rcond=None)[0]
            v = np.array([coef[0], coef[1]]) * sign
            nrm = np.linalg.norm(v)
            if nrm < 1e-9:
                raise SpecError(f"{self.spec['id']}: axis {spec} doesn't vary on this island")
            return v / nrm

        bx = dirvec(L.get("baseline", "+length"))
        up = dirvec(L.get("up", "+height"))
        # make 'up' perpendicular to the baseline, keep its side (this is where mirroring lives)
        up = up - bx * (up @ bx)
        if np.linalg.norm(up) < 1e-6:
            up = np.array([-bx[1], bx[0]])
        up /= np.linalg.norm(up)
        extra = math.radians(float(L.get("rotate", 0)))
        if extra:
            c, s = math.cos(extra), math.sin(extra)
            bx, up = bx * c + up * s, up * c - bx * s
        return np.column_stack([bx, -up])            # art x -> baseline, art y(down) -> -up

    def island(self, L):
        """-> (bool mask of the target island, anchor point (x, y) in texels)."""
        if "pos" in L:
            x, y = L["pos"]
            cm = self.uv.mask("*")
            return cm, (float(x), float(y))
        if "anchor" in L:
            # nearest texel (in airframe space) to the requested point, inside the region(s)
            A = L["anchor"]
            rm = self.uv.mask(L.get("region", "*")) & self.uv.covered
            if "side" in A:
                rm &= (self.uv.lat < 0.5) if A["side"] == "l" else (self.uv.lat >= 0.5)
            if "facing" in A:
                # side-facing skin: height changes faster across texels than lateral position
                gy, gx = np.gradient(self.uv.height)
                dh = np.hypot(gx, gy)
                gy, gx = np.gradient(self.uv.lat)
                dl = np.hypot(gx, gy)
                rm &= (dh > 1.5 * dl) if A["facing"] == "side" else (dl > 1.5 * dh)
            d = np.zeros(rm.shape, np.float32)
            for key, ext in (("length", self.ext[2]), ("height", self.ext[1]),
                             ("lat", self.ext[0])):
                if key in A:
                    d += ((getattr(self.uv, key) - float(A[key])) * ext) ** 2
            d[~rm] = np.inf
            if not np.isfinite(d).any():
                raise SpecError(f"{self.spec['id']}: anchor {A} matches no texel")
            y, x = np.unravel_index(np.argmin(d), d.shape)
            R = int(float(L.get("anchor_radius", 96)) * self.S / 2048)
            yy, xx = np.ogrid[: self.S, : self.S]
            local = rm & (np.abs(yy - y) <= R) & (np.abs(xx - x) <= R)
            y0, x0 = max(y - R, 0), max(x - R, 0)
            win = local[y0:y + R + 1, x0:x + R + 1]
            for _, cm in lc.components(win, min_area=1):
                if cm[y - y0, x - x0]:
                    local = np.zeros_like(local)
                    local[y0:y + R + 1, x0:x + R + 1] = cm
                    break
            return local, (float(x), float(y))
        k = max(self.S // 512, 1)
        rm = self.uv.mask(L["region"])[::k, ::k]
        comps = lc.components(rm, min_area=4)
        i = int(L.get("component", 0))
        if i >= len(comps):
            raise SpecError(f"{self.spec['id']}: region {L['region']} has {len(comps)} islands")
        m = comps[i][1]
        big = np.kron(m, np.ones((k, k), bool))[: self.S, : self.S]
        if "at" in L:
            ys, xs = np.nonzero(m)
            fx, fy = L["at"]
            x = (xs.min() + fx * (xs.max() - xs.min())) * k
            y = (ys.min() + fy * (ys.max() - ys.min())) * k
        else:
            _, (y, x), _ = lc.inscribed(m)
            x, y = x * k, y * k
        return big, (float(x), float(y))

    def place(self, art: Image.Image, L):
        cmask, (x, y) = self.island(L)
        M = self.orient(L, cmask)
        w, h = art.size
        # forward: p = M @ (a - [w/2, h/2]) + [x, y]; PIL wants the inverse
        Mi = np.linalg.inv(M)
        off = np.array([w / 2, h / 2]) - Mi @ np.array([x, y])
        warped = art.transform((self.S, self.S), Image.AFFINE,
                               (Mi[0, 0], Mi[0, 1], off[0], Mi[1, 0], Mi[1, 1], off[1]),
                               resample=Image.BICUBIC)
        a = np.asarray(warped, np.float32)
        m = self.sel(L) if L.get("clip", True) else float(L.get("opacity", 1.0))
        self.comp_rgb(a[..., :3], a[..., 3] / 255 * m)

    def L_text(self, L):
        size = int(L.get("size", 80))
        fill = tuple(int(v) for v in rgba(L.get("color", "#ffffff")))
        stroke = int(size * float(L.get("stroke", 0)))
        sc = tuple(int(v) for v in rgba(L.get("stroke_color", "#000000")))
        if L.get("font") == "block":
            art = block_text(L["text"], size, fill, stroke, sc)
        else:
            art = lc.text_image(L["text"], L.get("font", "Anton-Regular.ttf"), size, fill,
                                stroke, sc)
        if "skew" in L:
            sk = float(L["skew"])
            w, h = art.size
            art = art.transform((int(w + abs(sk) * h), h), Image.AFFINE,
                                (1, sk, -max(sk, 0) * h, 0, 1, 0), resample=Image.BICUBIC)
        self.place(art, L)

    def L_decal(self, L):
        art = Image.open(DECAL_DIR / L["file"]).convert("RGBA")
        wpx = int(L.get("size", 256))
        art = art.resize((wpx, max(int(art.height * wpx / art.width), 1)), Image.LANCZOS)
        if "tint" in L:
            t = rgba(L["tint"])
            a = np.asarray(art, np.float32)
            a[..., :3] = a[..., :3] / 255 * t[:3]
            art = Image.fromarray(a.astype(np.uint8))
        self.place(art, L)

    # --- finish
    def finish(self):
        f = self.spec.get("finish", {})
        paint = self.uv.paint & self.uv.covered
        pl = float(f.get("panel_lines", 0.5 if self.ac == "f16" else 0))
        if pl and "shade_png" in self.uv.meta:
            sh = np.asarray(Image.open(lc.ROOT / self.uv.meta["shade_png"]), np.float32)
            mul = 1 + (sh - 128) / 128 * pl * 1.5
            self.img[paint] *= mul[paint][:, None]
        wear = float(f.get("wear", 0.2))
        if wear:
            grime = self.noise(2.5, 11, 4)
            fine = self.noise(14.0, 12, 2)
            low = np.clip(1 - self.uv.height * 2.2, 0, 1)            # belly collects grime
            d = (0.10 * grime + 0.05 * fine + 0.12 * low * grime) * wear
            self.img[paint] *= (1 - d[paint])[:, None]
        soot = float(f.get("soot", 0.4 if self.ac == "f16" else 0))
        if soot:
            aft = np.clip((self.uv.length - 0.86) / 0.14, 0, 1) ** 1.5
            n = self.noise(4.0, 13, 3)
            d = aft * (0.55 + 0.45 * n) * soot * 0.6
            self.img[paint] *= (1 - d[paint])[:, None]
        if "cabin_png" in self.uv.meta and f.get("cabin", True):
            cab = np.asarray(Image.open(lc.ROOT / self.uv.meta["cabin_png"]), np.float32)
            wcol = rgba(f.get("window_color", "#2a2d33"))[:3]
            a = cab[..., 3:4] / 255
            self.img = self.img * (1 - a) + wcol * a
        if "underlay" in self.uv.meta:
            keep = self.uv.covered & ~self.uv.paint
            self.img[keep] = underlay(self.ac)[keep]

    def render(self) -> Image.Image:
        self.base()
        for L in self.spec.get("layers", []):
            getattr(self, "L_" + L["type"])(L)
        self.finish()
        img = lc.bleed(np.clip(self.img, 0, 255), self.uv.covered, n=max(self.S // 128, 8))
        # whatever the bleed didn't reach: the average paint colour, never black
        rest = ~lc.dilate(self.uv.covered, max(self.S // 128, 8))
        img[rest] = img[self.uv.covered & self.uv.paint].mean(0)
        return Image.fromarray(np.round(np.clip(img, 0, 255)).astype(np.uint8))


_UNDERLAY = {}


def underlay(ac):
    """Per texel, the shipped livery's value that most of the others agree with: stock pixels
    wherever most of them left the texture alone (cockpit panels, gear, pilot). Picks whole
    pixels (no blending), ties go to the earlier file, and texels where no two agree get a
    neutral grey."""
    if ac not in _UNDERLAY:
        files = lc.UV(ac).meta["underlay"]
        files = [files] if isinstance(files, str) else files
        stack = np.stack([np.asarray(Image.open(lc.ROOT / f).convert("RGB"), np.int16)
                          for f in files])
        n = len(files)
        votes = np.zeros((n,) + stack.shape[1:3], np.int16)
        for i in range(n):
            for j in range(n):
                if i != j:
                    votes[i] += np.abs(stack[i] - stack[j]).max(-1) < 20
        best = np.argmax(votes - np.arange(n)[:, None, None] * 0.01, axis=0)
        out = np.take_along_axis(stack, best[None, ..., None], 0)[0].astype(np.float32)
        # no two liveries agree: every one of them painted it, so there is no stock pixel
        out[votes.max(0) == 0] = (138, 141, 145)
        _UNDERLAY[ac] = out
    return _UNDERLAY[ac]


# ----------------------------------------------------------------------------------- block text
BLOCK = {  # 5x7 block letters, drawn as filled squares (no font needed)
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "0": ["01110", "10011", "10101", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    " ": ["00000"] * 7,
}


def block_text(text, size, fill, stroke, stroke_fill):
    cell = max(size // 7, 1)
    chars = [BLOCK.get(ch.upper(), BLOCK[" "]) for ch in text]
    W = len(chars) * 6 * cell + 2 * stroke + 2
    H = 7 * cell + 2 * stroke + 2
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for pass_, col, grow in ((0, stroke_fill, stroke), (1, fill, 0)):
        if pass_ == 0 and not stroke:
            continue
        for i, g in enumerate(chars):
            for r, row in enumerate(g):
                for c, bit in enumerate(row):
                    if bit == "1":
                        x = 1 + stroke + (i * 6 + c) * cell
                        y = 1 + stroke + r * cell
                        d.rectangle([x - grow, y - grow, x + cell - 1 + grow, y + cell - 1 + grow],
                                    fill=col)
    return im


# ----------------------------------------------------------------------------------- rafale
def build_rafale(spec):
    """Rafale M chrome: tinted main texture (stock shading, roundels and serials scrubbed) and a
    specular map from tools/build_spec.py's packing (G = roughness, B = metalness) with the whole
    airframe as the chrome mask. Returns (main image, spec image)."""
    r = spec["rafale"]
    stock = np.asarray(Image.open(lc.ROOT / "rafale" / "stock_main_texture.png").convert("RGB"),
                       np.float32)
    used = stock.sum(2) > 0
    L = stock.mean(2)
    # national markings: saturated pixels (roundels) and wide dark text blobs
    sat = stock.max(2) - stock.min(2)
    mean_bg = lc.blur(np.where(used, L, 0), 16) / np.maximum(lc.blur(used.astype(np.float32), 16),
                                                             1e-3)
    dev = L - mean_bg
    dense_dark = lc.box_blur((dev < -8).astype(np.float32), 8) > 0.25     # lettering, serials
    mark = (sat > 40) | dense_dark | ((np.abs(dev) > 14) & lc.erode(np.abs(dev) > 14, 3))
    mark = lc.dilate(mark, 18) & used
    ok = used & ~mark
    num = lc.blur(np.where(ok, L, 0), 24)
    den = np.maximum(lc.blur(ok.astype(np.float32), 24), 1e-3)
    low = num / den
    detail = np.where(ok, np.clip(L - low, -18, 18), 0)
    shade = (low / max(low[used].mean(), 1)) * 0.25 + 0.75 + detail / 255 * 1.2
    tint = rgba(r["tint"])[:3]
    main = np.clip(tint * shade[..., None], 0, 255) * used[..., None]
    # specular via tools/build_spec.py's packing
    sys.path.insert(0, str(lc.ROOT / "tools"))
    base = np.asarray(Image.open(lc.ROOT / "rafale" / "stock_specular.png").convert("RGB"),
                      np.float32)
    chrome_mask = np.ones(base.shape[:2], np.float32)
    spec_img = pack_specular(base, chrome_mask, rough=int(r.get("roughness", 14)),
                             metal=int(r.get("metalness", 255)))
    return (Image.fromarray(main.astype(np.uint8)), Image.fromarray(spec_img))


def pack_specular(base, m, rough=12, metal=255, paint_rough=110, paint_metal=0):
    """Exactly tools/build_spec.py: R unused, G roughness, B metalness; mask white = chrome;
    stock black gutters preserved."""
    paint = base.copy()
    paint[..., 1] = paint_rough
    paint[..., 2] = paint_metal
    chrome = np.zeros_like(base)
    chrome[..., 1] = rough
    chrome[..., 2] = metal
    used = (base.sum(axis=2) > 0)[..., None]
    out = (paint * (1 - m[..., None]) + chrome * m[..., None]) * used
    return out.clip(0, 255).astype(np.uint8)


# ----------------------------------------------------------------------------------- build
def out_paths(spec):
    ac = spec["aircraft"]
    fmt = lc.AIRCRAFT[ac]["fmt"]
    if ac == "rafale":
        return [OUT_DIR / f"{spec['id']}_main.webp", OUT_DIR / f"{spec['id']}_spec.webp"]
    return [OUT_DIR / f"{spec['id']}.{fmt}"]


def render(spec):
    """-> list of PIL images (one per output path)."""
    if spec["aircraft"] == "rafale":
        return list(build_rafale(spec))
    return [Painter(spec).render()]


def lowest_confidence(spec):
    """Lowest confidence among the regions this livery paints (what the contact sheet shows)."""
    if spec["aircraft"] == "rafale":
        return "n/a (no Rafale map; whole-airframe tint)"
    uv = lc.UV(spec["aircraft"])
    confs = [uv.regions[n]["confidence"] for n in uv.region_names() if uv.regions[n]["paint"]]
    return min(confs, key=lambda c: CONF_RANK[c])


def build(spec, write=True):
    imgs = render(spec)
    ac = spec["aircraft"]
    results = []
    for img, path in zip(imgs, out_paths(spec)):
        if ac == "rafale" and path.stem.endswith("_spec"):
            data = _encode_lossless_webp(img)
            note = "webp lossless"
        else:
            data, note = lc.encode(img, lc.AIRCRAFT[ac]["fmt"], lc.AIRCRAFT[ac].get("quality", 88))
        if write:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        results.append(dict(path=path, bytes=len(data), note=note, hash=lc.pixel_hash(img),
                            size=img.size))
    return results


def _encode_lossless_webp(img):
    import io
    b = io.BytesIO()
    img.convert("RGB").save(b, "WEBP", lossless=True, method=6)
    return b.getvalue()


# ----------------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="Finsonly Air livery factory")
    ap.add_argument("--all", action="store_true", help="build every spec")
    ap.add_argument("--only", nargs="+", metavar="ID", help="build these spec ids")
    ap.add_argument("--contact-sheet", action="store_true",
                    help="write liveries/out/CONTACT_SHEET.png from the built outputs")
    ap.add_argument("--sheets", action="store_true",
                    help="write liveries/out/sheets/<category>.png for pack-2+ specs")
    ap.add_argument("--manifest", choices=["preview", "main"],
                    help="preview: liveries/airline.preview.json; main: append to airline.json")
    ap.add_argument("--check", action="store_true", help="validate specs only")
    a = ap.parse_args(argv)
    if not (a.all or a.only or a.contact_sheet or a.sheets or a.manifest or a.check):
        ap.error("nothing to do: pass --all, --only, --contact-sheet, --sheets, --manifest or "
                 "--check")
    specs = load_specs(a.only) if (a.all or a.only or a.check) else []
    if a.check:
        print(f"{len(specs)} specs OK")
    elif specs:
        for p, spec in specs:
            for r in build(spec):
                cap = "OK" if r["bytes"] <= lc.MAX_BYTES else "OVER CAP"
                print(f"{spec['id']:28s} {r['path'].relative_to(lc.ROOT)}  {r['size'][0]}px "
                      f"{r['bytes'] / 1e6:.2f} MB {r['note']}  {cap}")
    if a.contact_sheet:
        import livery_sheet
        path = livery_sheet.contact_sheet([s for _, s in load_specs()])
        print(f"contact sheet -> {path.relative_to(lc.ROOT)}")
    if a.sheets:
        import livery_sheet
        for path in livery_sheet.category_sheets([s for _, s in load_specs()]):
            print(f"sheet -> {path.relative_to(lc.ROOT)}")
    if a.manifest:
        import livery_manifest
        paths = livery_manifest.write(a.manifest, [s for _, s in load_specs()])
        for p in paths:
            print(f"manifest -> {p.relative_to(lc.ROOT)}")


if __name__ == "__main__":
    main()
