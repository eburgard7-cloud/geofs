#!/usr/bin/env python3
"""
Draw the Finsonly Air decal set into liveries/decals/*.png (512 px RGBA, original art).

Everything is drawn from primitives at 4x and downsampled, so it's deterministic and owes
nothing to anyone. Re-run after editing: python tools/make_decals.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

N = 512
K = 4
OUT = lc.LIV / "decals"
INK = (20, 20, 24, 255)


def canvas():
    im = Image.new("RGBA", (N * K, N * K), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def s(*v):
    return [x * K for x in v]


def done(im, name):
    OUT.mkdir(parents=True, exist_ok=True)
    im.resize((N, N), Image.LANCZOS).save(OUT / f"{name}.png", optimize=True)


def poly_round(d, pts, fill, outline=None, width=0):
    d.polygon([(x * K, y * K) for x, y in pts], fill=fill)
    if outline:
        d.line([(x * K, y * K) for x, y in pts + pts[:1]], fill=outline, width=width * K,
               joint="curve")


def goldfish():
    im, d = canvas()
    # tail
    poly_round(d, [(120, 256), (30, 150), (60, 256), (30, 362)], (255, 140, 30, 255), INK, 10)
    # body
    d.ellipse(s(100, 150, 430, 362), fill=(255, 128, 20, 255), outline=INK, width=10 * K)
    # belly highlight
    d.ellipse(s(200, 260, 400, 340), fill=(255, 190, 90, 255))
    # fins
    poly_round(d, [(230, 160), (300, 90), (330, 170)], (255, 160, 60, 255), INK, 8)
    poly_round(d, [(260, 345), (300, 410), (320, 340)], (255, 160, 60, 255), INK, 8)
    # scales
    for i, (x, y) in enumerate([(220, 220), (260, 200), (260, 250), (300, 225), (220, 270)]):
        d.arc(s(x - 22, y - 22, x + 22, y + 22), 200, 340, fill=(200, 80, 10, 255), width=5 * K)
    # eye
    d.ellipse(s(335, 195, 395, 255), fill=(255, 255, 255, 255), outline=INK, width=6 * K)
    d.ellipse(s(358, 212, 386, 240), fill=INK)
    d.ellipse(s(362, 214, 372, 224), fill=(255, 255, 255, 255))
    # grumpy brow (STEVE holds grudges)
    d.line(s(330, 188, 392, 202), fill=INK, width=9 * K)
    # mouth
    d.arc(s(395, 255, 430, 290), 120, 240, fill=INK, width=6 * K)
    done(im, "goldfish")


def bubbles():
    im, d = canvas()
    for x, y, r in [(150, 380, 90), (330, 250, 70), (230, 150, 50), (390, 110, 35),
                    (300, 420, 30), (430, 330, 22)]:
        d.ellipse(s(x - r, y - r, x + r, y + r), outline=(255, 255, 255, 255), width=int(r * .14) * K)
        d.ellipse(s(x - r * .55, y - r * .6, x - r * .15, y - r * .2), fill=(255, 255, 255, 255))
    done(im, "bubbles")


def bratwurst():
    im, d = canvas()
    # sausage body: fat rounded bar, slightly curved
    pts = []
    for i in range(41):
        t = i / 40
        x = 60 + t * 392
        y = 256 - math.sin(t * math.pi) * 40
        pts.append((x, y))
    for w, col in ((118, INK), (100, (176, 96, 44, 255))):
        for x, y in pts:
            r = w / 2
            d.ellipse(s(x - r, y - r, x + r, y + r), fill=col)
    # highlight
    for x, y in pts[6:34]:
        d.ellipse(s(x - 10, y - 32, x + 10, y - 22), fill=(214, 140, 82, 255))
    # grill marks (diagonal)
    for i in range(6):
        x = 120 + i * 55
        y = 256 - math.sin((x - 60) / 392 * math.pi) * 40
        d.line(s(x - 18, y + 30, x + 18, y - 30), fill=(70, 34, 16, 255), width=12 * K)
    # mustard squiggle
    sq = [(90 + i * 8, 250 - math.sin((90 + i * 8 - 60) / 392 * math.pi) * 40
           + math.sin(i * 0.9) * 10) for i in range(42)]
    d.line([(x * K, y * K) for x, y in sq], fill=(226, 180, 20, 255), width=11 * K, joint="curve")
    done(im, "bratwurst")


def paw():
    im, d = canvas()
    gold = (212, 175, 55, 255)
    d.ellipse(s(150, 250, 362, 440), fill=gold, outline=INK, width=8 * K)
    for x, y, r in [(120, 190, 48), (205, 120, 50), (307, 120, 50), (392, 190, 48)]:
        d.ellipse(s(x - r, y - r * 1.2, x + r, y + r * 1.2), fill=gold, outline=INK, width=8 * K)
    done(im, "paw")


def medal():
    im, d = canvas()
    # ribbon in FINSONLY orange and teal
    poly_round(d, [(180, 20), (250, 20), (290, 230), (220, 230)], (244, 122, 32, 255), INK, 6)
    poly_round(d, [(262, 20), (332, 20), (292, 230), (222, 230)], (20, 150, 150, 255), INK, 6)
    # disc
    d.ellipse(s(126, 200, 386, 460), fill=(255, 255, 255, 255), outline=INK, width=10 * K)
    d.ellipse(s(150, 224, 362, 436), outline=INK, width=5 * K)
    # a fish, not a star
    poly_round(d, [(176, 330), (226, 290), (300, 286), (346, 330), (300, 374), (226, 370)], INK)
    poly_round(d, [(186, 330), (160, 296), (160, 364)], INK)
    d.ellipse(s(308, 316, 326, 334), fill=(255, 255, 255, 255))
    done(im, "medal")


def trophy():
    im, d = canvas()
    w = (255, 255, 255, 255)
    # cup
    d.pieslice(s(116, 20, 396, 330), 0, 180, fill=w, outline=INK, width=10 * K)
    d.rectangle(s(116, 60, 396, 175), fill=w)
    d.line(s(116, 60, 116, 175), fill=INK, width=10 * K)
    d.line(s(396, 60, 396, 175), fill=INK, width=10 * K)
    d.line(s(110, 60, 402, 60), fill=INK, width=10 * K)
    # handles
    d.arc(s(40, 80, 160, 220), 90, 270, fill=INK, width=14 * K)
    d.arc(s(352, 80, 472, 220), 270, 90, fill=INK, width=14 * K)
    # stem and base
    d.rectangle(s(230, 320, 282, 400), fill=w, outline=INK, width=8 * K)
    d.rectangle(s(150, 400, 362, 460), fill=w, outline=INK, width=10 * K)
    done(im, "trophy")


def evergreen():
    im, d = canvas()
    g = (24, 92, 52, 255)
    for i, (y0, y1, hw) in enumerate([(30, 190, 90), (120, 300, 140), (220, 420, 190)]):
        poly_round(d, [(256, y0), (256 + hw, y1), (256 - hw, y1)], g, INK, 8)
    d.rectangle(s(226, 420, 286, 490), fill=(92, 60, 30, 255), outline=INK, width=8 * K)
    done(im, "evergreen")


def raindrop():
    im, d = canvas()
    c = (170, 190, 205, 255)
    pts = [(256, 40)]
    for i in range(0, 181, 10):
        a = math.radians(i)
        pts.append((256 + 150 * math.cos(a), 330 + 150 * math.sin(a)))
    poly_round(d, pts[:1] + pts[1:], c, INK, 8)
    d.ellipse(s(180, 290, 230, 360), fill=(235, 242, 248, 255))
    done(im, "raindrop")


def badger():
    """Generic badger face, front on: white stripe, dark eye masks. Original."""
    im, d = canvas()
    grey, white, dark = (150, 146, 140, 255), (250, 248, 240, 255), (40, 36, 34, 255)
    d.ellipse(s(96, 60, 176, 150), fill=grey, outline=INK, width=8 * K)     # ears
    d.ellipse(s(336, 60, 416, 150), fill=grey, outline=INK, width=8 * K)
    poly_round(d, [(256, 470), (80, 250), (110, 110), (402, 110), (432, 250)], grey, INK, 10)
    poly_round(d, [(256, 450), (214, 250), (230, 110), (282, 110), (298, 250)], white)
    for sx in (-1, 1):                                                     # eye masks
        poly_round(d, [(256 + sx * 40, 150), (256 + sx * 150, 180), (256 + sx * 170, 330),
                       (256 + sx * 60, 380)], dark)
        d.ellipse(s(256 + sx * 105 - 16, 250, 256 + sx * 105 + 16, 282), fill=white)
    d.ellipse(s(226, 400, 286, 450), fill=dark)                            # nose
    done(im, "badger")


def sun():
    im, d = canvas()
    for i, col in enumerate([(255, 214, 64, 255), (255, 150, 40, 255), (255, 70, 120, 255)]):
        r = 230 - i * 50
        d.ellipse(s(256 - r, 256 - r, 256 + r, 256 + r), fill=col)
    for k in range(6):                                                     # retro sun cuts
        y = 280 + k * 34
        d.rectangle(s(0, y, 512, y + 8 + k * 2), fill=(0, 0, 0, 0))
    done(im, "sun")


def palm():
    im, d = canvas()
    trunk = [(250 + math.sin(t / 60) * 30, 500 - t) for t in range(0, 300, 10)]
    d.line([(x * K, y * K) for x, y in trunk], fill=(40, 30, 30, 255), width=26 * K,
           joint="curve")
    tx, ty = trunk[-1]
    for a in (-160, -125, -90, -55, -20, 15):
        r = math.radians(a)
        ex, ey = tx + math.cos(r) * 190, ty + math.sin(r) * 120 + 60
        mx, my = tx + math.cos(r) * 100, ty + math.sin(r) * 110 - 20
        poly_round(d, [(tx, ty), (mx, my - 18), (ex, ey), (mx, my + 18)], (20, 110, 70, 255))
    done(im, "palm")


def mountains():
    im, d = canvas()
    poly_round(d, [(0, 420), (140, 150), (230, 300), (330, 90), (512, 420)],
               (40, 110, 120, 255), INK, 8)
    poly_round(d, [(100, 205), (140, 150), (180, 210), (160, 230), (140, 205), (120, 225)],
               (250, 252, 255, 255))
    poly_round(d, [(285, 160), (330, 90), (378, 170), (350, 190), (330, 160), (305, 185)],
               (250, 252, 255, 255))
    for i in range(4):                                                     # fjord water
        y = 440 + i * 18
        d.line(s(40 + i * 20, y, 472 - i * 20, y), fill=(120, 210, 215, 255), width=8 * K)
    done(im, "mountains")


def fishmark():
    """FINSONLY house mark: a fish outline with a lightning bolt eye line."""
    im, d = canvas()
    w = (255, 255, 255, 255)
    poly_round(d, [(60, 256), (150, 150), (330, 130), (450, 256), (330, 382), (150, 362)],
               (0, 0, 0, 0), w, 22)
    poly_round(d, [(60, 256), (10, 170), (10, 342)], w)
    d.ellipse(s(360, 220, 400, 260), fill=w)
    poly_round(d, [(250, 170), (205, 265), (245, 262), (215, 345), (290, 235), (250, 238),
                   (280, 170)], w)
    done(im, "fishmark")


ALL = [goldfish, bubbles, bratwurst, paw, medal, trophy, evergreen, raindrop, badger, sun, palm,
       mountains, fishmark]

if __name__ == "__main__":
    for f in ALL:
        f()
        print(f"liveries/decals/{f.__name__}.png")
