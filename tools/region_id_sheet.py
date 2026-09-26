#!/usr/bin/env python3
"""
Region-ID test sheets: every UV region flat-filled with its own colour and its name printed
large inside it, plus a NOSE arrow on each island (toward the nose, from the geometry map).
Unused texture space is grey with magenta hatching, so if magenta ever shows in-sim the map is
wrong there.

  liveries/test/f16_region_id.webp   (2048, WebP, the F-16 slot's native format)
  liveries/test/b757_region_id.png   (1024, PNG)

Load them in GeoFS through the preview manifest ("REGION ID" liveries) and compare against
liveries/uv/<ac>.json. Text that reads backwards on one side is expected on mirrored islands
(the F-16 fin and wing undersides, the 757 right side).

Usage: python tools/region_id_sheet.py [--only f16|b757]
"""
from __future__ import annotations

import argparse
import colorsys
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

FONT = "Anton-Regular.ttf"
OUT = {"f16": lc.LIV / "test" / "f16_region_id.webp", "b757": lc.LIV / "test" / "b757_region_id.png"}


def region_colours(n):
    """Evenly spread, saturated hues; alternate lightness so neighbours in id order differ."""
    out = []
    for i in range(n):
        h = (i * 0.381966) % 1.0
        v = 0.95 if i % 2 == 0 else 0.7
        s = 0.85 if i % 3 else 0.6
        out.append(tuple(int(255 * c) for c in colorsys.hsv_to_rgb(h, s, v)))
    return out


def hatch(size):
    yy, xx = np.mgrid[0:size, 0:size]
    img = np.full((size, size, 3), 96, np.uint8)
    img[((xx + yy) // max(size // 128, 2)) % 6 == 0] = (255, 0, 255)
    return img


def arrow(draw, cx, cy, ang, length, width, fill, outline):
    """Filled arrow centred on (cx, cy) pointing at angle `ang` (radians, image coords)."""
    dx, dy = math.cos(ang), math.sin(ang)
    px, py = -dy, dx
    h = length / 2
    hw = width / 2
    head = length * 0.45
    pts = [
        (cx - dx * h + px * hw * 0.45, cy - dy * h + py * hw * 0.45),
        (cx + dx * (h - head) + px * hw * 0.45, cy + dy * (h - head) + py * hw * 0.45),
        (cx + dx * (h - head) + px * hw, cy + dy * (h - head) + py * hw),
        (cx + dx * h, cy + dy * h),
        (cx + dx * (h - head) - px * hw, cy + dy * (h - head) - py * hw),
        (cx + dx * (h - head) - px * hw * 0.45, cy + dy * (h - head) - py * hw * 0.45),
        (cx - dx * h - px * hw * 0.45, cy - dy * h - py * hw * 0.45),
    ]
    draw.polygon(pts, fill=fill, outline=outline, width=max(int(width * 0.08), 1))


def build(ac):
    uv = lc.UV(ac)
    S = uv.size
    names = uv.region_names()
    cols = region_colours(len(names))
    img = hatch(S).astype(np.float32)
    rgb = np.zeros((S, S, 3), np.float32)
    for i, n in enumerate(names):
        rgb[uv.reg == i + 1] = cols[i]
    cov = uv.reg > 0
    rgb = lc.bleed(rgb, cov, n=max(S // 256, 4))
    grown = lc.dilate(cov, max(S // 256, 4))
    img[grown] = rgb[grown]
    im = Image.fromarray(img.astype(np.uint8))
    draw = ImageDraw.Draw(im)

    k = max(S // 512, 1)                     # find islands on a smaller grid (fast)
    small = uv.reg[::k, ::k]
    Ls = uv.length[::k, ::k]
    labelled = 0
    for i, n in enumerate(names):
        rid = i + 1
        comps = lc.components(small == rid, min_area=40)
        for area, m in comps[:4]:
            d, (y, x), r = lc.inscribed(m)
            if r < 3:
                continue
            (x0, x1), (y0, y1) = lc.run_lengths(m, y, x)
            wh, hh = (x1 - x0) * k, min(2 * r * 1.3, (y1 - y0)) * k
            wv, hv = (y1 - y0) * k, min(2 * r * 1.3, (x1 - x0)) * k
            text = f"{rid} {n.upper()}"
            lum = 0.3 * cols[i][0] + 0.59 * cols[i][1] + 0.11 * cols[i][2]
            fg = (0, 0, 0, 255) if lum > 140 else (255, 255, 255, 255)
            sf = (255, 255, 255, 255) if fg[0] == 0 else (0, 0, 0, 255)
            th = lc.fit_text(text, FONT, int(wh * 0.9), int(hh * 0.62), fg, 0.04, sf, 600)
            tv = lc.fit_text(text, FONT, int(wv * 0.9), int(hv * 0.62), fg, 0.04, sf, 600)
            if tv is not None and (th is None or tv.height > th.height * 1.15):
                t = tv.rotate(90, expand=True)
            else:
                t = th
            if t is None or min(t.size) < 10:
                continue
            cx, cy = x * k, y * k
            # NOSE arrow: toward decreasing airframe length (the nose), from the geometry map
            gy, gx = np.gradient(np.where(m, Ls, np.nan))
            gx, gy = np.nanmean(gx[m]), np.nanmean(gy[m])
            if np.isfinite(gx) and math.hypot(gx, gy) > 1e-4:
                ang = math.atan2(-gy, -gx)
                al = min(r * k * 1.1, S / 10)
                off = min(t.size) * 0.5 + al * 0.35
                ax_, ay_ = cx - math.sin(ang) * off, cy + math.cos(ang) * off
                arrow(draw, ax_, ay_, ang, al, al * 0.45, fg[:3], sf[:3])
                cy = cy - math.cos(ang) * off * 0.25
                cx = cx + math.sin(ang) * off * 0.25
            px = int(min(max(cx - t.width / 2, 0), S - t.width))
            py = int(min(max(cy - t.height / 2, 0), S - t.height))
            im.paste(t, (px, py), t)
            labelled += 1
    fmt = lc.AIRCRAFT[ac]["fmt"]
    nbytes, note = lc.save(im, OUT[ac], fmt, 90)
    print(f"{ac}: {labelled} labels -> {OUT[ac].relative_to(lc.ROOT)} ({nbytes} bytes, {note})")
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=sorted(OUT))
    a = ap.parse_args()
    for ac in [a.only] if a.only else sorted(OUT):
        build(ac)


if __name__ == "__main__":
    main()
