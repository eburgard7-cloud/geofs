#!/usr/bin/env python3
"""Make a recoloured copy of a joke model: same mesh, one material changed.

The joke models (build_models.py) carry their colours per vertex and a single white material, so
the material's baseColorFactor tints the whole model. Gun Game's final-tier toilet is the toilet
with a gold, fully metallic material:

  python recolor_model.py                                   toilet.glb -> toilet-gold.glb (the default)
  python recolor_model.py SRC.glb DST.glb --color 1 0.77 0.2 1 --metallic 1 --roughness 0.25

Stdlib only: it rewrites the GLB's JSON chunk and copies the binary chunk byte for byte.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys

GLB_MAGIC = b"glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
GOLD = (1.0, 0.77, 0.2, 1.0)
GOLD_METALLIC = 1.0
GOLD_ROUGHNESS = 0.25
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models")


def read_glb(data: bytes) -> tuple[dict, bytes | None]:
    """The GLB's glTF JSON and its BIN chunk (None when it has none)."""
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != GLB_MAGIC or version != 2 or length != len(data):
        raise ValueError("not a glTF 2.0 binary")
    off, gltf, blob = 12, None, None
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        body = data[off + 8:off + 8 + clen]
        if ctype == CHUNK_JSON:
            gltf = json.loads(body.decode("utf-8").rstrip(" \x00"))
        elif ctype == CHUNK_BIN and blob is None:
            blob = body
        off += 8 + clen
    if gltf is None:
        raise ValueError("GLB has no JSON chunk")
    return gltf, blob


def write_glb(gltf: dict, blob: bytes | None) -> bytes:
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    chunks = struct.pack("<II", len(js), CHUNK_JSON) + js
    if blob is not None:
        b = blob + b"\x00" * ((4 - len(blob) % 4) % 4)
        chunks += struct.pack("<II", len(b), CHUNK_BIN) + b
    return struct.pack("<4sII", GLB_MAGIC, 2, 12 + len(chunks)) + chunks


def recolor(data: bytes, color=GOLD, metallic=GOLD_METALLIC, roughness=GOLD_ROUGHNESS) -> bytes:
    """Every material's PBR base colour, metallic and roughness set; everything else untouched."""
    gltf, blob = read_glb(data)
    mats = gltf.get("materials") or []
    if not mats:
        raise ValueError("model has no material to recolour")
    for m in mats:
        pbr = m.setdefault("pbrMetallicRoughness", {})
        pbr["baseColorFactor"] = [float(c) for c in color]
        pbr["metallicFactor"] = float(metallic)
        pbr["roughnessFactor"] = float(roughness)
    gltf.setdefault("asset", {})["generator"] = "FINSONLY recolor_model.py"
    return write_glb(gltf, blob)


def recolor_file(src: str, dst: str, **kw) -> int:
    with open(src, "rb") as f:
        out = recolor(f.read(), **kw)
    with open(dst, "wb") as f:
        f.write(out)
    return len(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", nargs="?", default=os.path.join(MODELS_DIR, "toilet.glb"))
    ap.add_argument("dst", nargs="?", default=os.path.join(MODELS_DIR, "toilet-gold.glb"))
    ap.add_argument("--color", nargs=4, type=float, default=list(GOLD), metavar=("R", "G", "B", "A"))
    ap.add_argument("--metallic", type=float, default=GOLD_METALLIC)
    ap.add_argument("--roughness", type=float, default=GOLD_ROUGHNESS)
    a = ap.parse_args(argv)
    n = recolor_file(a.src, a.dst, color=a.color, metallic=a.metallic, roughness=a.roughness)
    print(f"Wrote {a.dst} ({n} bytes)")


if __name__ == "__main__":
    sys.exit(main())
