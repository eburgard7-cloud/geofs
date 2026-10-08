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


# ----------------------------------------------------------------------------- pack 2 decals
def _star_pts(cx, cy, r_out, r_in, n=5, rot=-90):
    pts = []
    for k in range(n * 2):
        a = math.radians(rot + k * 180 / n)
        r = r_out if k % 2 == 0 else r_in
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def snowflake():
    im, d = canvas()
    w = (255, 255, 255, 255)
    for k in range(6):
        a = math.radians(k * 60)
        ex, ey = 256 + 220 * math.cos(a), 256 + 220 * math.sin(a)
        d.line(s(256, 256, ex, ey), fill=w, width=26 * K)
        for t, ln in ((0.45, 70), (0.72, 50)):
            bx, by = 256 + 220 * t * math.cos(a), 256 + 220 * t * math.sin(a)
            for sg in (-1, 1):
                b = a + sg * math.radians(45)
                d.line(s(bx, by, bx + ln * math.cos(b), by + ln * math.sin(b)), fill=w,
                       width=20 * K)
    d.ellipse(s(216, 216, 296, 296), fill=w)
    done(im, "snowflake")


def hibiscus():
    im, d = canvas()
    pet, dark = (255, 82, 120, 255), (190, 20, 70, 255)
    for k in range(5):
        a = math.radians(-90 + k * 72)
        cx, cy = 256 + 120 * math.cos(a), 256 + 120 * math.sin(a)
        d.ellipse(s(cx - 120, cy - 120, cx + 120, cy + 120), fill=pet, outline=INK, width=6 * K)
    d.ellipse(s(196, 196, 316, 316), fill=dark)
    d.line(s(256, 256, 360, 130), fill=(255, 220, 80, 255), width=14 * K)
    for x, y in ((360, 130), (378, 150), (344, 118)):
        d.ellipse(s(x - 14, y - 14, x + 14, y + 14), fill=(255, 220, 80, 255))
    done(im, "hibiscus")


def wave():
    im, d = canvas()
    deep, mid, foam = (14, 90, 150, 255), (40, 160, 200, 255), (255, 255, 255, 255)
    # a curling breaker: spiral body + foam lip
    pts = [(20, 470)]
    for i in range(0, 271, 6):
        a = math.radians(180 + i)
        r = 210 - i * 0.55
        pts.append((300 + r * math.cos(a), 290 + r * math.sin(a)))
    pts += [(500, 300), (500, 470)]
    poly_round(d, pts, deep, INK, 8)
    pts2 = [(60, 470)]
    for i in range(0, 241, 6):
        a = math.radians(180 + i)
        r = 150 - i * 0.45
        pts2.append((300 + r * math.cos(a), 300 + r * math.sin(a)))
    pts2 += [(470, 330), (470, 470)]
    poly_round(d, pts2, mid)
    for k in range(7):                                                     # foam claws
        a = math.radians(200 + k * 22)
        x, y = 300 + 214 * math.cos(a), 290 + 214 * math.sin(a)
        d.ellipse(s(x - 20, y - 20, x + 20, y + 20), fill=foam)
    d.line(s(20, 470, 500, 470), fill=foam, width=14 * K)
    done(im, "wave")


def mesa():
    im, d = canvas()
    d.ellipse(s(300, 60, 460, 220), fill=(255, 196, 60, 255))
    poly_round(d, [(0, 470), (40, 300), (90, 270), (210, 270), (250, 300), (280, 470)],
               (196, 84, 40, 255), INK, 8)
    poly_round(d, [(230, 470), (290, 340), (330, 320), (470, 320), (500, 350), (512, 470)],
               (150, 56, 30, 255), INK, 8)
    for y in (330, 380, 420):                                              # strata
        d.line(s(30, y, 260, y), fill=(230, 130, 70, 255), width=8 * K)
    done(im, "mesa")


def pylon():
    """Air-race pylon: tall checkered cone on a base. Original."""
    im, d = canvas()
    pts = [(256, 20), (360, 440), (152, 440)]
    poly_round(d, pts, (255, 255, 255, 255), INK, 10)
    for row in range(8):                                                   # checker rows
        y0, y1 = 40 + row * 50, 90 + row * 50
        hw0, hw1 = (y0 - 20) / 420 * 104, (y1 - 20) / 420 * 104
        for c in range(2):
            if (row + c) % 2:
                continue
            x0a, x1a = 256 - hw0 + c * hw0, 256 - hw0 + (c + 1) * hw0
            x0b, x1b = 256 - hw1 + c * hw1, 256 - hw1 + (c + 1) * hw1
            d.polygon([(x0a * K, y0 * K), (x1a * K, y0 * K), (x1b * K, y1 * K),
                       (x0b * K, y1 * K)], fill=(230, 40, 40, 255))
    d.line([(x * K, y * K) for x, y in pts + pts[:1]], fill=INK, width=10 * K, joint="curve")
    d.rectangle(s(110, 440, 402, 490), fill=(40, 40, 46, 255), outline=INK, width=8 * K)
    done(im, "pylon")


def propeller():
    im, d = canvas()
    blade = (230, 232, 236, 255)
    for k in range(3):
        a = math.radians(-90 + k * 120)
        tip = (256 + 230 * math.cos(a), 256 + 230 * math.sin(a))
        l = (256 + 60 * math.cos(a - 0.5), 256 + 60 * math.sin(a - 0.5))
        r = (256 + 60 * math.cos(a + 0.35), 256 + 60 * math.sin(a + 0.35))
        m1 = (256 + 170 * math.cos(a - 0.16), 256 + 170 * math.sin(a - 0.16))
        m2 = (256 + 170 * math.cos(a + 0.12), 256 + 170 * math.sin(a + 0.12))
        poly_round(d, [l, m1, tip, m2, r], blade, INK, 8)
        tx, ty = 256 + 205 * math.cos(a), 256 + 205 * math.sin(a)          # painted tips
        d.ellipse(s(tx - 18, ty - 18, tx + 18, ty + 18), fill=(255, 200, 40, 255))
    d.ellipse(s(200, 200, 312, 312), fill=(60, 62, 70, 255), outline=INK, width=8 * K)
    d.ellipse(s(240, 240, 272, 272), fill=(200, 204, 210, 255))
    done(im, "propeller")


def laurel():
    """Two laurel branches curving up from the bottom (white, tint it in the spec)."""
    im, d = canvas()
    g = (255, 255, 255, 255)

    def leaf_poly(cx, cy, ang, ln=58, wd=22):
        ca, sa = math.cos(ang), math.sin(ang)
        pts = []
        for k in range(16):
            t = k / 15 * math.pi * 2
            lx, ly = math.cos(t) * ln / 2, math.sin(t) * wd / 2 * (1 - 0.35 * math.cos(t))
            pts.append((cx + lx * ca - ly * sa, cy + lx * sa + ly * ca))
        return pts

    for sg in (-1, 1):
        stem = []
        for i in range(0, 121, 4):
            a = math.radians(100 + i)                    # bottom-left round to upper-left
            x = 256 + 200 * math.cos(a)
            stem.append((256 + (x - 256) * sg, 255 + 200 * math.sin(a)))
        d.line([(x * K, y * K) for x, y in stem], fill=g, width=12 * K, joint="curve")
        for j in range(1, len(stem) - 1, 3):
            (x0, y0), (x1, y1) = stem[j - 1], stem[j + 1]
            tang = math.atan2(y1 - y0, x1 - x0)
            for side in (-1, 1):
                ang = tang + side * 0.75
                cx, cy = stem[j][0] + 30 * math.cos(ang), stem[j][1] + 30 * math.sin(ang)
                d.polygon([(px * K, py * K) for px, py in leaf_poly(cx, cy, ang)], fill=g)
        tx, ty = stem[-1]
        d.polygon([(px * K, py * K) for px, py in leaf_poly(tx, ty - 26, -math.pi / 2)], fill=g)
    done(im, "laurel")


def temple():
    """Stepped-terrace temple silhouette (generic, no specific monument)."""
    im, d = canvas()
    stone, ink = (214, 190, 140, 255), (110, 86, 50, 255)
    for i, (hw, y) in enumerate([(240, 440), (200, 380), (160, 320), (120, 260), (80, 200)]):
        d.rectangle(s(256 - hw, y, 256 + hw, y + 60), fill=stone, outline=ink, width=6 * K)
    poly_round(d, [(256, 40), (316, 200), (196, 200)], stone, ink, 6)
    for x in (140, 372):
        poly_round(d, [(x, 220), (x + 34, 320), (x - 34, 320)], stone, ink, 6)
    d.rectangle(s(236, 440, 276, 500), fill=ink)
    done(im, "temple")


def blossom():
    im, d = canvas()
    pet, core = (255, 190, 214, 255), (220, 60, 110, 255)
    for k in range(5):
        a = math.radians(-90 + k * 72)
        cx, cy = 256 + 120 * math.cos(a), 256 + 120 * math.sin(a)
        d.ellipse(s(cx - 100, cy - 100, cx + 100, cy + 100), fill=pet, outline=(200, 90, 130, 255),
                  width=5 * K)
        nx, ny = 256 + 215 * math.cos(a), 256 + 215 * math.sin(a)          # petal notch
        d.ellipse(s(nx - 22, ny - 22, nx + 22, ny + 22), fill=(0, 0, 0, 0))
    d.ellipse(s(216, 216, 296, 296), fill=core)
    for k in range(10):
        a = math.radians(k * 36)
        x, y = 256 + 62 * math.cos(a), 256 + 62 * math.sin(a)
        d.ellipse(s(x - 9, y - 9, x + 9, y + 9), fill=(255, 220, 90, 255))
    done(im, "blossom")


def karst():
    """Tall rounded limestone peaks over a river."""
    im, d = canvas()
    for x, w, h, col in [(90, 120, 330, (60, 120, 100, 255)), (220, 140, 400, (40, 96, 82, 255)),
                         (360, 120, 300, (70, 134, 112, 255)), (450, 90, 220, (90, 150, 126, 255))]:
        d.rounded_rectangle(s(x - w / 2, 440 - h, x + w / 2, 440), radius=w / 2 * K,
                            fill=col, outline=INK, width=6 * K)
    d.rectangle(s(0, 440, 512, 500), fill=(120, 200, 210, 255))
    for i in range(3):
        y = 455 + i * 16
        d.line(s(60 + i * 40, y, 300 + i * 40, y), fill=(255, 255, 255, 255), width=5 * K)
    done(im, "karst")


def volcano():
    im, d = canvas()
    poly_round(d, [(0, 480), (200, 150), (312, 150), (512, 480)], (70, 80, 96, 255), INK, 8)
    poly_round(d, [(200, 150), (312, 150), (370, 250), (330, 230), (290, 260), (250, 225),
                   (210, 255), (150, 240)], (250, 252, 255, 255))
    for x, y, r in ((256, 110, 40), (230, 70, 32), (275, 40, 26)):         # steam plume
        d.ellipse(s(x - r, y - r, x + r, y + r), fill=(235, 238, 244, 255))
    done(im, "volcano")


def target():
    """Flight-test photo-calibration mark: quartered circle."""
    im, d = canvas()
    d.ellipse(s(20, 20, 492, 492), fill=(255, 255, 255, 255), outline=INK, width=14 * K)
    d.pieslice(s(20, 20, 492, 492), 0, 90, fill=INK)
    d.pieslice(s(20, 20, 492, 492), 180, 270, fill=INK)
    done(im, "target")


def reticle():
    """Gun Game mark: a ring reticle with ticks (no weapon)."""
    im, d = canvas()
    w = (255, 255, 255, 255)
    d.ellipse(s(56, 56, 456, 456), outline=w, width=34 * K)
    d.ellipse(s(226, 226, 286, 286), fill=w)
    for x0, y0, x1, y1 in ((256, 0, 256, 150), (256, 362, 256, 512), (0, 256, 150, 256),
                           (362, 256, 512, 256)):
        d.line(s(x0, y0, x1, y1), fill=w, width=28 * K)
    done(im, "reticle")


def downarrow():
    im, d = canvas()
    poly_round(d, [(176, 20), (336, 20), (336, 260), (460, 260), (256, 490), (52, 260),
                   (176, 260)], (255, 255, 255, 255), INK, 14)
    done(im, "downarrow")


def leaf():
    im, d = canvas()
    col = (214, 92, 30, 255)
    pts = _star_pts(256, 240, 230, 120, n=5, rot=-90)
    poly_round(d, pts, col, INK, 8)
    d.line(s(256, 240, 256, 500), fill=(110, 50, 20, 255), width=14 * K)
    for k in (-1, 1):
        d.line(s(256, 300, 256 + k * 140, 180), fill=(150, 60, 20, 255), width=8 * K)
    done(im, "leaf")


def chevron():
    im, d = canvas()
    poly_round(d, [(40, 60), (200, 60), (470, 256), (200, 452), (40, 452), (310, 256)],
               (255, 255, 255, 255))
    done(im, "chevron")


ALL = [goldfish, bubbles, bratwurst, paw, medal, trophy, evergreen, raindrop, badger, sun, palm,
       mountains, fishmark]
PACK2 = [snowflake, hibiscus, wave, mesa, pylon, propeller, laurel, temple, blossom, karst,
         volcano, target, reticle, downarrow, leaf, chevron]

if __name__ == "__main__":
    # python tools/make_decals.py              every decal
    # python tools/make_decals.py snowflake    just these (redrawing old ones can shift bytes)
    want = set(sys.argv[1:])
    for f in ALL + PACK2:
        if want and f.__name__ not in want:
            continue
        f()
        print(f"liveries/decals/{f.__name__}.png")
