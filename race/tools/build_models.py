#!/usr/bin/env python3
"""Generate FINSONLY Racing joke-plane glTF binary (.glb) models.

Pure procedural geometry (boxes, cylinders/cones, UV ellipsoids) with per-vertex
colors — no textures, no third-party meshes, no brand logos. Every model is
authored nose-first along +X, up along +Y (standard glTF Y-up convention), then
uniformly scaled so its longest (+X) extent is ~15 m to match the stock F-16.

Cesium converts glTF's Y-up to its own Z-up frame on load and treats a model's
local +X as "forward" after that conversion. If a model appears to fly
sideways/backwards once swapped in-game, that's a Cesium/GeoFS convention detail
to fix with the `offset` heading/pitch/roll degrees in index.json, not a reason
to re-author the mesh. See race/README.md's "Model swaps" section.

Usage: python build_models.py [output_dir]   (default: ../models next to this file)
"""
import json
import math
import os
import sys

import numpy as np
from pygltflib import (
    GLTF2, Scene, Node, Mesh, Primitive, Attributes, Buffer, BufferView,
    Accessor, Material, PbrMetallicRoughness, Asset,
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, UNSIGNED_INT, VEC3, VEC4, SCALAR, TRIANGLES,
)

TARGET_LENGTH_M = 15.0
SIZE_CAP_BYTES = 300 * 1024


# --------------------------------------------------------------- geometry
class MeshBuilder:
    """Flat-shaded triangle soup: every triangle gets its own 3 verts + face normal."""

    def __init__(self):
        self.positions = []
        self.normals = []
        self.colors = []
        self.indices = []

    def add_tri(self, p0, p1, p2, color):
        e1 = np.subtract(p1, p0)
        e2 = np.subtract(p2, p0)
        n = np.cross(e1, e2)
        length = np.linalg.norm(n)
        if length < 1e-9:
            return  # degenerate (e.g. sphere pole collapse) — skip, not an error
        n = (n / length).tolist()
        base = len(self.positions)
        for p in (p0, p1, p2):
            self.positions.append(tuple(float(v) for v in p))
            self.normals.append(tuple(n))
            self.colors.append(color)
        self.indices.extend([base, base + 1, base + 2])

    def add_quad(self, p0, p1, p2, p3, color):
        self.add_tri(p0, p1, p2, color)
        self.add_tri(p0, p2, p3, color)

    def bounds(self):
        arr = np.array(self.positions)
        return arr.min(axis=0), arr.max(axis=0)

    def scale_to_length(self, target=TARGET_LENGTH_M, axis=0):
        lo, hi = self.bounds()
        extent = hi[axis] - lo[axis]
        if extent < 1e-9:
            return
        factor = target / extent
        self.positions = [tuple(v * factor for v in p) for p in self.positions]


def box(m, center, size, color):
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    c = {}
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                c[(sx, sy, sz)] = (cx + sx * hx, cy + sy * hy, cz + sz * hz)
    faces = [
        ((1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)),
        ((-1, 1, -1), (-1, -1, -1), (-1, -1, 1), (-1, 1, 1)),
        ((-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)),
        ((-1, -1, 1), (-1, -1, -1), (1, -1, -1), (1, -1, 1)),
        ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)),
        ((1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)),
    ]
    for f in faces:
        pts = [c[v] for v in f]
        m.add_quad(pts[0], pts[1], pts[2], pts[3], color)


def cylinder(m, p0, p1, r0, r1, color, segments=12, cap0=True, cap1=True):
    """Cone/cylinder frustum between two points (r0 at p0, r1 at p1)."""
    p0 = np.array(p0, dtype=float)
    p1 = np.array(p1, dtype=float)
    axis = p1 - p0
    length = np.linalg.norm(axis)
    if length < 1e-9:
        return
    axis /= length
    tmp = np.array([0.0, 1.0, 0.0]) if abs(axis[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(axis, tmp)
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    ring0, ring1 = [], []
    for i in range(segments):
        theta = 2 * math.pi * i / segments
        d = u * math.cos(theta) + v * math.sin(theta)
        ring0.append(p0 + d * r0)
        ring1.append(p1 + d * r1)
    for i in range(segments):
        j = (i + 1) % segments
        m.add_quad(ring0[i], ring0[j], ring1[j], ring1[i], color)
    if cap0 and r0 > 1e-6:
        for i in range(segments):
            j = (i + 1) % segments
            m.add_tri(p0, ring0[j], ring0[i], color)
    if cap1 and r1 > 1e-6:
        for i in range(segments):
            j = (i + 1) % segments
            m.add_tri(p1, ring1[i], ring1[j], color)


def ellipsoid(m, center, radii, color, lat_seg=8, lon_seg=10):
    cx, cy, cz = center
    rx, ry, rz = radii

    def vert(lat, lon):
        x = math.cos(lat) * math.cos(lon)
        y = math.sin(lat)
        z = math.cos(lat) * math.sin(lon)
        return (cx + x * rx, cy + y * ry, cz + z * rz)

    rings = []
    for i in range(lat_seg + 1):
        lat = -math.pi / 2 + math.pi * i / lat_seg
        rings.append([vert(lat, 2 * math.pi * j / lon_seg) for j in range(lon_seg)])
    for i in range(lat_seg):
        for j in range(lon_seg):
            j2 = (j + 1) % lon_seg
            m.add_quad(rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j], color)


# ------------------------------------------------------------------ models
def build_goldfish():
    m = MeshBuilder()
    orange = (0.95, 0.55, 0.10, 1.0)
    dark_orange = (0.78, 0.38, 0.05, 1.0)
    black = (0.05, 0.05, 0.05, 1.0)
    ellipsoid(m, (0, 0, 0), (6.0, 2.2, 1.8), orange, lat_seg=8, lon_seg=12)
    box(m, (-7.5, 0, 0), (3.0, 5.0, 0.25), dark_orange)          # tail fin
    box(m, (0, 3.0, 0), (3.0, 1.6, 0.2), dark_orange)            # dorsal fin
    for sz in (1, -1):
        box(m, (2.0, -0.4, sz * 2.2), (1.6, 0.2, 1.0), dark_orange)  # pectoral fins
        ellipsoid(m, (5.0, 0.5, sz * 1.3), (0.4, 0.4, 0.4), black, lat_seg=4, lon_seg=6)  # eyes
    box(m, (6.2, 0, 0), (0.6, 0.3, 0.6), dark_orange)            # mouth
    m.scale_to_length()
    return m


def build_bratwurst():
    m = MeshBuilder()
    tan = (0.72, 0.50, 0.32, 1.0)
    dark = (0.35, 0.20, 0.10, 1.0)
    cylinder(m, (-5, 0, 0), (5, 0, 0), 2.2, 2.2, tan, segments=14, cap0=False, cap1=False)
    ellipsoid(m, (-5, 0, 0), (2.2, 2.2, 2.2), tan, lat_seg=6, lon_seg=14)
    ellipsoid(m, (5, 0, 0), (2.2, 2.2, 2.2), tan, lat_seg=6, lon_seg=14)
    for x in (-2, 0, 2):
        cylinder(m, (x - 0.15, 0, 0), (x + 0.15, 0, 0), 2.3, 2.3, dark, segments=14, cap0=False, cap1=False)
    m.scale_to_length()
    return m


def build_traffic_cone():
    m = MeshBuilder()
    orange = (1.0, 0.42, 0.10, 1.0)
    white = (0.95, 0.95, 0.95, 1.0)
    darkgray = (0.15, 0.15, 0.15, 1.0)
    x0, x1 = -6.0, 6.0
    r0, r1 = 3.0, 0.15

    def radius_at(x):
        t = (x - x0) / (x1 - x0)
        return r0 + (r1 - r0) * t

    cylinder(m, (x0, 0, 0), (x1, 0, 0), r0, r1, orange, segments=14, cap0=True, cap1=False)
    for x in (-2.0, 2.0):
        r = radius_at(x) + 0.08
        cylinder(m, (x - 0.15, 0, 0), (x + 0.15, 0, 0), r, r, white, segments=14, cap0=False, cap1=False)
    box(m, (x0 - 0.3, 0, 0), (0.6, 6.2, 6.2), darkgray)
    m.scale_to_length()
    return m


def build_toilet():
    m = MeshBuilder()
    white = (0.95, 0.95, 0.95, 1.0)
    black = (0.08, 0.08, 0.08, 1.0)
    chrome = (0.7, 0.7, 0.75, 1.0)
    cylinder(m, (-1, -3, 0), (-1, 1, 0), 2.0, 1.6, white, segments=12, cap0=True, cap1=False)  # pedestal
    ellipsoid(m, (1.5, 1.2, 0), (3.0, 1.6, 2.2), white, lat_seg=8, lon_seg=12)                  # bowl
    ellipsoid(m, (1.5, 2.6, 0), (3.2, 0.4, 2.4), black, lat_seg=6, lon_seg=12)                  # seat/lid
    box(m, (-3.5, 3.0, 0), (2.4, 3.4, 3.0), white)                                              # tank (tail fin)
    box(m, (-3.5, 2.0, 1.6), (0.2, 0.4, 0.6), chrome)                                           # flush handle
    m.scale_to_length()
    return m


def build_parcel_box():
    m = MeshBuilder()
    cardboard = (0.72, 0.55, 0.35, 1.0)
    tape = (0.85, 0.78, 0.60, 1.0)
    box(m, (0, 0, 0), (10.0, 6.0, 6.0), cardboard)
    box(m, (0, 3.05, 0), (10.2, 0.5, 6.2), tape)   # lengthwise tape strip (top)
    box(m, (0, 0, 0), (2.0, 6.4, 6.4), tape)       # wrap-around tape band (FINSONLY tape, plain — no logo)
    m.scale_to_length()
    return m


def build_cow():
    m = MeshBuilder()
    white = (0.92, 0.92, 0.90, 1.0)
    black = (0.05, 0.05, 0.05, 1.0)
    pink = (0.90, 0.60, 0.65, 1.0)
    horn = (0.85, 0.80, 0.70, 1.0)
    ellipsoid(m, (-1, 0, 0), (5.0, 2.6, 2.4), white, lat_seg=8, lon_seg=12)
    ellipsoid(m, (-2.5, 1.5, 1.4), (1.6, 1.2, 1.0), black, lat_seg=6, lon_seg=8)
    ellipsoid(m, (0.5, -0.8, -1.7), (1.4, 1.1, 0.9), black, lat_seg=6, lon_seg=8)
    ellipsoid(m, (5.5, 0.3, 0), (1.8, 1.5, 1.4), white, lat_seg=6, lon_seg=10)      # head
    ellipsoid(m, (7.0, -0.2, 0), (0.9, 0.8, 0.9), pink, lat_seg=5, lon_seg=8)       # snout
    for sz in (1, -1):
        ellipsoid(m, (5.0, 1.6, sz * 1.8), (0.5, 0.9, 0.3), white, lat_seg=4, lon_seg=6)   # ears
        cylinder(m, (5.3, 1.6, sz * 1.0), (5.8, 2.6, sz * 1.3), 0.25, 0.02, horn, segments=8)  # horns
    for x, z in ((-3, 1.5), (-3, -1.5), (2, 1.5), (2, -1.5)):
        cylinder(m, (x, -2.2, z), (x, -5.0, z), 0.6, 0.5, white, segments=8, cap0=False, cap1=True)  # legs
        box(m, (x, -5.1, z), (0.7, 0.3, 0.7), black)  # hooves
    cylinder(m, (-6.0, 0.5, 0), (-7.5, -1.5, 0), 0.3, 0.15, white, segments=8, cap0=False)  # tail
    box(m, (-7.6, -1.6, 0), (0.3, 0.3, 0.3), black)  # tail tuft
    m.scale_to_length()
    return m


MODELS = [
    ("goldfish", "Goldfish", build_goldfish),
    ("bratwurst", "Bratwurst", build_bratwurst),
    ("traffic-cone", "Traffic Cone", build_traffic_cone),
    ("toilet", "Toilet", build_toilet),
    ("parcel-box", "Parcel Box", build_parcel_box),
    ("cow", "Cow", build_cow),
]


# -------------------------------------------------------------------- glb
def pad4(b):
    return b + b"\x00" * ((4 - len(b) % 4) % 4)


def write_glb(path, m: MeshBuilder):
    positions = np.array(m.positions, dtype="float32")
    normals = np.array(m.normals, dtype="float32")
    colors = np.array(m.colors, dtype="float32")
    indices = np.array(m.indices, dtype="uint32")

    pos_b, norm_b, color_b, idx_b = (pad4(a.tobytes()) for a in (positions, normals, colors, indices))
    blob = pos_b + norm_b + color_b + idx_b
    offsets = [0, len(pos_b), len(pos_b) + len(norm_b), len(pos_b) + len(norm_b) + len(color_b)]
    raw_lengths = [positions.nbytes, normals.nbytes, colors.nbytes, indices.nbytes]

    gltf = GLTF2()
    gltf.asset = Asset(generator="FINSONLY build_models.py", version="2.0")
    gltf.scenes = [Scene(nodes=[0])]
    gltf.scene = 0
    gltf.nodes = [Node(mesh=0, name=os.path.splitext(os.path.basename(path))[0])]
    gltf.meshes = [Mesh(primitives=[Primitive(
        attributes=Attributes(POSITION=0, NORMAL=1, COLOR_0=2), indices=3, mode=TRIANGLES, material=0)])]
    gltf.materials = [Material(
        pbrMetallicRoughness=PbrMetallicRoughness(baseColorFactor=[1, 1, 1, 1], metallicFactor=0.0, roughnessFactor=1.0),
        doubleSided=True)]
    gltf.buffers = [Buffer(byteLength=len(blob))]
    gltf.bufferViews = [
        BufferView(buffer=0, byteOffset=offsets[0], byteLength=raw_lengths[0], target=ARRAY_BUFFER),
        BufferView(buffer=0, byteOffset=offsets[1], byteLength=raw_lengths[1], target=ARRAY_BUFFER),
        BufferView(buffer=0, byteOffset=offsets[2], byteLength=raw_lengths[2], target=ARRAY_BUFFER),
        BufferView(buffer=0, byteOffset=offsets[3], byteLength=raw_lengths[3], target=ELEMENT_ARRAY_BUFFER),
    ]
    pmin, pmax = positions.min(axis=0).tolist(), positions.max(axis=0).tolist()
    gltf.accessors = [
        Accessor(bufferView=0, componentType=FLOAT, count=len(positions), type=VEC3, min=pmin, max=pmax),
        Accessor(bufferView=1, componentType=FLOAT, count=len(normals), type=VEC3),
        Accessor(bufferView=2, componentType=FLOAT, count=len(colors), type=VEC4),
        Accessor(bufferView=3, componentType=UNSIGNED_INT, count=len(indices), type=SCALAR),
    ]
    gltf.set_binary_blob(blob)
    gltf.save_binary(path)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "models")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    index = []
    for model_id, name, builder in MODELS:
        mesh = builder()
        file_name = model_id + ".glb"
        path = os.path.join(out_dir, file_name)
        write_glb(path, mesh)
        size = os.path.getsize(path)
        status = "OK" if size <= SIZE_CAP_BYTES else "OVER CAP"
        print(f"  {file_name:20s} {size / 1024:7.1f} KB  {len(mesh.indices) // 3:5d} tris  [{status}]")
        if size > SIZE_CAP_BYTES:
            raise SystemExit(f"{file_name} is {size} bytes, over the {SIZE_CAP_BYTES} byte cap")
        index.append({
            "id": model_id,
            "name": name,
            "file": file_name,
            "scale": 1,
            "offset": {"headingDeg": 0, "pitchDeg": 0, "rollDeg": 0},
        })

    index_path = os.path.join(out_dir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
        f.write("\n")
    print(f"Wrote {index_path}")


if __name__ == "__main__":
    main()
