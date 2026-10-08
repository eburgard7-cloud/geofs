#!/usr/bin/env python3
"""
Paint kits for friends who want to paint their own livery (Garage "Upload own texture").

Per aircraft (F-16, 757), into liveries/kit/:
  <ac>_kit_blank.<fmt>    neutral primer at the native size: start painting on this
  <ac>_kit_guides.png     transparent overlay: region outlines + names, and red hatching on texels
                          nobody sees from outside (put it on top as a reference layer, hide it
                          before exporting)
  README.md               the rules (size, format, cap, what's mirrored)

  python tools/paint_kit.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

KIT = lc.LIV / "kit"
KITS = ("f16", "b757")
LINE = (255, 0, 200, 255)
HATCH = (255, 40, 40, 110)


def blank_spec(ac):
    return {"id": f"{ac}_kit_blank", "aircraft": ac, "name": "Paint kit blank", "seed": 1,
            "base": {"*": "#b9bdc3"},
            "finish": {"panel_lines": 0.5, "wear": 0.0, "soot": 0.0} if ac == "f16" else
                      {"wear": 0.0}}


def guides(ac) -> Image.Image:
    uv = lc.UV(ac)
    S = uv.size
    reg = uv.reg.astype(np.int32)
    edge = np.zeros(reg.shape, bool)
    edge[:, 1:] |= reg[:, 1:] != reg[:, :-1]
    edge[1:, :] |= reg[1:, :] != reg[:-1, :]
    edge &= uv.covered | lc.shift(uv.covered, 0, 1) | lc.shift(uv.covered, 1, 0)
    edge = lc.dilate(edge, max(S // 1024, 1))
    rgba = np.zeros((S, S, 4), np.uint8)
    hidden = uv.covered & ~uv.paint
    yy, xx = np.mgrid[0:S, 0:S]
    rgba[hidden & (((xx + yy) // max(S // 256, 4)) % 2 == 0)] = HATCH
    rgba[edge] = LINE
    im = Image.fromarray(rgba, "RGBA")
    d = ImageDraw.Draw(im)
    f = lc.font("Anton-Regular.ttf", max(S // 80, 10))
    k = max(S // 512, 1)
    for r in uv.meta["regions"]:
        if not r["paint"]:
            continue
        m = (uv.reg == r["id"])[::k, ::k]
        comps = lc.components(m, min_area=12)
        for area, cm in comps[:2]:
            _, (y, x), rad = lc.inscribed(cm)
            if rad < 3:
                continue
            label = r["name"]
            x0, y0, x1, y1 = d.textbbox((0, 0), label, font=f)
            px, py = x * k - (x1 - x0) / 2, y * k - (y1 - y0) / 2
            d.text((px, py), label, font=f, fill=(255, 255, 255, 255), stroke_width=2,
                   stroke_fill=(0, 0, 0, 255))
    return im


def main():
    import livery_factory as F
    KIT.mkdir(parents=True, exist_ok=True)
    for ac in KITS:
        img = F.Painter(F.validate_spec(blank_spec(ac))).render()
        fmt = lc.AIRCRAFT[ac]["fmt"]
        n, note = lc.save(img, KIT / f"{ac}_kit_blank.{fmt}", fmt, lc.AIRCRAFT[ac].get("quality", 88))
        print(f"liveries/kit/{ac}_kit_blank.{fmt}  {n / 1e6:.2f} MB {note}")
        g = guides(ac)
        g.save(KIT / f"{ac}_kit_guides.png", optimize=True)
        print(f"liveries/kit/{ac}_kit_guides.png")


if __name__ == "__main__":
    main()
