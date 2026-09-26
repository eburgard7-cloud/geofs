"""
liveries/out/CONTACT_SHEET.png: every built livery as a flat thumbnail, plus two 3D views on the
real GeoFS mesh when the model cache is present (tools/livery_preview.py), with its name, spec
id, output file and the lowest confidence of the UV regions it paints.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

OUT = lc.LIV / "out" / "CONTACT_SHEET.png"
FLAT = 220
VW, VH = 330, 220
PAD = 14
CAP = 64
BG = (244, 245, 247)
INK = (27, 27, 34)
GREY = (110, 114, 122)


def card(spec, with_3d=True):
    import livery_factory as F
    import livery_preview as P
    paths = F.out_paths(spec)
    tex = Image.open(paths[0]).convert("RGB")
    views = P.views(spec["aircraft"], tex, VW, VH) if with_3d else []
    w = FLAT + (VW + PAD) * 2          # same width with or without 3D views (captions fit)
    im = Image.new("RGB", (w, FLAT + CAP), BG)
    im.paste(tex.resize((FLAT, FLAT), Image.LANCZOS), (0, 0))
    for i, (_, v) in enumerate(views):
        im.paste(v, (FLAT + PAD + i * (VW + PAD), (FLAT - VH) // 2))
    d = ImageDraw.Draw(im)
    d.text((0, FLAT + 6), spec["name"], font=lc.font("Anton-Regular.ttf", 22), fill=INK)
    conf = F.lowest_confidence(spec)
    rel = ", ".join(p.relative_to(lc.ROOT).as_posix() for p in paths)
    d.text((0, FLAT + 36), f"{spec['id']}  |  lowest region confidence: {conf}  |  {rel}",
           font=lc.font("Anton-Regular.ttf", 15), fill=GREY)
    return im


def contact_sheet(specs, with_3d=True, cols=2):
    cards = [card(s, with_3d) for s in specs]
    cw = max(c.width for c in cards)
    ch = max(c.height for c in cards)
    rows = (len(cards) + cols - 1) // cols
    head = 90
    sheet = Image.new("RGB", (PAD + cols * (cw + PAD * 2), head + rows * (ch + PAD * 2)), BG)
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 14), "FINSONLY AIR  -  LIVERY PACK 1", font=lc.font("Bungee-Regular.ttf", 38),
           fill=INK)
    note = ("Flat texture + crude 3D wrap on the real GeoFS mesh (flat shading, no specular). "
            "UNVERIFIED IN-SIM until Eric's check. Rafale: flat only (no Rafale mesh cached).")
    d.text((PAD, 60), note, font=lc.font("Anton-Regular.ttf", 16), fill=GREY)
    for i, c in enumerate(cards):
        r, k = divmod(i, cols)
        sheet.paste(c, (PAD + k * (cw + PAD * 2), head + r * (ch + PAD * 2)))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT, optimize=True)
    return OUT
