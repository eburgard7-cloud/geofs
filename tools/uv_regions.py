#!/usr/bin/env python3
"""
Build UV region maps for the Finsonly Air livery factory from the real GeoFS models.

For each aircraft this reads the model GeoFS itself renders (fetched from geo-fs.com into a
local, gitignored cache; nothing from GeoFS is committed), rasterizes every triangle that uses
the livery texture into UV space, labels it from its 3D position, facing and part name, and
writes:

  liveries/uv/<ac>_regions.png  indexed PNG, pixel value = region id (0 = unused texture space)
  liveries/uv/<ac>_geom.png     RGBA, per texel airframe position: R = lateral (0 left .. 255
                                right), G = height, B = nose (0) .. tail (255), A = 255 where a
                                painted surface lands. Lets the factory draw stripes and
                                gradients in airframe space instead of texture space.
  liveries/uv/<ac>.json         region names, where each sits, confidence, notes

Usage:
  python tools/uv_regions.py [--only f16|b757] [--cache liveries/.cache] [--offline]

Pillow + numpy only. Needs network once (geo-fs.com) unless the cache is already filled.
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import struct
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
UV_DIR = ROOT / "liveries" / "uv"

GEOFS = "https://www.geo-fs.com"

# ----------------------------------------------------------------------------------- glTF 1.0
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32,
      5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _node_matrix(nd):
    if "matrix" in nd:
        return np.array(nd["matrix"], float).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in nd:
        m = np.diag(list(nd["scale"]) + [1]) @ m
    if "rotation" in nd:
        x, y, z, w = nd["rotation"]
        r = np.eye(4)
        r[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        m = r @ m
    if "translation" in nd:
        t = np.eye(4)
        t[:3, 3] = nd["translation"]
        m = t @ m
    return m


def load_gltf1(path: Path):
    """glTF 1.0 (.gltf + .bin, or KHR_binary_glTF .glb) -> (gltf json, [primitive dicts]).

    Each primitive: node name, material id, world-space positions, triangle indices, UVs."""
    raw = path.read_bytes()
    if raw[:4] == b"glTF":
        _ver, _tot, clen, _fmt = struct.unpack("<IIII", raw[4:20])
        g = json.loads(raw[20:20 + clen])
        body = raw[20 + clen:]
        bufs = {k: body for k in g["buffers"]}
    else:
        g = json.loads(raw)
        bufs = {k: (path.parent / v["uri"].split("?")[0]).read_bytes()
                for k, v in g["buffers"].items()}

    def acc(a):
        A = g["accessors"][a]
        bv = g["bufferViews"][A["bufferView"]]
        b = bufs[bv["buffer"]]
        off = bv.get("byteOffset", 0) + A.get("byteOffset", 0)
        dt = np.dtype(CT[A["componentType"]])
        n = NC[A["type"]]
        st = A.get("byteStride", 0) or dt.itemsize * n
        out = np.empty((A["count"], n), dt)
        for i in range(n):
            out[:, i] = np.ndarray((A["count"],), dt, b, off + i * dt.itemsize, (st,))
        return out

    prims = []

    def walk(n, parent, inherited):
        nd = g["nodes"][n]
        W = parent @ _node_matrix(nd)
        name = nd.get("name") or inherited
        for me in nd.get("meshes", []):
            for p in g["meshes"][me]["primitives"]:
                if p.get("mode", 4) != 4 or "indices" not in p:
                    continue
                attrs = p["attributes"]
                uvk = sorted(k for k in attrs if k.startswith("TEXCOORD"))
                if not uvk:
                    continue
                pos = acc(attrs["POSITION"]).astype(float)
                pos = (np.c_[pos, np.ones(len(pos))] @ W.T)[:, :3]
                prims.append(dict(node=name, material=p.get("material"), pos=pos,
                                  uv=acc(attrs[uvk[0]]).astype(float),
                                  idx=acc(p["indices"])[:, 0].astype(np.int64).reshape(-1, 3)))
        for c in nd.get("children", []):
            walk(c, W, nd.get("name") or inherited)

    for n in g["scenes"][g["scene"]]["nodes"]:
        walk(n, np.eye(4), "")
    return g, prims


# ----------------------------------------------------------------------------------- raster
def raster_tris(uv, pos, labels, size, n_labels):
    """uv (n,3,2) in texture units, pos (n,3,3) normalized 0..1, labels (n,) ints 1..n_labels.

    Returns (bits (H,W) uint64 of every label touching a texel, geom (H,W,3) float, cov bool)."""
    W = H = size
    bits = np.zeros((H, W), np.uint64)
    geom = np.zeros((H, W, 3), np.float32)
    cov = np.zeros((H, W), bool)
    for t in range(len(uv)):
        p = uv[t] * [W, H]
        x0, x1 = int(np.floor(p[:, 0].min())), int(np.ceil(p[:, 0].max()))
        y0, y1 = int(np.floor(p[:, 1].min())), int(np.ceil(p[:, 1].max()))
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W - 1), min(y1, H - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = p
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-9:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
        l3 = 1 - l1 - l2
        # a little slack so sliver triangles still claim the texels they cross
        e = -0.75 / max(abs(d) ** 0.5, 1.0)
        m = (l1 >= e) & (l2 >= e) & (l3 >= e)
        if not m.any():
            continue
        sl = (slice(y0, y1 + 1), slice(x0, x1 + 1))
        bits[sl][m] |= np.uint64(1) << np.uint64(labels[t])
        g = (l1[..., None] * pos[t][0] + l2[..., None] * pos[t][1] + l3[..., None] * pos[t][2])
        geom[sl][m] = np.clip(g[m], 0, 1)
        cov[sl][m] = True
    return bits, geom, cov


def visible_from_outside(P, res=640, n_dirs=26):
    """P (n,3,3) world triangles. Renders triangle ids with a z-buffer from `n_dirs` directions
    around the airframe (orthographic) and returns a bool per triangle: seen in any view.
    Interior faces (cockpit tub, ducts, bays) never win a z-test."""
    dirs = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if (dx, dy, dz) != (0, 0, 0):
                    dirs.append(np.array([dx, dy, dz], float) / np.linalg.norm([dx, dy, dz]))
    dirs = dirs[:n_dirs]
    seen = np.zeros(len(P), bool)
    ctr = P.reshape(-1, 3).mean(0)
    span = np.abs(P.reshape(-1, 3) - ctr).max() * 1.05
    for d in dirs:
        a = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.9 else [1, 0, 0])
        a /= np.linalg.norm(a)
        b = np.cross(d, a)
        Q = P - ctr
        u = ((Q @ a) / span * 0.5 + 0.5) * res
        v = ((Q @ b) / span * 0.5 + 0.5) * res
        z = -(Q @ d)                                   # smaller = closer to the viewer
        zb = np.full((res, res), np.inf)
        ib = np.full((res, res), -1, np.int64)
        for t in range(len(P)):
            x0, x1 = max(int(u[t].min()), 0), min(int(np.ceil(u[t].max())), res - 1)
            y0, y1 = max(int(v[t].min()), 0), min(int(np.ceil(v[t].max())), res - 1)
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            (ax, bx, cx), (ay, by, cy) = u[t], v[t]
            dd = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(dd) < 1e-9:
                continue
            l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / dd
            l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / dd
            l3 = 1 - l1 - l2
            m = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
            if not m.any():
                continue
            zz = l1 * z[t, 0] + l2 * z[t, 1] + l3 * z[t, 2]
            sl = (slice(y0, y1 + 1), slice(x0, x1 + 1))
            w = m & (zz < zb[sl])
            zb[sl][w] = zz[w]
            ib[sl][w] = t
        seen[np.unique(ib[ib >= 0])] = True
    return seen


def box_blur(a, r):
    """Mean over a (2r+1)^2 window, edges clamped. numpy only."""
    p = np.pad(a.astype(np.float32), r + 1, mode="edge")
    c = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s[: a.shape[0], : a.shape[1]] / (k * k)


def resolve(bits, n_labels, priority, r=6):
    """One region per texel. Where several labels land on one texel (mirrored parts, seams),
    the label that dominates the neighbourhood wins; ties go to `priority` (lower wins)."""
    H, W = bits.shape
    best = np.zeros((H, W), np.float32)
    out = np.zeros((H, W), np.uint8)
    order = sorted(range(1, n_labels + 1), key=lambda i: priority.get(i, 99), reverse=True)
    for i in order:
        m = ((bits >> np.uint64(i)) & np.uint64(1)).astype(bool)
        if not m.any():
            continue
        s = box_blur(m, r) + (100 - priority.get(i, 99)) * 1e-4
        take = m & (s >= best)
        out[take] = i
        best[take] = s[take]
    return out


# ----------------------------------------------------------------------------------- aircraft
def _normals(P):
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)


F16_REGIONS = [
    # name, where, confidence, notes
    ("fuselage_top", "upper fuselage and strakes, nose to tail, seen from above", "high", ""),
    ("fuselage_bottom", "belly aft of the intake, seen from below", "high", ""),
    ("fuselage_side_l", "left fuselage side, texels used by the left side only", "medium",
     "Side vs top/bottom is a facing cut (|normal.y| < 0.45); most of the F-16's sides unwrap "
     "into fuselage_top / fuselage_bottom. Use the geom map's height for side stripes."),
    ("fuselage_side_r", "right fuselage side, texels used by the right side only", "medium",
     "Same facing cut as fuselage_side_l."),
    ("fuselage_side_both", "fuselage side texels shared by BOTH sides (mirrored)", "medium",
     "Anything painted here shows on both sides; text reads backwards on one of them. Same "
     "facing cut as fuselage_side_l."),
    ("radome", "nose cone forward of the cockpit", "high",
     "Aft edge is a geometric cut 1.9 m from the tip, not a panel line."),
    ("canopy_frame", "canopy frame and sill (the glass is a separate untextured material)", "high",
     ""),
    ("intake", "chin intake: lip, sides and underside back to the main gear", "medium",
     "Geometric cut: under the fuselage between 0.8 m and 4.4 m ahead of the wing box. The "
     "intake/belly boundary is approximate."),
    ("nozzle", "engine nozzle petals and the aft tail pipe", "high", ""),
    ("ventral_fins", "the two small ventral fins under the tail", "medium",
     "Geometric cut; both fins share texels."),
    ("fin", "vertical fin, BOTH sides share one island", "high",
     "Mirrored: text painted here reads correctly on one side and backwards on the other. "
     "This is why the stock tail code reads backwards in the texture."),
    ("rudder", "rudder, both sides share", "high", ""),
    ("wing_top_l", "left wing upper surface", "high", ""),
    ("wing_top_r", "right wing upper surface", "high", ""),
    ("wing_bottom", "wing lower surfaces, left AND right share one island", "high",
     "Mirrored: left and right undersides are the same texels."),
    ("wing_leading_edges", "leading-edge flaps and fixed leading edge, both wings share", "high",
     ""),
    ("flaperons", "flaperons (trailing-edge control surfaces)", "high",
     "Partly shared between left and right."),
    ("hstab_top_r", "right horizontal stabilizer, upper surface", "high", ""),
    ("hstab_shared", "left h-stab upper surface and both h-stab undersides share one island",
     "high", ""),
    ("speedbrakes", "speed brakes either side of the nozzle", "high", ""),
    ("gear_doors", "landing gear doors (visible when the gear is down)", "high", ""),
    ("wingtip_rails", "wingtip missile rails", "high", ""),
    ("pilot", "pilot figure and helmet (don't paint)", "high", ""),
    ("mechanical", "gear legs, wheels, bays, hook, actuators (don't paint)", "high", ""),
    ("interior", "cockpit tub and panels, intake duct, bays: body faces not visible from "
     "outside (don't paint)", "high",
     "From a 26-direction z-buffer visibility pass with the canopy glass treated as opaque."),
]


def classify_f16(node, c, n):
    x, y, z = c
    nx, ny, nz = n
    side = "l" if x < 0 else "r"
    if node == "body":
        if z < -7.0:
            return "radome"
        if y > 1.35 and z > 3.0 and abs(x) < 0.5:
            return "fin"
        if abs(x) > 5.0:
            return "wingtip_rails"
        if abs(x) > 1.55 and -2.2 < z < 3.3 and abs(y) < 0.7:
            if nz < -0.5 and abs(ny) < 0.7:
                return "wing_leading_edges"
            return "wing_top_" + side if ny >= 0 else "wing_bottom"
        if y < -0.45 and 1.6 < z < 3.9 and abs(nx) > 0.6 and abs(x) > 0.15:
            return "ventral_fins"
        if z > 5.4 and (x * x + (y - 0.3) ** 2) ** 0.5 < 0.7:
            return "nozzle"
        if y < -0.15 and -4.4 < z < -0.8 and abs(x) < 0.8:
            return "intake"
        if ny > 0.45:
            return "fuselage_top"
        if ny < -0.45:
            return "fuselage_bottom"
        return "fuselage_side_" + side
    if node == "canopy":
        return "canopy_frame"
    if node.startswith("elevator"):
        return "hstab_top_r" if (ny >= 0 and x > 0) else "hstab_shared"
    if node == "rudder":
        return "rudder"
    if node.startswith("aileron"):
        return "flaperons"
    if node.startswith("slat"):
        return "wing_leading_edges"
    if node.startswith("sb") and node != "sbActuators" and not node.startswith("sbActua"):
        return "speedbrakes"
    if node.startswith("gearDoor"):
        return "gear_doors"
    if node.startswith("feather"):
        return "nozzle"
    if node in ("head", "visor"):
        return "pilot"
    return "mechanical"


B757_REGIONS = [
    ("fuselage_l", "left (port) fuselage side, drawn as a side profile, nose at left",
     "high", "Upper band of the texture. Text reads normally."),
    ("fuselage_r", "right (starboard) fuselage side, side profile, nose at left", "high",
     "Lower band. The island is mirrored: text must be flipped horizontally to read right "
     "in-sim (Eric's shipped liveries already do this)."),
    ("nose_cone", "radome / nose cone, both sides", "high", "Geometric cut 1.9 m from the tip."),
    ("tail_cone", "tail cone aft of the fin, both sides", "high",
     "Geometric cut 3.5 m from the tail."),
    ("wing_fairing", "wing-to-body fairing / belly under the wing root", "high", ""),
    ("fin_l", "vertical fin, left side", "high", ""),
    ("fin_r", "vertical fin, right side (mirrored like fuselage_r)", "high", ""),
    ("rudder", "rudder, both sides", "high", ""),
    ("engines", "engine nacelles and thrust reversers, both engines share", "high",
     "This is the right half of the old 'N1/N2' box (the N2 half)."),
    ("winglets", "winglets, both share", "high",
     "The left half of the old 'N1/N2' box (N1) is the winglets, not an engine."),
    ("pylons", "engine pylons, both share", "high", ""),
    ("wing_strip", "the few wing faces that use this texture (a thin strip)", "high",
     "Most of the wing is untextured grey in this model; only this strip takes paint."),
    ("hstab_strip", "the few h-stab faces that use this texture (a thin strip)", "high", ""),
    ("doors", "nose gear, main gear and wing gear doors (tiny)", "high", ""),
]


def classify_b757(node, c, n, part):
    x, y, z = c
    nx = n[0]
    side = "l" if x < 0 else "r"
    if part == "rudder":
        return "rudder"
    if part == "reversers":
        return "engines"
    if part != "body":
        return "doors"
    if node == "Fuselage":
        if z < -20.5:
            return "nose_cone"
        if z > 21.5:
            return "tail_cone"
        return "fuselage_" + side
    if node == "group_0":
        return "fin_" + ("l" if nx < 0 else "r")
    if node.startswith("Undercarriage"):
        return "wing_fairing"
    if node.startswith("WInglet"):
        return "winglets"
    if node in ("group_2", "group_6"):
        return "engines"
    if node in ("Component_18", "Component_20"):
        return "pylons"
    if node == "Wing":
        return "wing_strip"
    if node == "Group_13":
        return "hstab_strip"
    return "doors"


AIRCRAFT = {
    "f16": dict(
        size=2048,
        files=["f16.gltf", "f16.bin"],
        url=GEOFS + "/models/aircraft/premium/f16/",
        parts=["f16.gltf"],
        regions=F16_REGIONS,
        source="GeoFS F-16 model models/aircraft/premium/f16/f16.gltf, material '_1_-_Default' "
               "(texture.jpg = LiverySelector F-16 slot, texture index 3)",
    ),
    "b757": dict(
        size=1024,
        files=[p + ".glb" for p in (
            "body", "rudder", "frontsmallleftdoor", "frontsmallrightdoor", "frontbigleftdoor",
            "frontbigrightdoor", "leftgeardoor", "rightgeardoor", "leftwingdoor",
            "rightwingdoor", "reversers")] + ["aircraft.json"],
        url=GEOFS + "/backend/aircraft/repository/GXD04N_126645_238/",
        parts=None,  # = the .glb files
        regions=B757_REGIONS,
        source="GeoFS community 757-200 GXD04N_126645_238: the 11 parts LiverySelector "
               "re-textures (body, rudder, doors, gear doors, wing doors, reversers), material "
               "'texture' (texture.png)",
    ),
}


def fetch(ac, cache: Path, offline: bool):
    spec = AIRCRAFT[ac]
    d = cache / ac
    d.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context()
    for f in spec["files"]:
        dst = d / f
        if dst.exists() and dst.stat().st_size > 0:
            continue
        if offline:
            sys.exit(f"missing {dst} (run without --offline to fetch from geo-fs.com)")
        url = spec["url"] + f + ("?kc=1" if f.endswith(".bin") else "")
        print(f"fetch {url}")
        with urllib.request.urlopen(url, context=ctx, timeout=60) as r:
            dst.write_bytes(r.read())
    return d


def triangles(ac, d: Path):
    """-> list of (label name, uv (3,2), world pos (3,3))."""
    spec = AIRCRAFT[ac]
    out = []
    occluders = []
    offsets = {}
    if (d / "aircraft.json").exists():
        # GeoFS places each part at its aircraft.json position: x right, y forward, z up.
        # Model frame here: x right, y up, z aft.
        for part in json.loads((d / "aircraft.json").read_text())[0]["parts"]:
            if part.get("model") and part.get("position"):
                px, py, pz = part["position"]
                offsets[part["model"]] = np.array([px, pz, -py], float)
    for f in spec["parts"] or [f for f in spec["files"] if f.endswith((".glb", ".gltf"))]:
        g, prims = load_gltf1(d / f)
        for p in prims:
            p["pos"] = p["pos"] + offsets.get(f, 0.0)
        tex_mats = {k for k, m in g["materials"].items()
                    if isinstance(m.get("values", {}).get("diffuse"), str)
                    and "texture" in m["values"]["diffuse"]
                    and "reflection" not in m["values"]["diffuse"]}
        part = f.split(".")[0]
        for p in prims:
            P = p["pos"][p["idx"]]
            occluders.append(P)
            if p["material"] not in tex_mats:
                continue
            uv = p["uv"][p["idx"]]
            uv = uv - np.floor(uv.mean(1))[:, None, :]   # texture repeats; bring into [0,1)
            N = _normals(P)
            C = P.mean(1)
            for i in range(len(uv)):
                if ac == "f16":
                    lab = classify_f16(p["node"], C[i], N[i])
                else:
                    lab = classify_b757(p["node"], C[i], N[i], part)
                out.append([lab, uv[i], P[i], p["node"]])
    if ac == "f16":
        # Body faces nobody can see from outside (cockpit tub and panels behind the canopy,
        # intake duct, bays) are interior, not skin. Glass counts as opaque here.
        allP = np.concatenate(occluders)
        seen = visible_from_outside(allP)
        # map textured triangles back to their index in allP by identity of coordinates
        key = {tri.tobytes(): i for i, tri in enumerate(allP)}
        for t in out:
            if t[3] == "body" and not seen[key[t[2].tobytes()]]:
                t[0] = "interior"
    return [tuple(t[:3]) for t in out]


def _gauss(a, r):
    """~Gaussian blur: three box passes."""
    for _ in range(3):
        a = box_blur(a, r)
    return a


def _dilate(m, r):
    return box_blur(m.astype(np.float32), r) > 1e-6


def _erode(m, r):
    return box_blur(m.astype(np.float32), r) > 1 - 1e-6


def build_f16_shade(reg, names):
    """Panel-line shading for the F-16 from Eric's GET DUCKED livery (flat yellow multiplied over
    the grey stock skin, so its green channel is the stock shading). Wide high-contrast blobs
    (the duck's eyes, the stock star insignia, tail code and serials) are removed and left
    neutral; only thin panel lines and grain survive. 128 = no change."""
    duck = np.asarray(Image.open(ROOT / "f16_rubberduck_livery_baby.webp").convert("RGB"),
                      np.float32)
    g = duck[..., 1]
    v = 128 + (g / (_gauss(g, 4) + 1) - 1) * 400
    skin_ids = [i + 1 for i, n in enumerate(names) if n not in ("pilot", "mechanical", "interior")]
    skin = np.isin(reg, skin_ids)
    v = np.where(skin, v, 128)
    blob = _dilate(_erode(np.abs(v - 128) > 14, 3), 3)       # opening: survives only if wide
    blob = _dilate(blob, 10)
    v = np.where(blob, 128, np.clip(v, 88, 168))
    blob2 = _dilate(_erode(np.abs(v - 128) > 9, 2), 2)
    v = np.where(_dilate(blob2, 8), 128, v)
    Image.fromarray(v.astype(np.uint8)).save(UV_DIR / "f16_shade.png", optimize=True)


def build_b757_cabin():
    """Windows and door outlines for the 757, lifted from Eric's b757-200_uv_test.png, where they
    sit in exactly the stock positions as dark grey (51) on flat band colours. Writes an RGBA
    overlay: grey with alpha unmixed from the band colour."""
    a = np.asarray(Image.open(ROOT / "b757-200_uv_test.png").convert("RGB"), np.float32)
    out = np.zeros((1024, 1024, 4), np.uint8)
    for y0, y1, ch in ((164, 217, 1), (434, 487, 0)):   # band A bg (255,200,200), B (200,200,255)
        p = a[y0:y1, :860]
        grey = (np.abs(p[..., 0] - p[..., 1]) < 12) & (np.abs(p[..., 1] - p[..., 2]) < 12)
        alpha = np.clip((200 - p[..., ch]) / (200 - 51), 0, 1)
        alpha[~grey & (alpha < 0.5)] = 0
        o = out[y0:y1, :860]
        o[..., :3] = 51
        o[..., 3] = np.round(alpha * 255)
    Image.fromarray(out).save(UV_DIR / "b757_cabin.png", optimize=True)


# shipped Finsonly liveries used to cross-check each map (where Eric's paint really landed)
SHIPPED = {
    "f16": ["f16_rubberduck_livery_baby.webp", "khabo_f16.webp", "steves_revenge_f16.webp",
            "f16_cow_alien.webp"],
    "b757": ["b757-200_khabo2026.png", "b757-200_khabo2026_afterdark.png",
             "b757-200_khabo2027_kh.png", "b757-200_khabo2027_palms.png",
             "b757-200_goldfish.png", "b757-200_bratbeer.png"],
}


def cross_check(ac, reg, regions):
    """% of each region's texels that the shipped liveries repainted (differ between them).
    Painted skin ~100% and 'mechanical' ~0% means the map agrees with where paint lands."""
    imgs = [np.asarray(Image.open(ROOT / f).convert("RGB"), np.int16) for f in SHIPPED[ac]]
    d = np.zeros(imgs[0].shape[:2], np.int16)
    for b in imgs[1:]:
        d = np.maximum(d, np.abs(imgs[0] - b).max(2))
    painted = d >= 24
    out = {}
    for r in regions:
        m = reg == r["id"]
        out[r["name"]] = round(100.0 * (painted & m).sum() / max(int(m.sum()), 1), 1)
    return dict(liveries=SHIPPED[ac], painted_pct_by_region=out)


def palette(n):
    """Distinct, deterministic colours for the indexed PNG (golden-angle hues)."""
    import colorsys
    pal = [(0, 0, 0)]
    for i in range(n):
        h = (i * 0.618034) % 1.0
        s = 0.55 + 0.4 * ((i * 7) % 3) / 2
        v = 0.95 - 0.3 * ((i * 5) % 2)
        pal.append(tuple(int(255 * c) for c in colorsys.hsv_to_rgb(h, s, v)))
    return pal


def build(ac, cache: Path, offline=False):
    spec = AIRCRAFT[ac]
    d = fetch(ac, cache, offline)
    tris = triangles(ac, d)
    names = [r[0] for r in spec["regions"]]
    ids = {n: i + 1 for i, n in enumerate(names)}
    lab = np.array([ids[t[0]] for t in tris])
    uv = np.array([t[1] for t in tris])
    pos = np.array([t[2] for t in tris])
    lo = pos.reshape(-1, 3).min(0)
    hi = pos.reshape(-1, 3).max(0)
    posn = (pos - lo) / (hi - lo)
    size = spec["size"]
    bits, geom, cov = raster_tris(uv, posn, lab, size, len(names))
    if ac == "f16":
        # texels both fuselage sides use -> fuselage_side_both
        L, R, B = (np.uint64(1) << np.uint64(ids[k]) for k in
                   ("fuselage_side_l", "fuselage_side_r", "fuselage_side_both"))
        both = ((bits & L) != 0) & ((bits & R) != 0)
        bits[both] = (bits[both] & ~(L | R)) | B
    # anything paintable beats 'mechanical'/'pilot'/'doors' on shared seams
    prio = {ids[n]: (90 if n in ("mechanical", "pilot", "doors", "interior") else 10) for n in names}
    reg = resolve(bits, len(names), prio)
    reg[~cov] = 0

    UV_DIR.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(reg)
    pal = palette(len(names))
    im.putpalette([c for rgb in pal for c in rgb] + [0] * (768 - 3 * len(pal)))
    im.save(UV_DIR / f"{ac}_regions.png", optimize=True)
    g8 = np.zeros((size, size, 4), np.uint8)
    g8[..., :3] = np.round(geom * 255)
    g8[..., 3] = cov * 255
    Image.fromarray(g8).save(UV_DIR / f"{ac}_geom.png", optimize=True)

    no_paint = {"pilot", "mechanical", "interior"}
    regions = []
    for i, (name, where, conf, notes) in enumerate(spec["regions"], 1):
        m = reg == i
        ys, xs = np.nonzero(m)
        regions.append(dict(
            id=i, name=name, paint=name not in no_paint, where=where, confidence=conf,
            notes=notes, color="#%02x%02x%02x" % pal[i], texels=int(m.sum()),
            bbox=[int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
            if m.any() else None))
    extras = {}
    if ac == "f16":
        build_f16_shade(reg, names)
        extras = dict(shade_png="liveries/uv/f16_shade.png",
                      underlay="khabo_f16.webp",
                      underlay_note="Non-paint regions (pilot, mechanical, interior) keep the "
                                    "pixels of this shipped livery: cockpit panels, gear, pilot.")
    else:
        build_b757_cabin()
        extras = dict(cabin_png="liveries/uv/b757_cabin.png",
                      cabin_note="Windows and door outlines, from b757-200_uv_test.png.")
    meta = dict(
        aircraft=ac, texture_size=[size, size],
        regions_png=f"liveries/uv/{ac}_regions.png", geom_png=f"liveries/uv/{ac}_geom.png",
        **extras,
        source=spec["source"],
        method="Every textured triangle of the model rasterized into UV space and labelled from "
               "its part name, 3D position and facing (tools/uv_regions.py). UV v runs down the "
               "image (row = v * height), verified against the helmet/pilot island.",
        geom_axes=dict(R="lateral: 0 = left wingtip .. 255 = right wingtip",
                       G="height: 0 = lowest point .. 255 = top of the fin",
                       B="length: 0 = nose tip .. 255 = tail", A="255 = painted surface",
                       bounds_m=dict(lo=[round(v, 3) for v in lo], hi=[round(v, 3) for v in hi])),
        in_sim="UNVERIFIED IN-SIM: derived from the model files, not yet checked with the "
               "region-ID sheet in GeoFS.",
        cross_check=cross_check(ac, reg, regions),
        regions=regions)
    (UV_DIR / f"{ac}.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"{ac}: {len(tris)} triangles, {len(names)} regions -> {UV_DIR}")
    for r in regions:
        print(f"  {r['id']:2d} {r['name']:22s} {r['confidence']:6s} {r['texels']:8d} {r['bbox']}")
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--only", choices=sorted(AIRCRAFT))
    ap.add_argument("--cache", default=str(ROOT / "liveries" / ".cache"))
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()
    for ac in [a.only] if a.only else sorted(AIRCRAFT):
        build(ac, Path(a.cache), a.offline)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    main()
