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
  python tools/uv_regions.py [--only <ac>] [--cache liveries/.cache] [--offline]

Pillow + numpy only. Needs network once (geo-fs.com) unless the cache is already filled.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
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


def load_gltf2(path: Path):
    """glTF 2.0 (.glb or .gltf + .bin) -> (gltf json, [primitive dicts]), same shape as
    load_gltf1. Materials, meshes and nodes are lists; material ids are list indices."""
    raw = path.read_bytes()
    if raw[:4] == b"glTF":
        off, chunks = 12, []
        while off < len(raw):
            ln, typ = struct.unpack("<II", raw[off:off + 8])
            chunks.append((typ, raw[off + 8:off + 8 + ln]))
            off += 8 + ln
        g = json.loads(next(c for t, c in chunks if t == 0x4E4F534A))
        binc = next((c for t, c in chunks if t == 0x004E4942), b"")
        bufs = [binc if "uri" not in b else (path.parent / b["uri"]).read_bytes()
                for b in g["buffers"]]
    else:
        g = json.loads(raw)
        bufs = [(path.parent / b["uri"]).read_bytes() for b in g["buffers"]]

    def acc(a):
        A = g["accessors"][a]
        bv = g["bufferViews"][A["bufferView"]]
        b = bufs[bv["buffer"]]
        off = bv.get("byteOffset", 0) + A.get("byteOffset", 0)
        dt = np.dtype(CT[A["componentType"]])
        n = NC[A["type"]]
        st = bv.get("byteStride", 0) or dt.itemsize * n
        out = np.empty((A["count"], n), dt)
        for i in range(n):
            out[:, i] = np.ndarray((A["count"],), dt, b, off + i * dt.itemsize, (st,))
        return out

    prims = []

    def walk(n, parent, inherited):
        nd = g["nodes"][n]
        W = parent @ _node_matrix(nd)
        name = nd.get("name") or inherited
        if "mesh" in nd:
            for p in g["meshes"][nd["mesh"]]["primitives"]:
                attrs = p["attributes"]
                if p.get("mode", 4) != 4 or "indices" not in p or "TEXCOORD_0" not in attrs:
                    continue
                pos = acc(attrs["POSITION"]).astype(float)
                pos = (np.c_[pos, np.ones(len(pos))] @ W.T)[:, :3]
                prims.append(dict(node=name, material=p.get("material"), pos=pos,
                                  uv=acc(attrs["TEXCOORD_0"]).astype(float),
                                  idx=acc(p["indices"])[:, 0].astype(np.int64).reshape(-1, 3)))
        for c in nd.get("children", []):
            walk(c, W, name)

    for n in g["scenes"][g.get("scene", 0)]["nodes"]:
        walk(n, np.eye(4), "")
    return g, prims


def load_model(path: Path):
    """Either glTF version -> (gltf json, prims)."""
    raw = path.read_bytes()
    if raw[:4] == b"glTF":
        two = struct.unpack("<I", raw[4:8])[0] == 2
    else:
        two = str(json.loads(raw).get("asset", {}).get("version", "1")).startswith("2")
    return (load_gltf2 if two else load_gltf1)(path)


def material_images(g) -> dict:
    """material id -> name/uri of the image its diffuse (glTF 1) or base colour (glTF 2)
    texture samples, for every textured material."""
    out = {}
    if isinstance(g["materials"], list):
        for i, m in enumerate(g["materials"]):
            t = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
            if t is not None:
                im = g["images"][g["textures"][t["index"]]["source"]]
                out[i] = im.get("name") or im.get("uri") or ""
        return out
    for k, m in g["materials"].items():
        d = m.get("values", {}).get("diffuse")
        if isinstance(d, str) and d in g.get("textures", {}):
            out[k] = g["images"][g["textures"][d]["source"]].get("uri", "")
    return out


def texture_slot(g, image) -> int | None:
    """glTF 2: index into the model's texture list of the first texture sampling `image`
    (what changeModelTexture's {index: N} is assumed to count)."""
    if not isinstance(g.get("textures"), list):
        return None
    for i, t in enumerate(g["textures"]):
        im = g["images"][t["source"]]
        if image in (im.get("name"), im.get("uri")):
            return i
    return None


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


# ----------------------------------------------------------------------------------- rule maps
# The ladder airframes are labelled by a rule table instead of a hand-written classifier:
# (label, conditions) tried in order, first match wins. Conditions are ranges [lo, hi] (None =
# open) on the triangle centre x, |x| ("ax"), y, z and its normal nx, ny, nz, |nx| ("anx"), plus
# "node" / "not_node" regexes on the part name. Coordinates are in the shared frame
# (x right, y up, z aft, metres). Labels may use {s} (side from x), {ns} (side from the
# normal's x: which face of a thin centreline part) and {tb} (top/bottom from ny).
MECH = r"(?i)wheel|gear(?!.*door)|susp|strut|leg|spring|actuator|piston|holder|retract|damper|" \
       r"cam_|bit_|torus|rod|pivot|rope|prop(?!.*cone)|fan_|tyre|tire|hook"


def classify_rules(rules, node, c, n):
    x, y, z = c
    nx, ny, nz = n
    v = dict(x=x, ax=abs(x), y=y, z=z, nx=nx, ny=ny, nz=nz, anx=abs(nx))
    for label, cond in rules:
        ok = True
        for k, rng in cond.items():
            if k == "node":
                ok = re.search(rng, node or "") is not None
            elif k == "not_node":
                ok = re.search(rng, node or "") is None
            else:
                lo, hi = rng
                ok = (lo is None or v[k] >= lo) and (hi is None or v[k] <= hi)
            if not ok:
                break
        if ok:
            return label.format(s="l" if x < 0 else "r", ns="l" if nx < 0 else "r",
                                tb="top" if ny >= 0 else "bottom")
    return "mechanical"


def _fuselage(top=0.6):
    """Tail-end rules shared by every airframe body: top / bottom by facing, else a side."""
    return [("fuselage_top", dict(ny=(top, None))),
            ("fuselage_bottom", dict(ny=(None, -top))),
            ("fuselage_{s}", {})]


def R(name, where, conf="high", notes=""):
    return (name, where, conf, notes)


COMMON_TAIL = [
    R("pilot", "pilot figure (don't paint)"),
    R("mechanical", "gear legs, wheels, struts' fittings, prop blades, rods (don't paint)"),
    R("interior", "body faces nobody sees from outside: cockpit, cabin walls, wheel wells "
      "(don't paint)", "high",
      "From the 26-direction z-buffer visibility pass with glass treated as opaque."),
]

GA_REGIONS = [
    R("fuselage_top", "fuselage top (cabin roof aft of the wing, turtle deck)", "medium",
      "Facing cut normal.y > 0.6."),
    R("fuselage_bottom", "fuselage belly", "medium", "Facing cut normal.y < -0.6."),
    R("fuselage_l", "left fuselage side", "high", ""),
    R("fuselage_r", "right fuselage side", "high", ""),
    R("fuselage_both", "fuselage texels BOTH sides share (mirrored)", "medium",
      "Text painted here reads backwards on one side."),
    R("cowling", "engine cowling and nose, forward of the firewall", "medium",
      "Geometric cut along the length, not a panel line."),
    R("spinner", "propeller spinner", "high", ""),
    R("wing_top_l", "left wing upper surface", "high", ""),
    R("wing_top_r", "right wing upper surface", "high", ""),
    R("wing_bottom", "wing lower surfaces (left and right)", "high",
      "May be one shared island; treat it as symmetric."),
    R("wing_both", "upper-wing texels both wings share", "medium", "Mirrored."),
    R("ailerons", "ailerons, both", "high", ""),
    R("flaps", "flaps, both", "high", ""),
    R("struts", "wing struts", "medium", "Geometric cut under the wing, outboard of the cabin."),
    R("fin_l", "vertical fin, left face", "high", ""),
    R("fin_r", "vertical fin, right face", "high", ""),
    R("fin", "fin texels both faces share (mirrored)", "high",
      "Text here reads backwards on one side; use symmetric art."),
    R("rudder", "rudder, both faces", "high", ""),
    R("hstab_top", "horizontal stabilizer upper surface (fixed part)", "high", ""),
    R("hstab_bottom", "horizontal stabilizer lower surface", "high", ""),
    R("elevators", "elevators", "high", ""),
    R("doors", "cabin doors", "high", ""),
    R("floats", "floats (Beaver amphibian)", "high", ""),
    R("gear_fairings", "main gear legs / wheel fairings", "medium",
      "Painted on most real aircraft; GeoFS animates them with the gear."),
] + COMMON_TAIL

GA_NODE_RULES = [
    ("rudder", dict(node=r"(?i)^rudder$")),
    ("elevators", dict(node=r"(?i)elevat|eleva$")),
    ("ailerons", dict(node=r"(?i)aileron(?!.*rod)")),
    ("flaps", dict(node=r"(?i)flap")),
    ("doors", dict(node=r"(?i)door")),
    ("spinner", dict(node=r"(?i)spinner|propcone")),
    ("pilot", dict(node=r"(?i)pilot|head")),
    ("mechanical", dict(node=MECH)),
]


def ga_rules(body, wing_y, cabin_x, cowl_z, tail_z, fin_x, hstab_y, strut_y=None):
    """High-wing single (172, Cub, Beaver, Retro 172). Every number is metres in the shared
    frame, read off the model's part bounding boxes (see the region notes)."""
    sy = strut_y if strut_y is not None else wing_y - 0.12
    r = list(GA_NODE_RULES)
    r += [
        ("fin_{ns}", dict(node=body, z=(tail_z, None), ax=(None, fin_x), y=(hstab_y[1], None))),
        ("hstab_{tb}", dict(node=body, z=(tail_z, None), ax=(fin_x, None),
                            y=(hstab_y[0], hstab_y[1]))),
        ("struts", dict(node=body, ax=(cabin_x, None), y=(None, sy))),
        ("wing_top_{s}", dict(node=body, ax=(cabin_x, None), ny=(0, None))),
        ("wing_bottom", dict(node=body, ax=(cabin_x, None))),
        ("cowling", dict(node=body, z=(None, cowl_z))),
    ]
    return r + [(lab, dict(cond, node=body)) for lab, cond in _fuselage()]


GEAR_FAIRINGS = [("gear_fairings", dict(node=r"^(left|right|front)Gear$"))]
C172_RULES = GEAR_FAIRINGS + ga_rules(r"^Cessna1764$", wing_y=0.15, cabin_x=0.62, cowl_z=-1.3,
                                      tail_z=3.3, fin_x=0.16, hstab_y=(-0.45, -0.1),
                                      strut_y=0.03)
C172RETRO_RULES = GEAR_FAIRINGS + ga_rules(r"^Box002$", wing_y=0.15, cabin_x=0.62, cowl_z=-1.3,
                                           tail_z=3.3, fin_x=0.16, hstab_y=(-0.45, -0.1),
                                           strut_y=0.03)
CUB_RULES = ga_rules(r"^cub$", wing_y=0.5, cabin_x=0.42, cowl_z=-1.0, tail_z=3.4,
                     fin_x=0.12, hstab_y=(0.2, 0.42))
BEAVER_RULES = [("mechanical", dict(node=r"^(left|right)Rudder$")),      # water rudders
                ("floats", dict(node=r"^floats$"))] + \
    ga_rules(r"^body$", wing_y=0.72, cabin_x=0.78, cowl_z=-1.6, tail_z=4.6, fin_x=0.2,
             hstab_y=(0.1, 0.5))

SU35_REGIONS = [
    R("fuselage_top", "upper fuselage, spine and LERX tops", "high", ""),
    R("fuselage_bottom", "belly between the engines", "high", ""),
    R("fuselage_l", "left fuselage side", "medium", "Facing cut |normal.y| < 0.45."),
    R("fuselage_r", "right fuselage side", "medium", "Facing cut |normal.y| < 0.45."),
    R("fuselage_both", "fuselage texels BOTH sides share (mirrored)", "medium", ""),
    R("radome", "nose cone forward of the cockpit", "high", "Geometric cut 2 m from the tip."),
    R("canopy_frame", "canopy frame", "high", ""),
    R("intake", "engine intakes and the nacelle undersides", "medium",
      "Geometric cut: below the wing, outboard of the centreline, forward of the nozzles."),
    R("nozzle", "engine nozzles and petals", "high", ""),
    R("ventral_fins", "ventral fins under the tail booms", "medium", "Geometric cut."),
    R("fin_l", "left vertical fin (both its faces)", "high", "Twin fins: one per side."),
    R("fin_r", "right vertical fin (both its faces)", "high", ""),
    R("fin", "fin texels both fins share (mirrored)", "medium", "Use symmetric art."),
    R("rudder", "rudders, both", "high", ""),
    R("wing_top_l", "left wing upper surface", "high", ""),
    R("wing_top_r", "right wing upper surface", "high", ""),
    R("wing_bottom", "wing lower surfaces", "high", ""),
    R("wing_both", "upper-wing texels both wings share (mirrored)", "medium", ""),
    R("wing_leading_edges", "leading-edge slats, both", "high", ""),
    R("flaperons", "flaperons, both", "high", ""),
    R("hstab_top", "all-moving tailplanes, upper surface", "high", ""),
    R("hstab_bottom", "all-moving tailplanes, lower surface", "high", ""),
    R("gear_doors", "landing gear doors (visible with the gear down)", "high", ""),
] + COMMON_TAIL

SU35_BODY = r"^Fuselage$"
SU35_RULES = [
    ("canopy_frame", dict(node=r"^Canopy$")),
    ("rudder", dict(node=r"^Rudder_")),
    ("hstab_{tb}", dict(node=r"^Elevator_")),
    ("flaperons", dict(node=r"^Flap_")),
    ("wing_leading_edges", dict(node=r"^Slat_")),
    ("gear_doors", dict(node=r"^Gears_Door")),
    ("nozzle", dict(node=r"^(Nozzle_|feather)")),
    ("mechanical", dict(node=MECH)),
    ("mechanical", dict(node=r"^(NG|RG|FrontGear)")),
    ("radome", dict(node=SU35_BODY, z=(None, -10.6))),
    ("fin_{s}", dict(node=SU35_BODY, ax=(1.4, 2.8), y=(0.75, None), z=(1.5, None))),
    ("ventral_fins", dict(node=SU35_BODY, y=(None, -0.75), z=(2.0, None), anx=(0.6, None))),
    ("nozzle", dict(node=SU35_BODY, z=(6.4, None), ax=(0.5, 1.9), y=(-0.7, 0.7))),
    ("wing_top_{s}", dict(node=SU35_BODY, ax=(2.6, None), y=(-0.6, 0.75), ny=(0, None))),
    ("wing_bottom", dict(node=SU35_BODY, ax=(2.6, None), y=(-0.6, 0.75))),
    ("intake", dict(node=SU35_BODY, y=(None, -0.2), ax=(0.45, 2.2), z=(-4.6, 5.0),
                    ny=(None, 0.45))),
] + [(lab, dict(cond, node=SU35_BODY)) for lab, cond in _fuselage(0.45)]

AIRLINER_REGIONS = [
    R("fuselage_l", "left (port) fuselage side, nose to tail", "high", ""),
    R("fuselage_r", "right (starboard) fuselage side", "high", ""),
    R("fuselage_both", "fuselage texels BOTH sides share (mirrored)", "medium",
      "Text here reads backwards on one side."),
    R("nose_cone", "radome / nose cone", "high", "Geometric cut about 1.9 m from the tip."),
    R("tail_cone", "tail cone aft of the fin", "high", "Geometric cut about 3 m from the tail."),
    R("wing_fairing", "wing-to-body fairing under the wing root", "medium", "Geometric cut."),
    R("fin_l", "vertical fin, left face", "high", ""),
    R("fin_r", "vertical fin, right face", "high", ""),
    R("fin", "fin texels both faces share (mirrored)", "high", "Use symmetric art."),
    R("rudder", "rudder, both faces", "high", ""),
    R("engines", "engine nacelles and thrust reversers", "high", ""),
    R("wing_top_l", "left wing upper surface (textured part)", "medium", ""),
    R("wing_top_r", "right wing upper surface (textured part)", "medium", ""),
    R("wing_bottom", "wing lower surfaces (textured part)", "medium", ""),
    R("wing_both", "upper-wing texels both wings share (mirrored)", "medium", ""),
    R("wing_leading_edges", "slats and Krueger flaps", "high", ""),
    R("flaps", "flaps and flap-track fairings", "high", ""),
    R("ailerons", "ailerons", "high", ""),
    R("hstab_top", "horizontal stabilizer upper surface", "high", ""),
    R("hstab_bottom", "horizontal stabilizer lower surface", "high", ""),
    R("elevators", "elevators", "high", ""),
    R("gear_doors", "nose and main gear doors", "high", ""),
] + COMMON_TAIL


def airliner_rules(body, nose_z, tail_z, fin_z, fin_y, eng_x, eng_z, wing_x, hstab_z,
                   fair_y=None, wing=None):
    """Airliner: `body` is the fuselage node regex, `wing` the wing nodes' (when the wing is
    its own part); nacelles are a box under the wing (eng_x |x| range, eng_z length range)."""
    wing = wing or body
    r = [
        ("rudder", dict(node=r"(?i)^rudder")),
        ("elevators", dict(node=r"(?i)elevator")),
        ("ailerons", dict(node=r"(?i)aileron")),
        ("flaps", dict(node=r"(?i)flap")),
        ("wing_leading_edges", dict(node=r"(?i)slat|kreuger|krueger")),
        ("engines", dict(node=r"(?i)revers|nacelle|cowl")),
        ("wing_top_{s}", dict(node=r"(?i)^spoiler_")),
        ("gear_doors", dict(node=r"(?i)door")),
        ("mechanical", dict(node=MECH)),
        ("nose_cone", dict(node=body, z=(None, nose_z))),
        ("fin_{ns}", dict(node=body, z=(fin_z, None), y=(fin_y, None), ax=(None, 0.7))),
        ("hstab_{tb}", dict(node=body, z=(hstab_z, None), ax=(1.4, None))),
        ("tail_cone", dict(node=body, z=(tail_z, None))),
        ("engines", dict(node=f"{body}|{wing}", ax=(eng_x[0], eng_x[1]),
                         z=(eng_z[0], eng_z[1]), y=(None, -0.45))),
        ("wing_top_{s}", dict(node=wing, ax=(wing_x, None), ny=(0, None))),
        ("wing_bottom", dict(node=wing, ax=(wing_x, None))),
    ]
    if fair_y is not None:
        r.append(("wing_fairing", dict(node=body, y=(None, fair_y), z=(-5.0, 4.0))))
    return r + [("fuselage_{s}", dict(node=body))]


B737_RULES = airliner_rules(r"^fuselage$", nose_z=-15.35, tail_z=14.0, fin_z=9.5, fin_y=2.4,
                            eng_x=(3.4, 7.4), eng_z=(-7.5, -1.0), wing_x=2.1, hstab_z=12.0,
                            fair_y=-1.2, wing=r"^wing(Left|Right)\d$")
B737MAX_RULES = airliner_rules(r".", nose_z=-16.0, tail_z=16.5, fin_z=9.5, fin_y=2.3,
                               eng_x=(3.4, 7.6), eng_z=(-8.0, -1.0), wing_x=2.2, hstab_z=12.5)

PARAGLIDER_REGIONS = [
    R("canopy_centre", "centre cells, about 0.9 m either side of the centreline", "high",
      "The texture is a planar front-view picture of half the canopy, mirrored: left and right "
      "halves AND the top and bottom skins all land on the same texels. Everything painted "
      "here is symmetric by construction; text reads backwards on one side."),
    R("canopy_span", "the rest of the span out to the tips (both halves share)", "high", ""),
    R("canopy_tips", "wingtips, the outer ~1.3 m curving down (both share)", "high", ""),
] + COMMON_TAIL

PARAGLIDER_RULES = [
    ("canopy_centre", dict(ax=(None, 0.9))),
    ("canopy_tips", dict(ax=(4.15, None))),
    ("canopy_span", {}),
]

# GeoFS model frames -> the shared frame (x right, y up, z aft). Rows: new x, y, z.
FRAME_XFWD_ZRIGHT = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], float)   # Blender export

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

PREMIUM = GEOFS + "/models/aircraft/premium/"
_NEW = dict(paint_last=True, occlude=r".", shared=[("fin", "fin_l", "fin_r"),
                                                   ("fuselage_both", "fuselage_l", "fuselage_r"),
                                                   ("wing_both", "wing_top_l", "wing_top_r")])
AIRCRAFT.update({
    "b737": dict(
        _NEW, size=4096, files=["737.gltf", "737_2.bin", "texture_0.jpg"], cabin=True,
        url=PREMIUM + "737_700/", parts=["737.gltf"], texture="texture_0", stock="texture_0.jpg",
        regions=AIRLINER_REGIONS, rules=B737_RULES, geofs_id="4", ls_key="737_700",
        slot=3, slot_source="LiverySelector 737_700: parts [0,0,0] index [0,2,3], label Texture "
                            "= slot 2 -> texture index 3",
        source="GeoFS premium Boeing 737-700 (id 4) models/aircraft/premium/737_700/737.gltf, "
               "materials _37Material* (texture_0.jpg)"),
    "b737max": dict(
        _NEW, size=2048, files=["sg73m8.glb"], cabin=True,
        url=GEOFS + "/backend/aircraft/repository/SpiceJet%20737-900_427352_2772/",
        parts=["sg73m8.glb"], texture="sg", stock="embedded:sg", frame=FRAME_XFWD_ZRIGHT,
        # no visibility pass: the title bands are overlay faces just above the skin, which
        # would mark the skin under and around them 'interior'; the cockpit and cabin use
        # other textures on this model
        occlude=None,
        regions=AIRLINER_REGIONS, rules=B737MAX_RULES, geofs_id="2772", ls_key=None,
        slot=None, slot_source="no LiverySelector entry: resolved from the model file, the glTF "
                               "texture that samples image 'sg' (the SpiceJet livery sheet). "
                               "UNVERIFIED IN-SIM.",
        native="1572 x 982 PNG embedded in the .glb; written square (2048) because UVs are "
               "normalised and every factory tool works on square textures",
        source="GeoFS community Boeing 737 Max 8 (SpiceJet), id 2772, "
               "backend/aircraft/repository/SpiceJet 737-900_427352_2772/sg73m8.glb (glTF 2.0), "
               "image 'sg' (fuselage sides and fin). The wings, engines and lower body sample a "
               "second sheet ('tex_6sg') that one texture slot can't reach, so they stay stock."),
    "c172": dict(
        _NEW, size=2048, files=["cessna172.gltf", "cessna172.bin", "texture_0.jpg"],
        url=PREMIUM + "cessna_172/", parts=["cessna172.gltf"], texture="texture_0",
        stock="texture_0.jpg", regions=GA_REGIONS, rules=C172_RULES, geofs_id="2",
        ls_key="cessna_172", slot=1, slot_source="probe round 4: parts [0] -> index [1]",
        source="GeoFS premium Cessna 172 (id 2) models/aircraft/premium/cessna_172/"
               "cessna172.gltf, material exteriorMaterial (texture_0.jpg)"),
    "c172retro": dict(
        _NEW, size=2048, files=["retro.gltf", "retro.bin", "texture.png"],
        url=GEOFS + "/models/aircraft/retro/c172/", parts=["retro.gltf"], texture="texture.png",
        stock="texture.png", regions=GA_REGIONS, rules=C172RETRO_RULES, geofs_id="2000",
        ls_key=None, slot=0, slot_source="the model's only texture (texture.png); no "
                                         "LiverySelector entry. UNVERIFIED IN-SIM.",
        source="GeoFS Retro 172 (id 2000) models/aircraft/retro/c172/retro.gltf, material "
               "Cessna172 (texture.png)"),
    "cub": dict(
        _NEW, size=1024, files=["cub.gltf", "cub.bin", "texture_0.jpg"],
        url=PREMIUM + "cub/", parts=["cub.gltf"], texture="texture_0", stock="texture_0.jpg",
        regions=GA_REGIONS, rules=CUB_RULES, geofs_id="1", ls_key="cub",
        slot=3, slot_source="probe round 4: parts [0] -> index [3]",
        source="GeoFS premium Piper J3 Cub (id 1) models/aircraft/premium/cub/cub.gltf, "
               "material 'texture' (texture_0.jpg)"),
    "paraglider": dict(
        _NEW, size=1024, files=["canopy.glb", "texture.jpg"],
        url=GEOFS + "/models/aircraft/paraglider/", parts=["canopy.glb"], texture="texture.jpg",
        stock="texture.jpg", regions=PARAGLIDER_REGIONS, rules=PARAGLIDER_RULES, occlude=None,
        geofs_id="50", ls_key="paraglider", slot=0,
        slot_source="LiverySelector paraglider: parts [0] index [0]",
        source="GeoFS Paraglider (id 50) models/aircraft/paraglider/canopy.glb (glTF 1 binary), "
               "material ID5 (texture.jpg). The pilot is a separate model and isn't painted."),
    "su35": dict(
        _NEW, size=4096, files=["su35.gltf", "su35.bin", "texture_0.jpg"],
        url=PREMIUM + "su35/", parts=["su35.gltf"], texture="texture_0", stock="texture_0.jpg",
        regions=SU35_REGIONS, rules=SU35_RULES, geofs_id="18", ls_key="su35",
        slot=8, slot_source="probe round 4: parts [0] -> index [8]",
        source="GeoFS premium Sukhoi Su-35 (id 18) models/aircraft/premium/su35/su35.gltf, "
               "materials Main-Page and Chrome_Vray (both texture_0.jpg)"),
    "beaver": dict(
        _NEW, size=4096, files=["dhc2.gltf", "dhc2.bin", "texture_0.jpg"],
        url=PREMIUM + "dhc2/", parts=["dhc2.gltf"], texture="texture_0", stock="texture_0.jpg",
        regions=GA_REGIONS, rules=BEAVER_RULES, geofs_id="13", ls_key="dhc2",
        slot=4, slot_source="LiverySelector dhc2: parts [0] index [4]",
        source="GeoFS premium DHC-2 Beaver (id 13) models/aircraft/premium/dhc2/dhc2.gltf, "
               "material 'texture' (texture_0.jpg)"),
})


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
    frame = spec.get("frame")
    for f in spec["parts"] or [f for f in spec["files"] if f.endswith((".glb", ".gltf"))]:
        g, prims = load_model(d / f)
        for p in prims:
            p["pos"] = p["pos"] + offsets.get(f, 0.0)
            if frame is not None:
                p["pos"] = p["pos"] @ frame.T
        if "texture" in spec:
            tex_mats = {k for k, im in material_images(g).items() if spec["texture"] in im}
            SLOTS[ac] = texture_slot(g, spec["texture"])
        else:
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
            # degenerate faces whose UVs span most of the sheet (stray tiling) would smear one
            # label over every island; no real face of these models is that big
            wide = (np.ptp(uv, 1) > 0.75).any(1) if "rules" in spec else np.zeros(len(uv), bool)
            a3 = np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
            e = uv[:, 1:] - uv[:, :1]
            a2 = np.abs(e[:, 0, 0] * e[:, 1, 1] - e[:, 0, 1] * e[:, 1, 0])
            dens = a2 / np.maximum(a3, 1e-9)
            for i in range(len(uv)):
                if wide[i]:
                    continue
                if "rules" in spec:
                    lab = classify_rules(spec["rules"], p["node"], C[i], N[i])
                elif ac == "f16":
                    lab = classify_f16(p["node"], C[i], N[i])
                else:
                    lab = classify_b757(p["node"], C[i], N[i], part)
                out.append([lab, uv[i], P[i], p["node"], dens[i], a2[i]])
    if "rules" in spec:
        # a tiny face stretched over a large part of the sheet (a 0.4 m flap fairing mapped
        # across 20 texture widths) would smear one label everywhere: drop faces whose sheet
        # area per m2 is far beyond the model's norm (only ones big enough on the sheet to matter)
        med = np.median([t[4] for t in out if t[5] > 0])
        out = [t for t in out if not (t[4] > 60 * med and t[5] > 1e-3)]
    occ = "body" if ac == "f16" else spec.get("occlude")
    if occ:
        # Faces nobody can see from outside (cockpit tub and panels behind the canopy, cabin
        # walls, intake ducts, bays) are interior, not skin. Glass counts as opaque here.
        allP = np.concatenate(occluders)
        seen = visible_from_outside(allP)
        # map textured triangles back to their index in allP by identity of coordinates
        key = {tri.tobytes(): i for i, tri in enumerate(allP)}
        keep = {"mechanical", "pilot"}
        for t in out:
            hit = t[3] == occ if ac == "f16" else re.search(occ, t[3] or "") is not None
            if hit and t[0] not in keep and not seen[key[t[2].tobytes()]]:
                t[0] = "interior"
    return [tuple(t[:3]) for t in out]


SLOTS = {}   # ac -> glTF 2 texture index of the livery image (filled by triangles())


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


LS_INDEX = "https://raw.githubusercontent.com/kolos26/GEOFS-LiverySelector/main/livery.json"


def stock_image(ac, d: Path) -> Image.Image:
    """The stock texture in the livery slot (from the cache: never committed)."""
    spec = AIRCRAFT[ac]
    src = spec["stock"]
    if src.startswith("embedded:"):
        raw = (d / spec["parts"][0]).read_bytes()
        off, chunks = 12, []
        while off < len(raw):
            ln, typ = struct.unpack("<II", raw[off:off + 8])
            chunks.append((typ, raw[off + 8:off + 8 + ln]))
            off += 8 + ln
        g = json.loads(chunks[0][1])
        im = next(i for i in g["images"] if i.get("name") == src.split(":", 1)[1])
        bv = g["bufferViews"][im["bufferView"]]
        o = bv.get("byteOffset", 0)
        return Image.open(io.BytesIO(chunks[1][1][o:o + bv["byteLength"]])).convert("RGB")
    return Image.open(d / src).convert("RGB")


def community_liveries(ac, d: Path, offline: bool, n=6):
    """Up to n LiverySelector community liveries for this airframe, cached in
    .cache/<ac>/ls/. [] when LiverySelector has no entry or the network is off."""
    key = AIRCRAFT[ac].get("ls_key")
    if not key:
        return []
    ls = d.parent / "liveryselector.json"
    if not ls.exists():
        if offline:
            return []
        try:
            with urllib.request.urlopen(LS_INDEX, timeout=60) as r:
                ls.write_bytes(r.read())
        except OSError as e:
            print(f"  (no LiverySelector index: {e})")
            return []
    entry = json.loads(ls.read_text(encoding="utf-8"))["aircrafts"].get(key)
    if not entry:
        return []
    labels = entry.get("labels", {})
    slot = labels.get("Texture", labels.get("Main Texture", [0]))[0]
    out = []
    for i, lv in enumerate(entry["liveries"]):
        if len(out) >= n:
            break
        tex = lv.get("texture")
        url = tex[slot] if isinstance(tex, list) and len(tex) > slot else None
        if not isinstance(url, str) or url.startswith("/models/aircraft/"):
            continue                       # the stock texture itself
        dst = d / "ls" / f"{i:03d}{Path(url.split('?')[0]).suffix or '.img'}"
        if not dst.exists():
            if offline:
                continue
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                with urllib.request.urlopen(url.replace(" ", "%20"), timeout=60) as r:
                    dst.write_bytes(r.read())
            except (OSError, ValueError):
                continue
        try:
            out.append((lv.get("name", ""), Image.open(dst).convert("RGB")))
        except OSError:
            continue
    return out


def _runs(b):
    d = np.diff(np.r_[0, b.astype(np.int8), 0])
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def detect_windows(ac, d: Path, reg, names, thr=70):
    """Cabin windows of an airliner side profile, as texel rectangles [x, y, w, h] at the map's
    size: rows of the fuselage islands where the stock sheet is dark across many columns,
    split into dark runs of window size and shape. Only these numbers are kept (the factory
    draws plain windows there); no stock pixels are."""
    S = reg.shape[0]
    k = S / 4096
    gray = np.asarray(stock_image(ac, d).convert("L").resize((S, S), Image.BILINEAR), np.float32)
    out = []
    for i, n in enumerate(names, 1):
        if not n.startswith("fuselage_") or n in ("fuselage_top", "fuselage_bottom"):
            continue
        dark = (gray < thr) & (reg == i)
        rc = dark.sum(1)
        if rc.max() < 30 * k:
            continue
        for y0, y1 in _runs(rc > max(0.3 * rc.max(), 30 * k)):
            if not 6 * k <= y1 - y0 <= 140 * k:
                continue
            for x0, x1 in _runs(dark[y0:y1].mean(0) > 0.45):
                if 5 * k <= x1 - x0 <= 220 * k and 0.6 <= (x1 - x0) / (y1 - y0) <= 1.8:
                    out.append([int(x0), int(y0), int(x1 - x0), int(y1 - y0)])
    return out


def cross_check_ladder(ac, d: Path, reg, regions, offline):
    """No Finsonly liveries exist for these airframes, so the map is checked against
    (a) LiverySelector community liveries: % of each region's texels they repaint (differ
    from stock), the same idea as cross_check; and (b) the stock texture: % of each region's
    texels that aren't the sheet's empty background colour."""
    S = reg.shape[0]
    stock = np.asarray(stock_image(ac, d).resize((S, S), Image.BILINEAR), np.int16)
    q = (stock[reg == 0] // 16).reshape(-1, 3)
    if len(q):
        vals, cnt = np.unique(q, axis=0, return_counts=True)
        bg = vals[cnt.argmax()] * 16 + 8
    else:
        bg = np.array([0, 0, 0])
    used = np.abs(stock - bg).max(2) > 24
    comm = community_liveries(ac, d, offline)
    painted = np.zeros(reg.shape, bool)
    for _, im in comm:
        a = np.asarray(im.resize((S, S), Image.BILINEAR), np.int16)
        painted |= np.abs(a - stock).max(2) >= 24
    out_used, out_painted = {}, {}
    for r in regions:
        m = reg == r["id"]
        k = max(int(m.sum()), 1)
        out_used[r["name"]] = round(100.0 * (used & m).sum() / k, 1)
        if comm:
            out_painted[r["name"]] = round(100.0 * (painted & m).sum() / k, 1)
    res = dict(stock_used_pct_by_region=out_used,
               stock_note="% of texels where the stock texture isn't its background colour")
    if comm:
        res.update(liveries=[f"LiverySelector: {n}" for n, _ in comm],
                   painted_pct_by_region=out_painted)
    else:
        res["liveries"] = []
        res["note"] = "No LiverySelector entry for this airframe: stock texture check only."
    return res


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
    no_paint = {"pilot", "mechanical", "interior"}
    if spec.get("paint_last"):
        # later triangles win the geometry map: wheels and struts that sample the whole sheet
        # mustn't overwrite where the skin really is
        tris.sort(key=lambda t: t[0] not in no_paint)
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
    for both_n, l_n, r_n in spec.get("shared", []):
        # texels a left and a right part both use -> the shared region
        if not {both_n, l_n, r_n} <= ids.keys():
            continue
        L, R, B = (np.uint64(1) << np.uint64(ids[k]) for k in (l_n, r_n, both_n))
        both = ((bits & L) != 0) & ((bits & R) != 0)
        bits[both] = (bits[both] & ~(L | R)) | B
    # anything paintable beats 'mechanical'/'pilot'/'doors' on shared seams
    prio = {ids[n]: (90 if n in ("mechanical", "pilot", "doors", "interior") else 10) for n in names}
    reg = resolve(bits, len(names), prio)
    reg[~cov] = 0
    region_defs = spec["regions"]
    if "rules" in spec:
        # drop regions this airframe doesn't have (a Cub has no floats) and renumber
        present = [i for i in range(1, len(names) + 1) if (reg == i).any()]
        lut = np.zeros(256, np.uint8)
        lut[present] = np.arange(1, len(present) + 1)
        reg = lut[reg]
        region_defs = [spec["regions"][i - 1] for i in present]
        names = [r[0] for r in region_defs]

    UV_DIR.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(reg)
    pal = palette(len(names))
    im.putpalette([c for rgb in pal for c in rgb] + [0] * (768 - 3 * len(pal)))
    im.save(UV_DIR / f"{ac}_regions.png", optimize=True)
    g8 = np.zeros((size, size, 4), np.uint8)
    g8[..., :3] = np.round(geom * 255)
    g8[..., 3] = cov * 255
    Image.fromarray(g8).save(UV_DIR / f"{ac}_geom.png", optimize=True)

    regions = []
    for i, (name, where, conf, notes) in enumerate(region_defs, 1):
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
                      underlay=SHIPPED["f16"],
                      underlay_note="Non-paint regions (pilot, mechanical, interior) keep the "
                                    "per-texel median of these shipped liveries: the stock "
                                    "cockpit panels, gear and pilot wherever most of them agree.")
    elif ac == "b757":
        build_b757_cabin()
        extras = dict(cabin_png="liveries/uv/b757_cabin.png",
                      cabin_note="Windows and door outlines, from b757-200_uv_test.png.")
    else:
        slot = spec["slot"] if spec["slot"] is not None else SLOTS.get(ac)
        extras = dict(
            geofs_id=spec["geofs_id"], liveryselector_key=spec["ls_key"], texture_slot=slot,
            texture_slot_source=spec["slot_source"],
            neutral={"mechanical": "#3a3d42", "interior": "#16171a", "pilot": "#3a3d42"},
            neutral_note="No Finsonly liveries exist for this airframe, so nothing is known "
                         "about its stock cockpit / gear pixels: non-paint regions get flat "
                         "neutral colours (nothing from GeoFS is committed).")
        if "native" in spec:
            extras["native_note"] = spec["native"]
        if spec.get("cabin"):
            extras["cabin"] = dict(
                windows=detect_windows(ac, d, reg, names),
                note="Window rectangles [x, y, w, h] in texels, found in the stock sheet's "
                     "window rows by tools/uv_regions.py detect_windows. The factory paints "
                     "plain windows there (finish.cabin, finish.window_color). Doors aren't "
                     "detected; nothing from the stock sheet is copied.")
    meta = dict(
        aircraft=ac, texture_size=[size, size],
        regions_png=f"liveries/uv/{ac}_regions.png", geom_png=f"liveries/uv/{ac}_geom.png",
        **extras,
        source=spec["source"],
        method="Every textured triangle of the model rasterized into UV space and labelled from "
               "its part name, 3D position and facing (tools/uv_regions.py). UV v runs down the "
               "image (row = v * height), verified against the helmet/pilot island."
               + (" Labels come from the rule table in uv_regions.py (first match wins); faces "
                  "the 26-direction visibility pass never sees are 'interior'."
                  if "rules" in spec else ""),
        geom_axes=dict(R="lateral: 0 = left wingtip .. 255 = right wingtip",
                       G="height: 0 = lowest point .. 255 = top of the fin",
                       B="length: 0 = nose tip .. 255 = tail", A="255 = painted surface",
                       bounds_m=dict(lo=[round(v, 3) for v in lo], hi=[round(v, 3) for v in hi])),
        in_sim="UNVERIFIED IN-SIM: derived from the model files, not yet checked with the "
               "region-ID sheet in GeoFS.",
        cross_check=(cross_check_ladder(ac, d, reg, regions, offline) if "rules" in spec
                     else cross_check(ac, reg, regions)),
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
