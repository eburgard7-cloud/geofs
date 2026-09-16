#!/usr/bin/env python3
"""
Rafale M chrome specular builder (GeoFS / LiverySelector).

Rafale "Specular shader" slot = glTF metallicRoughness packing:
  R = unused (~0)   G = roughness (0 mirror .. 255 matte)   B = metalness (0 paint .. 255 metal)
Same UV layout as the main texture (spec is 1024^2, main is 4096^2).

Usage:
  python build_spec.py MASK.png [--base stock_specular.png] [--out specular_chrome.png]
                       [--rough 12] [--metal 255] [--paint-rough 110] [--paint-metal 0]

MASK.png: paint it over the 4096 main texture. White = chrome, black = paint,
grey = blend (brushed / satin). Any size; resized to 1024.
Paint areas get --paint-* values (glossy car-paint default). Pass --keep-paint
to leave non-chrome areas at stock values instead.
"""
import argparse
import numpy as np
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument("mask")
p.add_argument("--base", default="stock_specular.png")
p.add_argument("--out", default="specular_chrome.png")
p.add_argument("--rough", type=int, default=12)
p.add_argument("--metal", type=int, default=255)
p.add_argument("--paint-rough", type=int, default=110)
p.add_argument("--paint-metal", type=int, default=0)
p.add_argument("--keep-paint", action="store_true")
a = p.parse_args()

base = np.array(Image.open(a.base).convert("RGB")).astype(np.float32)
h, w = base.shape[:2]
m = np.array(Image.open(a.mask).convert("L").resize((w, h), Image.LANCZOS)).astype(np.float32) / 255.0

paint = base.copy()
if not a.keep_paint:
    paint[..., 1] = a.paint_rough
    paint[..., 2] = a.paint_metal
chrome = np.zeros_like(base)
chrome[..., 1] = a.rough
chrome[..., 2] = a.metal

# preserve stock black gutters (unused UV space) so seams don't bleed
used = (base.sum(axis=2) > 0)[..., None]
out = (paint * (1 - m[..., None]) + chrome * m[..., None]) * used
Image.fromarray(out.clip(0, 255).astype(np.uint8)).save(a.out)
print(f"wrote {a.out} ({w}x{h}), chrome coverage {m[used[...,0]].mean():.1%}")
